import { requestTrace } from "../../runtime/src/trace-context";
import { measureOutbound, type NodeMeasurement } from "./kernel/measurement";
import { readHandoff, writeHandoff } from "./handoff";
import { BUILD_VERSION } from "../../contracts/src/version";
import { networkConflicts } from "../../domain/src/network-conflicts";
import { randomUUID } from "node:crypto";
import type {
  AppSnapshot,
  Configuration,
  NativePort,
  NetworkState,
  NodeConfig,
  Operation,
  KernelState,
  Rule,
  RuleSource,
} from "../../contracts/src/index";
import {
  compileConfiguration,
  explainRoute,
  validateConfiguration,
} from "../../domain/src/configuration";
import { StateStore } from "./store";
import type { KernelTelemetry } from "./kernel/telemetry";
import { NetworkObserver } from "./network-observer";
export class ServiceCore {
  private readonly networkObserver: NetworkObserver;
  lifecycle: AppSnapshot["lifecycle"] = "starting";
  network: NetworkState | null = null;
  private measurements = new Map<string, NodeMeasurement>();
  private measuring = new Map<string, AbortController>();
  private moduleInfo: AppSnapshot["modules"] = [];
  constructor(
    readonly store: StateStore,
    readonly native: NativePort,
    readonly extension: (
      method: string,
      payload?: unknown,
      signal?: AbortSignal,
    ) => Promise<unknown>,
    readonly releaseSet: string,
    readonly telemetry?: KernelTelemetry,
    readonly version = BUILD_VERSION,
  ) {
    this.networkObserver = new NetworkObserver(
      async () => (await this.extension("network.inspect")) as NetworkState,
      (state) => {
        this.network = state;
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
  async start() {
    await this.store.start();
    await readHandoff(this.store.directory, this.store.configuration.revision);
    const kernel = await this.native.status();
    await this.reconcileNative(kernel);
    await this.store.persist();
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
    if (this.telemetry && this.native.control)
      this.telemetry.connect(await this.native.control());
    const kernel = await this.native.status();
    const visible = structuredClone(this.store.configuration);
    for (const node of visible.nodes) node.options = {};
    for (const subscription of visible.subscriptions) subscription.url = "";
    for (const source of visible.ruleSources ?? []) source.url = "";
    return {
      protocol: 1,
      epoch: this.store.epoch,
      releaseSet: this.releaseSet,
      lifecycle: this.lifecycle,
      configuration: visible,
      traffic: this.telemetry?.snapshot(),
      kernel,
      networkConflicts: networkConflicts(
        this.store.configuration,
        this.network,
        kernel,
      ),
      operations: this.store.operations.slice(-30).reverse(),
      network: this.network,
      nodeMeasurements: [...this.measurements.values()],
      modules: this.moduleInfo,
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
        schema: 1,
        epoch: this.store.epoch,
        lifecycle: this.lifecycle,
      };
    if (method === "node.measure") {
      if (this.lifecycle !== "ready") throw new Error("服务不可用");
      const id = String(payload?.id ?? "");
      if (!this.store.configuration.nodes.some((node) => node.id === id))
        throw new Error("节点不存在");
      if (this.measuring.has(id) || this.measuring.size >= 3)
        throw new Error("已有检测正在进行");
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
        const result = await measureOutbound(
          control,
          id,
          signal
            ? AbortSignal.any([signal, controller.signal])
            : controller.signal,
        );
        if (this.store.configuration.revision !== revision)
          throw new Error("配置已变化，请重新检测");
        this.measurements.set(id, result);
        return result;
      } catch (error) {
        this.measurements.set(id, {
          id,
          state: "failed",
          message: error instanceof Error ? error.message : "检测失败",
        });
        throw error;
      } finally {
        this.measuring.delete(id);
      }
    }
    if (method === "network.refresh") {
      await this.networkObserver.refresh();
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
    if (!operationId) throw new Error("写操作需要 operationId");
    const allowed = [
      "configuration.save",
      "ruleset.import",
      "ruleset.refresh",
      "ruleset.remove",
      "subscription.import",
      "subscription.refresh",
      "node.remove",
      "node.update",
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
      try {
        if (method === "proxy.connect") {
          if (
            this.store.configuration.settings.mode !== "manual" &&
            !(await this.native.status()).systemControl
          )
            throw new Error("请先安装并批准已签名的系统辅助服务");
          await this.native.apply(
            compileConfiguration(this.store.configuration),
            this.store.configuration.revision,
            operationId,
            this.store.configuration.settings.mode,
          );
        } else if (method === "proxy.disconnect") {
          await this.native.stop(operationId);
        } else {
          const next = structuredClone(this.store.configuration);
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
            let text: string = payload?.text;
            let sourceId: string | undefined;
            if (method === "subscription.refresh") {
              const sub = next.subscriptions.find((s) => s.id === payload?.id);
              if (!sub) throw new Error("订阅不存在");
              sourceId = sub.id;
              const result = await this.extension(
                "subscription.fetch",
                {
                  url: sub.url,
                },
                signal,
              );
              text = String(result);
            } else if (payload?.url) {
              const url = new URL(payload.url);
              if (url.protocol !== "https:")
                throw new Error("订阅链接必须使用 HTTPS");
              sourceId = randomUUID();
              text = String(
                await this.extension(
                  "subscription.fetch",
                  { url: url.href },
                  signal,
                ),
              );
              next.subscriptions.push({
                id: sourceId,
                name: String(payload.name || "订阅"),
                url: url.href,
                count: 0,
              });
            }
            if (typeof text !== "string")
              throw new Error("请输入订阅链接或配置内容");
            const nodes = (await this.extension(
              "subscription.parse",
              {
                text,
                sourceId,
              },
              signal,
            )) as NodeConfig[];
            if (sourceId) {
              const identity = (n: NodeConfig) =>
                [n.type, n.name, n.server, n.port].join("|");
              const previous = new Map(
                next.nodes
                  .filter((n) => n.sourceId === sourceId)
                  .map((n) => [identity(n), n.id]),
              );
              for (const node of nodes) {
                node.id = previous.get(identity(node)) ?? node.id;
              }
            }
            next.nodes = next.nodes
              .filter((n) => !sourceId || n.sourceId !== sourceId)
              .concat(nodes);
            if (sourceId) {
              const sub = next.subscriptions.find((s) => s.id === sourceId)!;
              sub.updatedAt = new Date().toISOString();
              sub.count = nodes.length;
              delete sub.error;
            }
            if (
              next.settings.selectedNode !== "direct" &&
              !next.nodes.some((n) => n.id === next.settings.selectedNode) &&
              !(next.externalNetworks ?? []).some(
                (n) => n.id === next.settings.selectedNode,
              )
            )
              throw new Error("订阅移除了当前出口，请先选择其他节点再更新");
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
          next.revision = this.store.configuration.revision + 1;
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
  async drain() {
    this.lifecycle = "draining";
    this.networkObserver.stop();
    for (const controller of this.measuring.values()) controller.abort();
    await this.store.drain();
    try {
      await this.reconcileNative();
      if (this.hasUnknownNative())
        throw Object.assign(new Error("原生操作结果尚未明确，已延后更新"), {
          outcome: "unknown",
        });
    } catch (error) {
      this.store.resume();
      this.lifecycle = "ready";
      this.networkObserver.resume();
      throw error;
    }
    await writeHandoff(this.store.directory, {
      version: 1,
      protocol: 1,
      schema: 1,
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
  }
  async stop() {
    await this.drain();
    this.telemetry?.close();
    await this.store.close();
    this.lifecycle = "stopped";
  }
  suspend() {
    this.store.pause();
    this.lifecycle = "draining";
    this.networkObserver.stop();
    for (const controller of this.measuring.values()) controller.abort();
  }
  async resume() {
    await this.store.drain();
    await this.reconcileNative();
    this.networkObserver.resume();
    await this.networkObserver.refresh().catch(() => {});
    this.store.resume();
    this.lifecycle = "ready";
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
