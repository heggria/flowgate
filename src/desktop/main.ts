import { DiagnosticTrace } from "../../packages/shell/src/diagnostic-trace";
import { cleanupStages } from "../../packages/shell/src/cleanup";
import { deepLinkRoute } from "../../packages/shell/src/deep-link";
import { CredentialVault } from "../../packages/shell/src/credential-vault";
import { UpdateTrace } from "../../packages/shell/src/update-trace";
import { randomUUID } from "node:crypto";
import { supervisedVerification } from "../../packages/release/src/verification";
import { DraftStore } from "../../packages/shell/src/drafts";
import { app, ipcMain, powerMonitor, safeStorage } from "electron";
import { join } from "node:path";
import { mkdir, readFile, unlink } from "node:fs/promises";
import { ProcessSupervisor } from "../../packages/shell/src/supervisor";
import { NativeSession } from "../../packages/shell/src/native-session";
import { DesktopShell } from "../../packages/shell/src/desktop-shell";
import { UpdateCoordinator } from "../../packages/shell/src/update-coordinator";
import { ApplicationUpdate } from "../../packages/shell/src/application-update";
import { ReleaseManager } from "../../packages/release/src/manager";
import type { ReleaseSet } from "../../packages/contracts/src/index";
let shell: DesktopShell,
  service: ProcessSupervisor | undefined,
  extension: ProcessSupervisor | undefined,
  native: NativeSession,
  releases: ReleaseManager;
const drafts = new DraftStore();
let diagnostics: DiagnosticTrace;
let vault: CredentialVault;
let gateway: ProcessSupervisor | undefined;
let gatewayEnabled = false;
const internalGatewayAvailable = process.env.FLOWGATE_INTERNAL_TEST === "1";
const internalUpstream = internalGatewayAvailable
  ? process.env.FLOWGATE_INTERNAL_UPSTREAM
  : undefined;
const gatewayToken = process.env.FLOWGATE_MODEL_TOKEN ?? randomUUID();
async function startGateway(directory: string, manifest?: ReleaseSet) {
  if (!internalGatewayAvailable || !gatewayEnabled) return;
  if (manifest && !manifest.files["gateway.cjs"])
    throw new Error("版本缺少已启用的内部服务");
  const host = new ProcessSupervisor(
    "Gateway",
    join(directory, "gateway.cjs"),
    {
      FLOWGATE_MODEL_TOKEN: gatewayToken,
      FLOWGATE_RELEASE: manifest?.id ?? "bundled",
      ...(internalUpstream
        ? { FLOWGATE_INTERNAL_UPSTREAM: internalUpstream }
        : {}),
    },
  );
  host.onCapability = async (method, payload: any) => {
    if (
      method === "egress.resolve" &&
      payload?.id === "flowgate.policy" &&
      internalUpstream
    ) {
      if (suspended || !service) throw new Error("业务出口尚未就绪");
      return service.call("egress.resolve", { target: internalUpstream });
    }
    if (
      method !== "credential.resolve" ||
      payload?.reference !== "provider.mock"
    )
      throw new Error("Credential scope denied");
    return vault.resolve(payload.reference, new Set(["provider.mock"]));
  };
  gateway = host;
  host.onFault = () => hostFault(host, () => gateway === host);
  try {
    await host.start();
  } catch (error) {
    await host.stop(false);
    gateway = undefined;
    throw error;
  }
}
let updating = false,
  suspended = false,
  quitting = false,
  recoveryMessage = "业务服务尚未启动";
let currentDirectory = join(__dirname, "release"),
  currentManifest: ReleaseSet | undefined;
