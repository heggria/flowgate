import type {
  ExtensionDescriptor,
  ExtensionState,
} from "../../contracts/src/extensions";
import type { RuntimeModule } from "../../runtime/src/lifecycle";
import { TraceBuffer } from "../../runtime/src/lifecycle";
import { beforeDeadline } from "../../runtime/src/deadline";
import { requestTrace } from "../../runtime/src/trace-context";
import { ExtensionRuntime } from "./runtime";

interface Entry {
  descriptor: ExtensionDescriptor;
  module: RuntimeModule;
  runtime?: ExtensionRuntime;
  status: ExtensionState["status"];
  enabled: boolean;
  generation: number;
  error?: string;
  unsafe?: boolean;
}
/** A trusted package owns its runtime and pending calls. Disabling it never drains its siblings. */
export class ExtensionManager {
  readonly trace = new TraceBuffer();
  private entries = new Map<string, Entry>();
  private order: string[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private closing = false;
  constructor(
    descriptors: readonly ExtensionDescriptor[],
    modules: RuntimeModule[],
    private readonly identity: {
      epoch: number;
      releaseSet: string;
      version: string;
    },
  ) {
    const methods = new Set<string>();
    for (const descriptor of descriptors) {
      const candidates = modules.filter(
        (module) => module.manifest.id === descriptor.id,
      );
      if (this.entries.has(descriptor.id) || candidates.length !== 1)
        throw new Error("扩展定义重复或实现缺失");
      const module = candidates[0];
      if (
        module.manifest.version !== descriptor.version ||
        module.manifest.api !== 1 ||
        JSON.stringify(module.manifest.dependencies) !==
          JSON.stringify(descriptor.dependencies) ||
        JSON.stringify(module.manifest.capabilities) !==
          JSON.stringify(descriptor.capabilities)
      )
        throw new Error("扩展清单与实现不一致");
      for (const method of descriptor.methods) {
        if (methods.has(method)) throw new Error("扩展命令重复");
        methods.add(method);
      }
      this.entries.set(descriptor.id, {
        descriptor,
        module,
        status: "stopped",
        enabled: false,
        generation: 0,
      });
    }
    if (modules.length !== this.entries.size) throw new Error("存在未声明扩展");
    const visited = new Set<string>(),
      visiting = new Set<string>();
    const visit = (id: string) => {
      if (visiting.has(id)) throw new Error("扩展依赖循环");
      if (visited.has(id)) return;
      const entry = this.entries.get(id);
      if (!entry) throw new Error("扩展依赖缺失");
      visiting.add(id);
      entry.descriptor.dependencies.forEach(visit);
      visiting.delete(id);
      visited.add(id);
      this.order.push(id);
    };
    descriptors.forEach((descriptor) => visit(descriptor.id));
  }
  snapshot(): ExtensionState[] {
    return this.order.map((id) => {
      const entry = this.entries.get(id)!;
      return {
        ...structuredClone(entry.descriptor),
        enabled: entry.enabled,
        desiredEnabled: entry.enabled,
        status: entry.status,
        releaseSet: this.identity.releaseSet,
        instance: entry.generation ? this.instance(entry) : undefined,
        error: entry.error,
      };
    });
  }
  private instance(entry: Entry) {
    return `${entry.descriptor.id}:${this.identity.epoch}:${entry.generation}`;
  }
  private async enable(entry: Entry) {
    if (entry.status === "ready") {
      entry.enabled = true;
      return;
    }
    if (entry.unsafe) throw new Error("扩展释放尚未确认，请重启扩展宿主");
    entry.status = "starting";
    entry.generation++;
    entry.error = undefined;
    const runtime = new ExtensionRuntime();
    entry.runtime = runtime;
    runtime.modules.trace.onChange = () => {
      const event = runtime.modules.trace.snapshot().at(-1)!;
      this.trace.emit(event.name, event.status, {
        ...requestTrace.getStore(),
        ...event.context,
        pluginInstance: this.instance(entry),
        epoch: this.identity.epoch,
        releaseSet: this.identity.releaseSet,
        hostVersion: this.identity.version,
        moduleVersions: { [entry.descriptor.id]: entry.descriptor.version },
      });
    };
    try {
      const dependencies = new Set(
        [...this.entries]
          .filter(([, other]) => other.status === "ready")
          .map(([id]) => id),
      );
      await beforeDeadline(
        runtime.start([entry.module], dependencies),
        Date.now() + 5000,
        "扩展激活",
      );
      if (this.closing) throw new Error("扩展宿主正在退出");
      const methods = runtime.modules.entries
        .map((contribution) => contribution.id)
        .sort();
      if (
        runtime.modules.entries.some(
          (contribution) =>
            !entry.descriptor.contributions.includes(contribution.kind) ||
            (contribution.kind === "command" &&
              typeof contribution.value !== "function"),
        ) ||
        JSON.stringify(methods) !==
          JSON.stringify([...entry.descriptor.methods].sort())
      )
        throw new Error("扩展贡献未匹配清单");
      entry.status = "ready";
      entry.enabled = true;
    } catch (error) {
      entry.status = "failed";
      entry.enabled = false;
      entry.error = "激活失败，请重试；重复失败时可重启扩展宿主。";
      // A timed-out activation can still be executing; don't start another generation beside it.
      if (runtime.modules.status === "starting") entry.unsafe = true;
      try {
        await runtime.stop();
      } catch {
        entry.unsafe = true;
      }
      throw error;
    }
  }
  private async disable(entry: Entry) {
    if (entry.unsafe) throw new Error("扩展资源释放未确认，请重启扩展宿主");
    if (!entry.runtime) {
      entry.enabled = false;
      entry.status = "stopped";
      return;
    }
    entry.status = "draining";
    try {
      await entry.runtime.stop();
      entry.runtime = undefined;
      entry.status = "stopped";
      entry.enabled = false;
      entry.error = undefined;
      entry.unsafe = false;
    } catch (error) {
      entry.status = "failed";
      entry.unsafe = true;
      entry.error = "资源释放未完成，请重启扩展宿主。";
      throw error;
    }
  }
  configure(
    preferences: Record<string, boolean>,
    requiredOnly = false,
  ): Promise<ExtensionState[]> {
    if (this.closing) return Promise.reject(new Error("扩展宿主正在退出"));
    const work = this.queue.then(async () => {
      if (this.closing) throw new Error("扩展宿主正在退出");
      for (const [id, enabled] of Object.entries(preferences)) {
        const entry = this.entries.get(id);
        if (
          !entry ||
          typeof enabled !== "boolean" ||
          (entry.descriptor.required && !enabled)
        )
          throw new Error("未知扩展或核心扩展不能停用");
      }
      const desired = new Set(
        this.order.filter((id) => {
          const descriptor = this.entries.get(id)!.descriptor;
          return (
            descriptor.required ||
            (!requiredOnly && (preferences[id] ?? descriptor.defaultEnabled))
          );
        }),
      );
      for (const id of desired)
        for (const dep of this.entries.get(id)!.descriptor.dependencies) {
          if (!desired.has(dep))
            throw new Error("依赖此扩展的能力仍在启用，请先停用依赖项");
        }
      const before = new Set(
        this.order.filter((id) => this.entries.get(id)!.enabled),
      );
      try {
        for (const id of [...this.order].reverse())
          if (!desired.has(id) && this.entries.get(id)!.enabled)
            await this.disable(this.entries.get(id)!);
        for (const id of this.order)
          if (desired.has(id)) await this.enable(this.entries.get(id)!);
      } catch (error) {
        // Restore the last admitted set without starting over an unconfirmed old generation.
        for (const id of [...this.order].reverse()) {
          const entry = this.entries.get(id)!;
          if (!before.has(id) && entry.enabled)
            await this.disable(entry).catch(() => {});
        }
        for (const id of this.order)
          if (before.has(id))
            await this.enable(this.entries.get(id)!).catch(() => {});
        throw error;
      }
      return this.snapshot();
    });
    this.queue = work.catch(() => {});
    return work;
  }
  async call(method: string, payload?: unknown, signal?: AbortSignal) {
    if (this.closing) throw new Error("扩展宿主正在退出");
    const entry = [...this.entries.values()].find((entry) =>
      entry.descriptor.methods.includes(method),
    );
    if (!entry || entry.status !== "ready" || !entry.runtime)
      throw new Error("扩展未启用或尚未就绪");
    try {
      const result = await entry.runtime.call(method, payload, signal);
      entry.error = undefined;
      return result;
    } catch (error) {
      if (entry.status === "ready" && !signal?.aborted)
        entry.error = "最近一次调用失败，可在操作记录中查看相关追踪。";
      throw error;
    }
  }
  async inspectNetwork(signal?: AbortSignal) {
    const system = (await this.call(
      "network.inspect",
      undefined,
      signal,
    )) as object;
    const candidates = this.snapshot().filter(
      (entry) =>
        entry.status === "ready" &&
        entry.methods.some((method) => method.startsWith("diagnostic.")),
    );
    const reports = await Promise.allSettled(
      candidates.map((entry) => this.call(entry.methods[0], undefined, signal)),
    );
    const plugins = reports.flatMap((result, index) => {
      if (this.entries.get(candidates[index].id)?.status !== "ready") return [];
      return result.status === "fulfilled"
        ? [result.value]
        : [
            {
              id: candidates[index].id,
              name: candidates[index].name,
              installed: false,
              running: null,
              detail: "诊断失败或已取消",
            },
          ];
    });
    return { ...system, plugins };
  }
  async drain(deadline: number) {
    this.closing = true;
    await beforeDeadline(this.queue, deadline, "扩展切换");
    await beforeDeadline(
      Promise.all(
        [...this.entries.values()].map(async (entry) => {
          if (!entry.runtime) return;
          entry.status = "draining";
          await entry.runtime.drain(deadline);
        }),
      ),
      deadline,
      "扩展排空",
    );
  }
  async stop() {
    this.closing = true;
    await this.queue;
    const failures: unknown[] = [];
    for (const id of [...this.order].reverse())
      try {
        await this.disable(this.entries.get(id)!);
      } catch (error) {
        failures.push(error);
      }
    if (failures.length) throw failures[0];
  }
}
