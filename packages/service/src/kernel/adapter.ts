import type {
  Configuration,
  NativePort,
  TraceContext,
} from "../../../contracts/src/index";
import catalog from "../../../contracts/src/service-catalog.json";
import { compileConfiguration } from "../../../domain/src/configuration";
import {
  ModuleRuntime,
  TraceBuffer,
  type RuntimeModule,
} from "../../../runtime/src/lifecycle";
import { requestTrace } from "../../../runtime/src/trace-context";
import { beforeDeadline } from "../../../runtime/src/deadline";
export const kernelDescriptor = catalog[0];
/** Trusted Service module. Binary installation and system ownership stay in the fixed native layer. */
export function singBoxAdapter(native: NativePort): RuntimeModule {
  return {
    manifest: {
      id: kernelDescriptor.id,
      version: kernelDescriptor.version,
      api: 1,
      dependencies: [],
      capabilities: [],
    },
    async activate(context) {
      const methods: Record<string, (value: any) => unknown> = {
        compile: (configuration: Configuration) =>
          compileConfiguration(configuration),
        status: () => native.status(),
        control: () => native.control?.() ?? Promise.resolve(null),
        apply: ({ config, revision, operationId, mode }) =>
          native.apply(config, revision, operationId, mode),
        disconnect: ({ operationId }) => native.stop(operationId),
      };
      for (const [name, value] of Object.entries(methods))
        context.contribute({ id: "kernel." + name, kind: "command", value });
      // Disposing a Service module releases its bindings, never the helper-owned data plane.
    },
  };
}
export class KernelRuntime implements NativePort {
  readonly modules: ModuleRuntime;
  private calls = new Set<Promise<unknown>>();
  private accepting = false;
  constructor(
    private readonly adapter: RuntimeModule,
    private readonly identity: () => TraceContext,
  ) {
    this.modules = new ModuleRuntime(new TraceBuffer(), identity);
  }
  async start() {
    await this.modules.activate([this.adapter]);
    for (const name of [
      "compile",
      "status",
      "control",
      "apply",
      "disconnect",
    ]) {
      if (
        typeof this.modules.entries.find(
          (e) => e.id === "kernel." + name && e.kind === "command",
        )?.value !== "function"
      ) {
        await this.modules.stop();
        throw new Error("内核适配器能力不完整");
      }
    }
    this.accepting = true;
  }
  snapshot() {
    return {
      id: this.adapter.manifest.id,
      name:
        this.adapter.manifest.id === kernelDescriptor.id
          ? kernelDescriptor.name
          : this.adapter.manifest.id,
      version: this.adapter.manifest.version,
      status: this.modules.status,
    };
  }
  private async call<T>(
    name: string,
    payload?: unknown,
    write = false,
  ): Promise<T> {
    if (this.modules.status !== "ready" || (write && !this.accepting))
      throw new Error("内核适配器正在退出");
    const entry = this.modules.entries.find((e) => e.id === "kernel." + name)!;
    const context = {
      ...this.identity(),
      ...requestTrace.getStore(),
      pluginInstance: entry.owner?.instance,
      moduleVersions: {
        [this.adapter.manifest.id]: this.adapter.manifest.version,
      },
    };
    const tracked = !["status", "control"].includes(name);
    if (tracked) this.modules.trace.emit(entry.id, "request-start", context);
    const pending = requestTrace.run(context, () =>
      Promise.resolve().then(() =>
        (entry.value as (value: unknown) => T)(payload),
      ),
    );
    this.calls.add(pending);
    try {
      const result = await pending;
      if (tracked)
        this.modules.trace.emit(entry.id, "request-succeeded", context);
      return result;
    } catch (error) {
      if (tracked) this.modules.trace.emit(entry.id, "request-failed", context);
      throw error;
    } finally {
      this.calls.delete(pending);
    }
  }
  compile(configuration: Configuration) {
    return this.call<unknown>("compile", configuration);
  }
  status(): ReturnType<NativePort["status"]> {
    return this.call("status");
  }
  control(): Promise<{ endpoint: string; secret: string } | null> {
    return this.call("control");
  }
  apply(
    ...[config, revision, operationId, mode]: Parameters<NativePort["apply"]>
  ): ReturnType<NativePort["apply"]> {
    return this.call("apply", { config, revision, operationId, mode }, true);
  }
  stop(operationId: string): ReturnType<NativePort["stop"]> {
    return this.call("disconnect", { operationId }, true);
  }
  async drain(deadline: number) {
    this.accepting = false;
    try {
      await beforeDeadline(
        Promise.allSettled([...this.calls]),
        deadline,
        "内核适配器",
      );
    } catch (error) {
      this.modules.trace.emit(this.adapter.manifest.id, "timeout", {
        ...this.identity(),
        pluginInstance: this.modules.entries[0]?.owner?.instance,
        moduleVersions: {
          [this.adapter.manifest.id]: this.adapter.manifest.version,
        },
      });
      throw error;
    }
  }
  resume() {
    if (this.modules.status === "ready") this.accepting = true;
  }
  async dispose() {
    await this.drain(Date.now() + 5000);
    await this.modules.stop();
  }
}