let faultQueue = Promise.resolve();
function hostFault(host: ProcessSupervisor, isCurrent: () => boolean) {
  faultQueue = faultQueue
    .then(async () => {
      if (!isCurrent() || updating || quitting || suspended) return;
      try {
        if (
          currentManifest &&
          (await releases.recordRuntimeFault(currentManifest.id))
        ) {
          await rollbackRuntime(currentManifest.id);
          return;
        }
        if (!host.canRestart()) throw new Error("宿主连续异常，已停止自动重启");
        if (host.name === "Service")
          await clearDeadWriter(
            join(app.getPath("userData"), "business/writer.lock"),
          );
        await host.start();
        if (host.name === "Extensions")
          await service?.call("extensions.reconcile");
        await publish();
      } catch (error) {
        if (host.name === "Extensions") {
          // Keep management available after a bundled host exhausts its budget.
          // A downloaded release was already quarantined above when appropriate.
          await publish().catch(() => {});
        } else recover(error);
      }
    })
    .catch(recover);
}
async function rollbackRuntime(id: string) {
  if (updating || quitting) return;
  updating = true;
  try {
    const fallback = await releases.quarantineRuntime(id);
    await stopHosts();
    currentDirectory = fallback?.directory ?? join(__dirname, "release");
    currentManifest = fallback?.manifest;
    await startHosts(currentDirectory, currentManifest);
    await shell.reload(
      join(currentDirectory, currentManifest?.ui ?? "index.html"),
    );
    await publish();
  } finally {
    updating = false;
  }
}
app.setName("FlowGate");
// Tray/service lifetime is independent of window replacement during recovery.
app.on("window-all-closed", () => {});
if (process.env.FLOWGATE_TEST_DATA)
  app.setPath("userData", process.env.FLOWGATE_TEST_DATA);
