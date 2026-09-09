import { requestTrace } from "../../runtime/src/trace-context";
import { ModuleRuntime, type RuntimeModule } from "../../runtime/src/lifecycle";
import { beforeDeadline } from "../../runtime/src/deadline";
export type ExtensionHandler = (
  payload: any,
  signal: AbortSignal,
) => Promise<unknown> | unknown;
/** Only trusted built-ins enter this registry. Every handler belongs to its module. */
export class ExtensionRuntime {
  readonly modules = new ModuleRuntime();
  private active = new Set<Promise<unknown>>();
  private controller = new AbortController();
  private draining = false;
  async start(
    modules: RuntimeModule[],
    satisfiedDependencies?: ReadonlySet<string>,
  ) {
    await this.modules.activate(modules, satisfiedDependencies);
  }
  async call(method: string, payload?: unknown, signal?: AbortSignal) {
    if (this.draining || this.modules.status !== "ready")
      throw new Error("扩展正在退出");
    const entry = this.modules.entries.find(
      (entry) => entry.kind === "command" && entry.id === method,
    );
    if (!entry || typeof entry.value !== "function")
      throw new Error("未知扩展方法");
    const pending = Promise.resolve().then(() =>
      (entry.value as ExtensionHandler)(
        payload,
        signal
          ? AbortSignal.any([signal, this.controller.signal])
          : this.controller.signal,
      ),
    );
    this.active.add(pending);
    const context = {
      ...requestTrace.getStore(),
      pluginInstance:
        (entry.owner?.id ?? "extension") +
        ":" +
        (process.env.FLOWGATE_EPOCH ?? "local"),
      ...(entry.owner
        ? { moduleVersions: { [entry.owner.id]: entry.owner.version } }
        : {}),
    };
    this.modules.trace.emit(
      entry.owner?.id ?? method,
      "request-start",
      context,
    );
    try {
      const result = await pending;
      this.modules.trace.emit(
        entry.owner?.id ?? method,
        "request-succeeded",
        context,
      );
      return result;
    } catch (error) {
      this.modules.trace.emit(
        entry.owner?.id ?? method,
        "request-failed",
        context,
      );
      throw error;
    } finally {
      this.active.delete(pending);
    }
  }
  async drain(deadline: number) {
    this.draining = true;
    this.controller.abort();
    await beforeDeadline(
      Promise.allSettled([...this.active]),
      deadline,
      "扩展请求",
    );
  }
  async stop() {
    try {
      await this.drain(Date.now() + 5000);
    } finally {
      await beforeDeadline(this.modules.stop(), Date.now() + 5000, "扩展释放");
    }
  }
}
