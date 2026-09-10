import type { RuntimeModule } from "../../runtime/src/lifecycle";
import { KernelRuntime, singBoxAdapter } from "./kernel/adapter";
import { networkPath } from "../../domain/src/network-path";
import { requestTrace } from "../../runtime/src/trace-context";
import { measureOutbound, type NodeMeasurement } from "./kernel/measurement";
import { readHandoff, writeHandoff } from "./handoff";
import {
  BUILD_VERSION,
  CONFIGURATION_SCHEMA,
} from "../../contracts/src/version";
import { networkConflicts } from "../../domain/src/network-conflicts";
import { randomUUID } from "node:crypto";
import type {
  AppSnapshot,
  NativePort,
  NetworkState,
  Operation,
  KernelState,
  Rule,
  RuleSource,
} from "../../contracts/src/index";
import {
  explainRoute,
  validateConfiguration,
} from "../../domain/src/configuration";
import { StateStore } from "./store";
import { SubscriptionService } from "./subscriptions";
import { SubscriptionRefresh } from "./subscription-refresh";
import type { KernelTelemetry } from "./kernel/telemetry";
import { NetworkObserver } from "./network-observer";
import {
  builtinExtensions,
  extensionPreferences,
  type ExtensionState,
} from "../../contracts/src/extensions";
export class ServiceCore {
  private readonly subscriptions: SubscriptionService;
  private readonly subscriptionRefresh: SubscriptionRefresh;
  private extensionStates: ExtensionState[] = [];
  private async readExtensions() {
    try {
      const health = (await this.extension(
        "health",
        undefined,
        AbortSignal.timeout(1500),
      )) as {
        extensions?: ExtensionState[];
      };
      if (!Array.isArray(health?.extensions))
        throw new Error("扩展宿主未提供目录");
      this.extensionStates = builtinExtensions.map((descriptor) => {
        const observed = health.extensions!.find(
          (entry) => entry.id === descriptor.id,
        );
        if (
          !observed ||
          !["starting", "ready", "draining", "stopped", "failed"].includes(
            observed.status,
          )
        )
          throw new Error("扩展状态无效");
        return {
          ...descriptor,
          enabled: observed.enabled === true,
          desiredEnabled:
            this.store.extensionPreferences[descriptor.id] ??
            descriptor.defaultEnabled,
          status: observed.status,
          instance: observed.instance,
          error: observed.error,
          releaseSet: this.releaseSet,
        };
      });
      this.moduleInfo = this.extensionStates.map((entry) => ({
        id: entry.id,
        name: entry.name,
        version: entry.version,
        status: entry.status === "unavailable" ? "failed" : entry.status,
      }));
    } catch {
      this.extensionStates = builtinExtensions.map((descriptor) => ({
        ...descriptor,
        enabled: false,
        desiredEnabled:
          this.store.extensionPreferences[descriptor.id] ??
          descriptor.defaultEnabled,
        status: "unavailable",
        releaseSet: this.releaseSet,
        error: "扩展宿主暂时不可用，状态尚未确认。",
      }));
    }
  }
  async reconcileExtensions() {
    return this.store.transact(async () => {
      await this.extension("extensions.configure", {
        preferences: this.store.extensionPreferences,
      });
      await this.readExtensions();
    });
  }
  readonly native: KernelRuntime;
  private readonly networkObserver: NetworkObserver;
  lifecycle: AppSnapshot["lifecycle"] = "starting";
  network: NetworkState | null = null;
  private networkCoordination: Promise<unknown> = Promise.resolve();
  private measurements = new Map<string, NodeMeasurement>();
  private measuring = new Map<string, AbortController>();
  private invalidateMeasurements() {
    for (const controller of this.measuring.values()) controller.abort();
    this.measuring.clear();
    this.measurements.clear();
  }
  private moduleInfo: AppSnapshot["modules"] = [];
  constructor(
    readonly store: StateStore,
    native: NativePort,
    readonly extension: (
      method: string,
      payload?: unknown,
      signal?: AbortSignal,
    ) => Promise<unknown>,
    readonly releaseSet: string,
    readonly telemetry?: KernelTelemetry,
    readonly version = BUILD_VERSION,
    adapterFactory: (native: NativePort) => RuntimeModule = singBoxAdapter,
  ) {
    this.subscriptions = new SubscriptionService(
      () => this.store.configuration,
      this.extension,
    );
    this.subscriptionRefresh = new SubscriptionRefresh(
      () => this.store.configuration.subscriptions,
      async (id, signal) => {
        try {
          if (this.lifecycle !== "ready") return;
          const preview = await this.subscriptions.preview({ id }, signal);
          if (!preview.canCommit || preview.requiresReview)
            throw new Error("需要人工查看转换预览");
          await this.request(
            "subscription.refresh",
            { id, previewId: preview.id },
            "subscription-auto-" + randomUUID(),
            signal,
          );
        } catch {
          if (signal.aborted || this.lifecycle !== "ready") return;
          await this.store.transact(async () => {
            if (signal.aborted) return;
            const source = this.store.configuration.subscriptions.find(
              (s) => s.id === id,
            );
            if (source) {
              source.error = "自动更新未提交，已保留原配置；请打开更新预览检查";
              await this.store.persist();
            }
          });
        }
      },
    );
    const bootstrapTrace = randomUUID().replaceAll("-", "");
    this.native = new KernelRuntime(adapterFactory(native), () => ({
      operationId: "service-" + store.epoch,
      traceId: bootstrapTrace,
      ...requestTrace.getStore(),
      releaseSet,
      serviceVersion: version,
      epoch: store.epoch,
      configRevision: store.configuration.revision,
      shellVersion: BUILD_VERSION,
      hostVersion: version,
      protocolVersion: 1,
      schemaVersion: CONFIGURATION_SCHEMA,
    }));
    this.networkObserver = new NetworkObserver(
      async () => (await this.extension("network.inspect")) as NetworkState,
      (state) => {
        const previous = this.network;
        this.network = state;
        if (previous && state) {
          this.networkCoordination = this.networkCoordination
            .catch(() => {})
            .then(() => this.coordinateNetwork(previous, state))
            .catch(() => {
              if (this.network === state)
                state.warnings.push(
                  "网络变化后的连接协调失败，请核对当前连接状态后重试。",
                );
            });
        }
      },
      () => {
        if (this.network)
          this.network = {
            ...this.network,
            warnings: [
              ...new Set([
                ...this.network.warnings,
                "网络状态刷新失败，当前显示上次观测结果",
              ]),
            ],
          };
      },
    );
  }
  private async coordinateNetwork(previous: NetworkState, state: NetworkState) {
    if (this.lifecycle !== "ready" || this.network !== state) return;
    const kernel = await this.native.status();
    const own = kernel.tunInterface;
    if (networkPath(previous, own) === networkPath(state, own)) return;
    this.invalidateMeasurements();
    if (kernel.status !== "running" || this.hasUnknownNative()) return;
    if (kernel.appliedRevision !== this.store.configuration.revision) {
      state.warnings.push(
        "网络已变化，当前有尚未应用的配置；请确认配置后重新连接。",
      );
      return;
    }
    const conflicts = networkConflicts(this.store.configuration, state, kernel);
    const blocked = conflicts.filter((c) => c.severity === "blocked");
    const id = "network-" + randomUUID();
    // Reuse the same serialized, persisted native operation path as user changes.
    // Never reclaim proxy settings after another application has taken ownership.
    await this.request(
      blocked.length ? "proxy.disconnect" : "proxy.connect",
      {
        networkExpectedOperation: kernel.operationId ?? null,
        networkExpectedRevision: kernel.appliedRevision,
      },
      id,
    );
    (this.network ?? state).warnings.push(
      blocked.length
        ? "检测到网络冲突，已停止本应用连接并按所有权恢复设置。解决冲突后请重新连接。"
        : "网络路径已变化，已用当前已应用配置重新建立本应用连接。",
    );
  }
  async start() {
    await this.store.start();
    try {
      await this.native.start();
    } catch (error) {
      await this.store.close();
      throw error;
    }
    await readHandoff(this.store.directory, this.store.configuration.revision);
    const kernel = await this.native.status();
    await this.reconcileNative(kernel);
    await this.store.persist();
    // Only Service owns the durable preferences; the replacement host starts core packages first.
    try {
      await this.reconcileExtensions();
    } catch {
      await this.readExtensions();
    }
    try {
      const health = (await this.extension("health")) as {
        modules?: AppSnapshot["modules"];
      };
      if (Array.isArray(health?.modules))
        this.moduleInfo = health.modules.map((module) => ({
          ...module,
          name:
            module.id === "builtin.network"
              ? "网络发现"
              : module.id === "builtin.subscription"
                ? "订阅解析"
                : module.id,
        }));
    } catch {}
    this.lifecycle = "ready";
    this.networkObserver.start();
    this.subscriptionRefresh.start();
    if (
      this.store.configuration.settings.autoConnect &&
      kernel.status === "stopped"
    ) {
      await this.request(
        "proxy.connect",
        {},
        "autoconnect-" + this.store.epoch,
      ).catch(() => {});
    }
  }
  private async reconcileNative(kernel?: KernelState) {
    if (!this.hasUnknownNative()) return;
    kernel ??= await this.native.status();
    let changed = false;
    for (const o of this.store.operations) {
      if (
        o.state === "unknown" &&
        kernel.operationId === o.id &&
        ((o.kind === "proxy.connect" &&
          kernel.status === "running" &&
          kernel.appliedRevision === o.revision) ||
          (o.kind === "proxy.disconnect" && kernel.status === "stopped"))
      ) {
        o.state = "succeeded";
        o.completedAt = new Date().toISOString();
        changed = true;
      }
    }
    if (changed) await this.store.persist();
  }
  private hasUnknownNative() {
    return this.store.operations.some(
      (o) =>
        o.state === "unknown" &&
        ["proxy.connect", "proxy.disconnect"].includes(o.kind),
    );
  }
  async snapshot(): Promise<AppSnapshot> {
    await this.readExtensions();
    if (this.telemetry && this.native.control)
      this.telemetry.connect(await this.native.control());
    const kernel = await this.native.status();
    const visible = structuredClone(this.store.configuration);
    for (const node of visible.nodes) node.options = {};
    for (const subscription of visible.subscriptions) {
      subscription.canRefresh = !!subscription.url;
      subscription.url = "";
      delete subscription.etag;
      delete subscription.lastModified;
    }
    for (const source of visible.ruleSources ?? []) source.url = "";
    return {
      protocol: 1,
      extensions: this.extensionStates,
      extensionRevision: this.store.extensionRevision,
      epoch: this.store.epoch,
      releaseSet: this.releaseSet,
      lifecycle: this.lifecycle,
      configuration: visible,
      traffic: this.telemetry?.snapshot(),
      kernel,
      appliedConnection:
        kernel.status === "running" &&
        kernel.appliedRevision === this.store.appliedConnection?.revision &&
        kernel.operationId === this.store.appliedConnection?.operationId
          ? this.store.appliedConnection
          : undefined,
      networkConflicts: networkConflicts(
        this.store.configuration,
        this.network,
        kernel,
      ),
      operations: this.store.operations.slice(-30).reverse(),
      network: this.network,
      nodeMeasurements: [...this.measurements.values()],
      modules: [...(this.moduleInfo ?? []), this.native.snapshot()],
      serviceVersion: this.version,
    };
  }
  async request(
    method: string,
    payload: any,
    operationId?: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    signal?.throwIfAborted();
    if (method === "snapshot") return this.snapshot();
    if (method === "health")
      return {
        protocol: 1,
        schema: 2,
        epoch: this.store.epoch,
        lifecycle: this.lifecycle,
      };
    if (method === "extensions.reconcile") {
      await this.reconcileExtensions();
      return { reconciled: true };
    }
    if (method === "node.measure") {
      if (this.lifecycle !== "ready") throw new Error("服务不可用");
      const id = String(payload?.id ?? "");
      if (!this.store.configuration.nodes.some((node) => node.id === id))
        throw new Error("节点不存在");
      if (this.measuring.has(id) || this.measuring.size >= 3)
        throw new Error("已有检测正在进行");
      if (
        this.store.operations.some(
          (operation) =>
            ["proxy.connect", "proxy.disconnect"].includes(operation.kind) &&
            ["pending", "unknown"].includes(operation.state),
        )
      )
        throw new Error("连接正在切换，请稍后检测");
      const revision = this.store.configuration.revision;
      const controller = new AbortController();
      this.measuring.set(id, controller);
      this.measurements.set(id, { id, state: "running" });
      try {
        const kernel = await this.native.status(),
          control = await this.native.control?.();
        if (
          kernel.status !== "running" ||
          kernel.appliedRevision !== revision ||
          !control
        )
          throw new Error("请先启动代理并应用当前配置");
        controller.signal.throwIfAborted();
        const result = await measureOutbound(
          control,
          id,
          signal
            ? AbortSignal.any([signal, controller.signal])
            : controller.signal,
        );
        controller.signal.throwIfAborted();
        if (this.store.configuration.revision !== revision)
          throw new Error("配置已变化，请重新检测");
        this.measurements.set(id, result);
        return result;
      } catch (error) {
        if (this.measuring.get(id) === controller)
          this.measurements.set(id, {
            id,
            state: "failed",
            measuredAt: new Date().toISOString(),
            message: error instanceof Error ? error.message : "检测失败",
          });
        throw error;
      } finally {
        if (this.measuring.get(id) === controller) this.measuring.delete(id);
      }
    }
    if (method === "network.refresh") {
      await this.networkObserver.refresh();
      await this.networkCoordination;
      return this.snapshot();
    }
    if (method === "policy.explain")
      return explainRoute(
        this.store.configuration,
        String(payload?.target ?? ""),
      );

    if (method === "operation.get") {
      return this.store.transact(async () => {
        await this.reconcileNative();
        return this.store.operations.find((o) => o.id === payload?.id) ?? null;
      });
    }
    if (method === "subscription.preview") {
      if (this.lifecycle !== "ready") throw new Error("服务不可用");
      return this.subscriptions.preview(payload ?? {}, signal);
    }
    if (!operationId) throw new Error("写操作需要 operationId");
    const allowed = [
      "extensions.setEnabled",
      "extensions.restart",
      "configuration.save",
      "ruleset.import",
      "ruleset.refresh",
      "ruleset.remove",
      "subscription.import",
      "subscription.refresh",
      "node.remove",
      "node.update",
      "group.select",
      "subscription.rename",
      "subscription.remove",
      "proxy.connect",
      "proxy.disconnect",
    ];
    if (!allowed.includes(method)) throw new Error("不支持的命令");
    return this.store.transact(async () => {
      signal?.throwIfAborted();
      await this.reconcileNative();
      const previous = this.store.operations.find((o) => o.id === operationId);
      if (previous)
        return { operation: previous, snapshot: await this.snapshot() };
      if (
        ["proxy.connect", "proxy.disconnect"].includes(method) &&
        this.hasUnknownNative()
      )
        throw Object.assign(new Error("原生操作结果尚未明确，请稍后核对"), {
          outcome: "unknown",
        });
      if (payload?.networkExpectedRevision !== undefined) {
        const current = await this.native.status();
        if (
          this.lifecycle !== "ready" ||
          current.status !== "running" ||
          (current.operationId ?? null) !== payload.networkExpectedOperation ||
          current.appliedRevision !== payload.networkExpectedRevision ||
          this.store.configuration.revision !== payload.networkExpectedRevision
        )
          return;
      }
      const operation: Operation = {
        id: operationId,
        traceId:
          requestTrace.getStore()?.traceId ?? randomUUID().replaceAll("-", ""),
        kind: method,
        state: "pending" as const,
        revision: this.store.configuration.revision,
        startedAt: new Date().toISOString(),
      };
      operation.context = {
        ...requestTrace.getStore(),
        operationId: operation.id,
        traceId: operation.traceId,
        releaseSet: this.releaseSet,
        serviceVersion: this.version,
        epoch: this.store.epoch,
        configRevision: operation.revision,
      };
      const scope = requestTrace.getStore();
      if (scope) Object.assign(scope, operation.context);
      this.store.operations.push(operation);
      await this.store.persist();
      const previousConfiguration = this.store.configuration;
      const previousPreferences = this.store.extensionPreferences;
      const previousExtensionRevision = this.store.extensionRevision;
      let extensionsChanged = false;
      try {
        if (
          method === "extensions.setEnabled" ||
          method === "extensions.restart"
        ) {
          if (payload?.revision !== this.store.extensionRevision)
            throw new Error("扩展设置已变化，请刷新后重试");
          let next = previousPreferences;
          if (method === "extensions.setEnabled") {
            if (
              typeof payload?.id !== "string" ||
              typeof payload?.enabled !== "boolean"
            )
              throw new Error("扩展设置无效");
            next = extensionPreferences({
              ...previousPreferences,
              [payload.id]: payload.enabled,
            });
          }
          // Once admitted, this is a lifecycle transaction: cancellation stops waiting, not its commit.
          await this.extension(
            method === "extensions.restart"
              ? "extensions.restart"
              : "extensions.configure",
            { preferences: next },
          );
          extensionsChanged = true;
          this.store.extensionPreferences = next;
          this.store.extensionRevision++;
          // Discard prior reports immediately; late observations filter against active packages.
          if (this.network)
            this.network = {
              ...this.network,
              plugins: this.network.plugins.filter(
                (plugin) => next[plugin.id] ?? true,
              ),
            };
          await this.readExtensions();
        } else if (method === "proxy.connect") {
          if (
            this.store.configuration.settings.mode !== "manual" &&
            !(await this.native.status()).systemControl
          )
            throw new Error("请先安装并批准已签名的系统辅助服务");
          if (
            this.store.configuration.settings.mode !== "manual" ||
            (this.store.configuration.externalNetworks ?? []).length
          ) {
            const observed = (await this.extension(
              "network.inspect",
            )) as NetworkState;
            if (!observed || !Array.isArray(observed.interfaces))
              throw new Error("无法确认外部网络状态，暂不接管系统网络");
            this.network = observed;
            const conflicts = networkConflicts(
              this.store.configuration,
              observed,
              await this.native.status(),
            );
            const blocked = conflicts.filter((c) => c.severity === "blocked");
            if (blocked.length)
              throw new Error(blocked.map((c) => c.message).join("\n"));
          }
          const compiled = await this.native.compile(this.store.configuration);
          this.invalidateMeasurements();
          await this.native.apply(
            compiled,
            this.store.configuration.revision,
            operationId,
            this.store.configuration.settings.mode,
          );
          const c = this.store.configuration,
            id = c.settings.selectedNode;
          this.store.appliedConnection = {
            revision: c.revision,
            operationId,
            selectedNode: id,
            outletName:
              c.nodes.find((n) => n.id === id)?.name ??
              c.groups?.find((g) => g.id === id)?.name ??
              c.externalNetworks?.find((n) => n.id === id)?.name ??
              (id === "direct" ? "直连" : id),
            mode: c.settings.mode,
            listenPort: c.settings.listenPort,
            finalOutbound: c.settings.finalOutbound,
            ruleCount: c.rules.length,
          };
        } else if (method === "proxy.disconnect") {
          this.invalidateMeasurements();
          await this.native.stop(operationId);
        } else {
          const next = structuredClone(this.store.configuration);
          let metadataOnly = false;
          if (method === "configuration.save") {
            if (payload?.revision !== next.revision)
              throw new Error("配置已更新，请刷新后再保存");
            next.settings = { ...next.settings, ...payload.settings };
            next.rules = payload.rules;
            if (payload.externalNetworks !== undefined)
              next.externalNetworks = payload.externalNetworks;
          }
          if (method === "node.update") {
            const node = next.nodes.find((n) => n.id === payload?.id);
            if (!node) throw new Error("节点不存在");
            if (payload.revision !== next.revision)
              throw new Error("配置已更新，请刷新后再保存");
            node.name = String(payload.name ?? node.name).trim();
            node.server = String(payload.server ?? node.server).trim();
            node.port = payload.port ?? node.port;
          }
          if (method === "group.select") {
            const group = next.groups?.find(
              (group) => group.id === payload?.id,
            );
            if (payload?.revision !== next.revision)
              throw new Error("配置已变化，请刷新后再选择");
            if (
              !group ||
              group.type !== "selector" ||
              !group.members.includes(payload.member)
            )
              throw new Error("策略组或成员不存在");
            group.selected = payload.member;
          }
          if (method === "subscription.rename") {
            const sub = next.subscriptions.find((s) => s.id === payload?.id);
            const name = String(payload?.name ?? "").trim();
            if (!sub || !name || name.length > 100)
              throw new Error("订阅名称无效");
            sub.name = name;
          }
          if (method === "subscription.remove") {
            if (!next.subscriptions.some((s) => s.id === payload?.id))
              throw new Error("订阅不存在");
            const removed = new Set(
              next.nodes
                .filter((n) => n.sourceId === payload.id)
                .map((n) => n.id),
            );
            next.subscriptions = next.subscriptions.filter(
              (s) => s.id !== payload.id,
            );
            next.rules = next.rules.map((rule) =>
              rule.sourceId === payload.id
                ? { ...rule, sourceId: undefined }
                : rule,
            );
            next.groups = (next.groups ?? []).map((group) =>
              group.sourceId === payload.id
                ? { ...group, sourceId: "local" }
                : group,
            );
            // Keep imported nodes as local entries so deleting a source cannot silently break active rules.
            next.nodes = next.nodes.map((n) =>
              removed.has(n.id) ? { ...n, sourceId: undefined } : n,
            );
          }
          if (method === "node.remove") {
            next.nodes = next.nodes.filter((n) => n.id !== payload?.id);
            if (next.settings.selectedNode === payload?.id)
              next.settings.selectedNode = "direct";
            next.rules = next.rules.filter((r) => r.outbound !== payload?.id);
            if (next.settings.finalOutbound === payload?.id)
              next.settings.finalOutbound = "select";
          }
          if (
            method === "subscription.import" ||
            method === "subscription.refresh"
          ) {
            const previewId =
              payload?.previewId ??
              (
                await this.subscriptions.preview(
                  method === "subscription.refresh"
                    ? { ...payload, id: payload?.id }
                    : { ...payload, id: undefined },
                  signal,
                )
              ).id;
            metadataOnly = this.subscriptions.metadataOnly(previewId);
            const imported = this.subscriptions.commit(
              previewId,
              method === "subscription.refresh",
              payload?.id,
              !!payload?.previewId && payload.reviewed === true,
            );
            Object.assign(next, imported);
          }
          if (method === "ruleset.remove") {
            next.ruleSources = (next.ruleSources ?? []).filter(
              (source) => source.id !== payload?.id,
            );
            next.rules = next.rules.filter(
              (rule) => rule.sourceId !== payload?.id,
            );
          }
          if (method === "ruleset.import" || method === "ruleset.refresh") {
            let source: RuleSource;
            if (method === "ruleset.refresh") {
              const found = next.ruleSources?.find(
                (source) => source.id === payload?.id,
              );
              if (!found) throw new Error("规则集来源不存在");
              source = found;
            } else {
              const url = new URL(payload?.url);
              if (url.protocol !== "https:" || url.username || url.password)
                throw new Error("规则集来源必须使用 HTTPS");
              source = {
                id: randomUUID(),
                name: String(payload?.name || "规则集"),
                url: url.href,
                format: payload?.format,
                outbound: String(payload?.outbound),
                count: 0,
              };
              (next.ruleSources ??= []).push(source);
            }
            const text = await this.extension(
              "subscription.fetch",
              {
                url: source.url,
              },
              signal,
            );
            const rules = (await this.extension(
              "ruleset.parse",
              {
                text,
                format: source.format,
                sourceId: source.id,
                outbound: source.outbound,
              },
              signal,
            )) as Rule[];
            const position = next.rules.findIndex(
              (rule) => rule.sourceId === source.id,
            );
            next.rules = next.rules.filter(
              (rule) => rule.sourceId !== source.id,
            );
            next.rules.splice(
              position < 0 ? next.rules.length : position,
              0,
              ...rules,
            );
            source.count = rules.length;
            source.updatedAt = new Date().toISOString();
            delete source.error;
          }
          next.revision =
            this.store.configuration.revision + (metadataOnly ? 0 : 1);
          validateConfiguration(next);
          signal?.throwIfAborted();
          this.store.configuration = next;
        }
        Object.assign(operation, {
          state: "succeeded",
          completedAt: new Date().toISOString(),
          revision: this.store.configuration.revision,
        });
        await this.store.persist();
        return { operation, snapshot: await this.snapshot() };
      } catch (error) {
        this.store.configuration = previousConfiguration;
        if (
          extensionsChanged ||
          method === "extensions.setEnabled" ||
          method === "extensions.restart"
        ) {
          this.store.extensionPreferences = previousPreferences;
          this.store.extensionRevision = previousExtensionRevision;
          await this.extension("extensions.configure", {
            preferences: previousPreferences,
          }).catch(() => {});
        }
        if (method === "ruleset.refresh") {
          const source = this.store.configuration.ruleSources?.find(
            (source) => source.id === payload?.id,
          );
          if (source) source.error = "更新失败，已保留原规则";
        }
        if (method === "subscription.refresh") {
          const sub = this.store.configuration.subscriptions.find(
            (s) => s.id === payload?.id,
          );
          if (sub) sub.error = "更新失败，保留原节点";
        }
        Object.assign(operation, {
          state: (error as any).outcome === "unknown" ? "unknown" : "failed",
          completedAt: new Date().toISOString(),
          message: error instanceof Error ? error.message : "操作失败",
        });
        await this.store.persist();
        throw error;
      }
    });
  }
  async preflight() {
    await this.store.start(true);
    await this.native.start();
    await this.native.compile(this.store.configuration);
    this.lifecycle = "ready";
  }
  async drain() {
    this.lifecycle = "draining";
    this.subscriptionRefresh.stop();
    this.subscriptions.pause();
    this.networkObserver.stop();
    this.invalidateMeasurements();
    await this.subscriptionRefresh.drain();
    await this.store.drain();
    try {
      await this.reconcileNative();
      if (this.hasUnknownNative())
        throw Object.assign(new Error("原生操作结果尚未明确，已延后更新"), {
          outcome: "unknown",
        });
      await this.native.drain(Date.now() + 5000);
      await writeHandoff(this.store.directory, {
        version: 1,
        protocol: 1,
        schema: 2,
        releaseSet: this.releaseSet,
        epoch: this.store.epoch,
        revision: this.store.configuration.revision,
        pendingOperationIds: this.store.operations
          .filter(
            (operation) =>
              operation.state === "pending" || operation.state === "unknown",
          )
          .map((operation) => operation.id),
        at: new Date().toISOString(),
      });
    } catch (error) {
      this.subscriptions.resume();
      this.store.resume();
      this.native.resume();
      this.lifecycle = "ready";
      this.networkObserver.resume();
      this.subscriptionRefresh.start();
      throw error;
    }
  }
  async stop() {
    this.subscriptionRefresh.stop();
    this.subscriptions.pause();
    await this.drain();
    this.telemetry?.close();
    await this.store.close();
    await this.native.dispose();
    this.lifecycle = "stopped";
  }
  suspend() {
    this.subscriptionRefresh.stop();
    this.subscriptions.pause();
    this.store.pause();
    this.lifecycle = "draining";
    this.networkObserver.stop();
    this.invalidateMeasurements();
  }
  async resume() {
    await this.store.drain();
    await this.reconcileNative();
    this.networkObserver.resume();
    await this.networkObserver.refresh().catch(() => {});
    this.subscriptions.resume();
    this.store.resume();
    this.native.resume();
    this.lifecycle = "ready";
    this.subscriptionRefresh.start();
  }
  async resolveEgress(target: string) {
    const url = new URL(target);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error("内部上游地址无效");
    const kernel = await this.native.status();
    if (
      kernel.status !== "running" ||
      kernel.appliedRevision !== this.store.configuration.revision ||
      this.store.configuration.settings.mode === "tun" ||
      this.hasUnknownNative()
    )
      throw new Error("所选代理策略尚未稳定应用，拒绝绕路访问上游");
    return {
      id: "flowgate.policy",
      proxyUrl: `http://127.0.0.1:${this.store.configuration.settings.listenPort}`,
      allowedOrigins: [url.origin],
      configurationRevision: kernel.appliedRevision,
    };
  }
}