async function clearDeadWriter(path: string) {
  try {
    const original = await readFile(path, "utf8");
    const lock = JSON.parse(original);
    if (!Number.isInteger(lock.pid) || lock.pid < 1)
      throw new Error("Invalid writer lock");
    // UtilityProcess exit can precede OS process reaping. Keep the writer fence
    // until that exact PID is gone; never treat the exit event alone as proof.
    const deadline = Date.now() + 3000;
    for (;;) {
      try {
        process.kill(lock.pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        if ((await readFile(path, "utf8")) !== original)
          throw new Error("Writer lock changed during recovery");
        await unlink(path);
        return;
      }
      if (Date.now() >= deadline)
        throw new Error("Business writer is still running");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function recover(error: unknown) {
  recoveryMessage = error instanceof Error ? error.message : String(error);
  shell.recovery();
}
async function publish() {
  if (service) shell.publish(await service.call("snapshot"));
}
function attachCapabilities(host: ProcessSupervisor, readonly = false) {
  host.onCapability = async (method, payload: any, signal) => {
    if (method === "native.status") return native.status();
    if (method === "native.control") return native.control();
    if (readonly) throw new Error("预检禁止写入和扩展操作");
    if (method === "native.apply")
      return native.apply(
        payload.config,
        payload.revision,
        payload.operationId,
        payload.mode,
      );
    if (method === "native.stop") return native.stop(payload.operationId);
    if (
      method === "extension.call" &&
      payload?.method === "extensions.restart"
    ) {
      const host = extension;
      if (!host) throw new Error("扩展宿主不可用");
      await host.stop(false);
      host.resetRestartBudget();
      await host.start();
      return host.call("extensions.configure", payload.payload);
    }
    if (
      method === "extension.call" &&
      [
        "health",
        "extensions.configure",
        "network.inspect",
        "subscription.parse",
        "ruleset.parse",
        "subscription.fetch",
      ].includes(payload?.method)
    )
      return extension?.call(
        payload.method,
        payload.payload,
        undefined,
        signal,
      );
    throw new Error("Capability denied");
  };
}
async function startHosts(directory: string, manifest?: ReleaseSet) {
  const business = join(app.getPath("userData"), "business");
  extension = new ProcessSupervisor(
    "Extensions",
    join(directory, manifest?.extension ?? "extension.cjs"),
    {
      FLOWGATE_RELEASE: manifest?.id ?? "bundled",
      FLOWGATE_HOST_VERSION:
        manifest?.components?.extension ?? app.getVersion(),
      FLOWGATE_EXPECTED_EXTENSIONS:
        manifest?.catalogVersion === 1 ? JSON.stringify(manifest.builtins) : "",
    },
  );
  await extension.start();
  service = new ProcessSupervisor(
    "Service",
    join(directory, manifest?.service ?? "service.cjs"),
    {
      FLOWGATE_DATA: business,
      FLOWGATE_RELEASE: manifest?.id ?? "bundled",
      FLOWGATE_HOST_VERSION: manifest?.components?.service ?? app.getVersion(),
      FLOWGATE_EXPECTED_SERVICE_MODULES:
        manifest?.catalogVersion === 1 ? JSON.stringify(manifest.builtins) : "",
    },
  );
  attachCapabilities(service);
  service.onSnapshot = (snapshot) => shell.publish(snapshot);
  const serviceHost = service,
    extensionHost = extension;
  service.onFault = () => hostFault(serviceHost, () => service === serviceHost);
  extension.onFault = () =>
    hostFault(extensionHost, () => extension === extensionHost);
  await clearDeadWriter(join(business, "writer.lock"));
  try {
    await service.start();
    await startGateway(directory, manifest);
  } catch (error) {
    await service.stop(false);
    await extension.stop(false);
    throw error;
  }
}
async function stopHosts() {
  const hosts = [gateway, service, extension];
  gateway = undefined;
  service = undefined;
  extension = undefined;
  const errors: unknown[] = [];
  for (const host of hosts) {
    try {
      await host?.stop();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw errors[0];
}

let pendingNavigation: string | undefined;
function navigateLink(input: string) {
  const route = deepLinkRoute(input);
  if (!route) return;
  pendingNavigation = route;
  if (shell) {
    shell.open();
    shell.window?.webContents.send("shell:navigate", route);
  }
}
app.on("open-url", (event, url) => {
  event.preventDefault();
  navigateLink(url);
});
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", (_event, argv) => {
    shell?.open();
    for (const value of argv) if (deepLinkRoute(value)) navigateLink(value);
  });
  app
    .whenReady()
    .then(async () => {
      const data = app.getPath("userData");
      await mkdir(data, { recursive: true, mode: 0o700 });
      diagnostics = new DiagnosticTrace(
        join(data, "diagnostics"),
        ProcessSupervisor.trace,
      );
      await diagnostics.init();
      vault = new CredentialVault(join(data, "secrets"), safeStorage);
      await vault.init();
      shell = new DesktopShell(
        __dirname,
        join(currentDirectory, "index.html"),
        {
          quit: () => app.quit(),
          disconnect: () => {
            void native?.stop("tray-disconnect").then(publish).catch(recover);
          },
          rendererFault: () =>
            new Promise<boolean>((resolve) => {
              faultQueue = faultQueue
                .then(async () => {
                  if (
                    !updating &&
                    !quitting &&
                    currentManifest &&
                    (await releases.recordRuntimeFault(currentManifest.id))
                  ) {
                    await rollbackRuntime(currentManifest.id);
                    resolve(true);
                  } else resolve(false);
                })
                .catch((error) => {
                  recover(error);
                  resolve(true);
                });
            }),
        },
      );
      shell.installTray();
      app.on("activate", () => shell.open());
      native = new NativeSession(
        join(__dirname, "flowgate-bridge"),
        join(__dirname, "sing-box"),
        join(data, "native"),
      );
      await native.start();
      // This file is bundled in the signed shell, never loaded from userData.
      let applicationFeed: string | undefined;
      let updateConfig:
        | { metadataUrl: string; targetUrl: string; rootPath: string }
        | undefined;
      try {
        const c = JSON.parse(
          await readFile(join(__dirname, "update-config.json"), "utf8"),
        );
        if (typeof c.applicationFeed === "string" && c.applicationFeed)
          applicationFeed = c.applicationFeed;
        if (c.enabled)
          updateConfig = {
            metadataUrl: c.metadataUrl,
            targetUrl: c.targetUrl,
            rootPath: join(__dirname, "trusted-root.json"),
          };
      } catch {}
      const applicationUpdate = new ApplicationUpdate(applicationFeed);
      releases = new ReleaseManager(
        join(data, "releases"),
        updateConfig,
        supervisedVerification(join(__dirname, "verification.cjs")),
      );
      await releases.init();
      let rollbackDirectory = currentDirectory,
        rollbackManifest = currentManifest;
      const bundledHashes = JSON.parse(
        await readFile(join(__dirname, "bundled-hashes.json"), "utf8"),
      );
      const updateTrace = new UpdateTrace(join(data, "diagnostics"));
      await updateTrace.init();
      const coordinator = new UpdateCoordinator(
        releases,
        {
          uiOnly: (manifest) =>
            manifest.files[manifest.service].sha256 ===
              (currentManifest?.files[currentManifest.service].sha256 ??
                bundledHashes["service.cjs"]) &&
            manifest.files[manifest.extension].sha256 ===
              (currentManifest?.files[currentManifest.extension].sha256 ??
                bundledHashes["extension.cjs"]) &&
            manifest.files["gateway.cjs"]?.sha256 ===
              (currentManifest?.files["gateway.cjs"]?.sha256 ??
                bundledHashes["gateway.cjs"]) &&
            manifest.files["telemetry.proto"]?.sha256 ===
              (currentManifest?.files["telemetry.proto"]?.sha256 ??
                bundledHashes["telemetry.proto"]),
          restoreUI: async () => {
            await shell.reload(
              join(currentDirectory, currentManifest?.ui ?? "index.html"),
            );
          },
          preflight: async (directory, manifest) => {
            const host = new ProcessSupervisor(
              "Preflight",
              join(directory, manifest.service),
              {
                FLOWGATE_DATA: join(data, "business"),
                FLOWGATE_RELEASE: manifest.id,
                FLOWGATE_PREFLIGHT: "1",
                FLOWGATE_EXPECTED_SERVICE_MODULES:
                  manifest.catalogVersion === 1
                    ? JSON.stringify(manifest.builtins)
                    : "",
              },
            );
            attachCapabilities(host, true);
            try {
              const health = (await host.start()) as any;
              if (health.protocol !== 1 || health.schema !== 1)
                throw new Error("预检协议不兼容");
            } finally {
              await host.stop(false);
            }
          },
          drain: async () => {
            rollbackDirectory = currentDirectory;
            rollbackManifest = currentManifest;
            await gateway?.call("drain");
            await service?.call("drain");
          },
          safePoint: async () => {
            await service?.call("drain");
          },
          stop: stopHosts,
          start: async (directory, manifest) => {
            await startHosts(directory, manifest);
            currentDirectory = directory;
            currentManifest = manifest;
          },
          restore: async () => {
            await stopHosts();
            await startHosts(rollbackDirectory, rollbackManifest);
            currentDirectory = rollbackDirectory;
            currentManifest = rollbackManifest;
            await shell.reload(
              join(currentDirectory, currentManifest?.ui ?? "index.html"),
            );
          },
          reloadUI: async (directory, manifest) => {
            await shell.reload(join(directory, manifest.ui));
            currentDirectory = directory;
            currentManifest = manifest;
          },
        },
        (event) => updateTrace.record(event),
      );
      const clientMethods = new Set([
        "extensions.setEnabled",
        "extensions.restart",
        "snapshot",
        "network.refresh",
        "node.measure",
        "ruleset.import",
        "ruleset.refresh",
        "ruleset.remove",
        "policy.explain",

        "operation.get",
        "configuration.save",
        "subscription.import",
        "subscription.refresh",
        "node.remove",
        "node.update",
        "subscription.rename",
        "subscription.remove",
        "proxy.connect",
        "proxy.disconnect",
      ]);
      const clientRequests = new Map<string, Set<AbortController>>();
      ipcMain.handle("client:cancel", (event, operationId) => {
        shell.authorize(event);
        if (typeof operationId !== "string") throw new Error("无效操作标识");
        const controllers = clientRequests.get(
          event.sender.id + ":" + operationId,
        );
        for (const controller of controllers ?? []) controller.abort();
        return { requested: !!controllers?.size };
      });
      ipcMain.handle("client:request", async (event, input) => {
        shell.authorize(event);
        if (
          shell.recovering ||
          !service ||
          ((updating || suspended) && input?.method !== "snapshot")
        )
          throw new Error("服务正在恢复或切换");
        if (
          !input ||
          typeof input.method !== "string" ||
          JSON.stringify(input).length > 5 * 1024 * 1024 ||
          !clientMethods.has(input.method)
        )
          throw new Error("无效业务请求");
        const controller = new AbortController();
        const key = event.sender.id + ":" + input.operationId;
        const controllers =
          clientRequests.get(key) ?? new Set<AbortController>();
        controllers.add(controller);
        clientRequests.set(key, controllers);
        try {
          const result = await service.call(
            input.method,
            input.payload,
            input.operationId,
            controller.signal,
          );
          if (
            !["snapshot", "policy.explain", "operation.get"].includes(
              input.method,
            )
          )
            await publish();
          return result;
        } finally {
          controllers.delete(controller);
          if (!controllers.size) clientRequests.delete(key);
        }
      });
      ipcMain.handle("shell:request", async (event, input) => {
        shell.authorize(event);
        if (input?.method === "ui.ready") {
          shell.markReady();
          if (pendingNavigation) {
            event.sender.send("shell:navigate", pendingNavigation);
            pendingNavigation = undefined;
          }
          return true;
        }
        if (input?.method === "ui.draft.get")
          return (
            drafts.get(input.payload?.key) ?? (input.payload?.key ? null : "")
          );
        if (input?.method === "ui.draft.set") {
          if (typeof input.payload === "string")
            drafts.set("subscription", input.payload);
          else if (input.payload && typeof input.payload.key === "string")
            drafts.set(input.payload.key, input.payload.value);
          else throw new Error("无效草稿");
          return true;
        }
        if (input?.method === "recovery.status")
          return { message: recoveryMessage };
        if (input?.method === "recovery.disconnect") {
          await native.stop("recovery-disconnect");
          return native.status();
        }
        if (
          input?.method === "recovery.restore" &&
          (shell.recovering ||
            releases.state.revoked.includes(releases.state.current ?? ""))
        ) {
          if (updating) throw new Error("版本切换中");
          drafts.assertReloadable();
          updating = true;
          try {
            await stopHosts();
            await releases.restoreBundled();
            currentDirectory = join(__dirname, "release");
            currentManifest = undefined;
            await startHosts(currentDirectory);
            await shell.reload(join(currentDirectory, "index.html"));
          } finally {
            updating = false;
          }
          return true;
        }
        if (shell.recovering) throw new Error("恢复界面只允许恢复操作");
        if (
          input.method === "gateway.credential.rotate" &&
          internalGatewayAvailable
        ) {
          return vault.rotate(
            "provider.mock",
            input.payload?.secret,
            input.payload?.generation,
          );
        }
        if (
          input.method === "gateway.credential.probe" &&
          internalGatewayAvailable
        ) {
          if (!gateway) throw new Error("内部服务尚未启动");
          return gateway.call("credential.probe");
        }
        if (input.method === "gateway.status")
          return {
            available: internalGatewayAvailable,
            enabled: gatewayEnabled,
            ...(gateway
              ? ((await gateway.call("status")) as Record<string, unknown>)
              : { lifecycle: "stopped" }),
          };
        if (input.method === "gateway.start") {
          if (!internalGatewayAvailable || updating)
            throw new Error("内部服务不可用");
          if (!gateway) {
            gatewayEnabled = true;
            try {
              await startGateway(currentDirectory, currentManifest);
            } catch (error) {
              gatewayEnabled = false;
              throw error;
            }
          }
          return { started: true };
        }
        if (input.method === "gateway.stop") {
          if (updating) throw new Error("版本切换中");
          await gateway?.stop();
          gateway = undefined;
          gatewayEnabled = false;
          return { stopped: true };
        }
        if (input.method === "helper.install") return native.installHelper();
        if (input.method === "application.check")
          return applicationUpdate.check();
        if (input.method === "diagnostics.trace")
          return ProcessSupervisor.trace.snapshot();
        if (input.method === "release.status")
          return {
            ...releases.state,
            updating,
            suspended,
            events: updateTrace.snapshot(),
            release: currentManifest?.id ?? "bundled",
            configured: !!updateConfig,
            versions: {
              application: app.getVersion(),
              releaseSet: currentManifest?.id ?? "bundled",
              ui: currentManifest?.components?.ui ?? app.getVersion(),
              service: currentManifest?.components?.service ?? app.getVersion(),
              extension:
                currentManifest?.components?.extension ?? app.getVersion(),
              clientApi: 1,
              pluginApi: 1,
              schema: 1,
              helper: app.getVersion(),
              kernel: (await native.status()).version ?? "unknown",
              modules: currentManifest?.builtins ?? [],
            },
          };
        if (input.method === "release.check")
          return releases.check(input.payload?.channel);
        if (input.method === "release.activate") {
          if (suspended) throw new Error("系统正在恢复网络状态，请稍后更新");
          drafts.assertReloadable();
          if (typeof input.payload?.id !== "string")
            throw new Error("缺少版本标识");
          updating = true;
          try {
            await coordinator.activate(input.payload.id);
          } finally {
            updating = false;
          }
          return true;
        }
        if (input.method === "window.reload") {
          drafts.assertReloadable();
          await shell.reload(shell.uiPath);
          return true;
        }
        if (input.method === "app.quit") {
          app.quit();
          return true;
        }
        throw new Error("不支持的外壳命令");
      });
      try {
        if (releases.state.current) {
          const verified = await releases.resolve(releases.state.current);
          currentDirectory = verified.directory;
          currentManifest = verified.manifest;
          shell.uiPath = join(currentDirectory, currentManifest.ui);
        }
        await startHosts(currentDirectory, currentManifest);
        shell.open();
      } catch (error) {
        recover(error);
      }
      let powerWork = Promise.resolve();
      let powerGeneration = 0;
      const pauseDeadlines = (value: boolean) => {
        native.setSuspended(value);
        for (const host of [service, extension, gateway])
          host?.setSuspended(value);
      };
      powerMonitor.on("suspend", () => {
        powerGeneration++;
        suspended = true;
        pauseDeadlines(true);
        powerWork = powerWork
          .then(async () => {
            await service?.call("power.suspend");
          })
          .catch(() => {
            /* Resume rechecks every host and the native state. */
          });
      });
      powerMonitor.on("resume", () => {
        const generation = ++powerGeneration;
        pauseDeadlines(false);
        powerWork = powerWork
          .then(async () => {
            while (updating && !quitting)
              await new Promise((resolve) => setTimeout(resolve, 50));
            if (quitting || generation !== powerGeneration) return;
            await native.status();
            for (const host of [extension, service, gateway]) {
              if (!host) continue;
              try {
                await host.call(
                  "health",
                  undefined,
                  undefined,
                  undefined,
                  5000,
                );
              } catch {
                if (!host.canRestart())
                  throw new Error("唤醒后宿主恢复次数已耗尽");
                await host.stop(false);
                if (host === service)
                  await clearDeadWriter(join(data, "business/writer.lock"));
                await host.start();
              }
            }
            await service?.call("power.resume");
            if (generation !== powerGeneration) return;
            suspended = false;
            await publish();
          })
          .catch(recover);
      });
    })
    .catch((error) => {
      if (shell) recover(error);
      else app.quit();
    });
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    native?.setSuspended(false);
    for (const host of [service, extension, gateway]) host?.setSuspended(false);
    if (shell) shell.quitting = true;
    void (async () => {
      try {
        await cleanupStages([
          { name: "hosts", run: stopHosts },
          {
            name: "native",
            run: async () => {
              await native?.close();
            },
          },
          {
            name: "diagnostics",
            run: async () => {
              await diagnostics?.flush();
            },
          },
        ]);
      } catch (error) {
        quitting = false;
        if (shell) shell.quitting = false;
        recover(error);
        return;
      }
      app.quit();
    })();
  });
}
