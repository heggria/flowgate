import { requestTrace } from "../../runtime/src/trace-context";
import { TraceBuffer } from "../../runtime/src/lifecycle";
import { BUILD_VERSION } from "../../contracts/src/version";
import { utilityProcess } from "electron";
import { randomUUID } from "node:crypto";
import type { RpcResponse } from "../../contracts/src/index";
import { PausableTimers, type TimerTicket } from "./pausable-timers";
let nextEpoch = Date.now();
export class ProcessSupervisor {
  static readonly trace = new TraceBuffer(1000);
  epoch = 0;
  private child?: Electron.UtilityProcess;
  private session = "";
  private failures: number[] = [];
  private stopping = false;
  private suspended = false;
  private readonly timers = new PausableTimers();
  private heartbeat?: NodeJS.Timeout;
  private heartbeatRequest?: AbortController;
  setSuspended(suspended: boolean) {
    this.suspended = suspended;
    this.notifyPower();
    if (suspended) {
      this.timers.pause();
      this.stopHeartbeat();
    } else {
      this.timers.resume();
      if (this.child) this.watchHealth(this.child);
    }
  }
  private notifyPower() {
    try {
      this.child?.postMessage({
        type: "power",
        protocol: 1,
        epoch: this.epoch,
        session: this.session,
        suspended: this.suspended,
      });
    } catch {
      /* A concurrently exiting host is reconciled by its exit handler. */
    }
  }
  private stopHeartbeat() {
    clearTimeout(this.heartbeat);
    this.heartbeat = undefined;
    this.heartbeatRequest?.abort();
    this.heartbeatRequest = undefined;
  }
  private watchHealth(child: Electron.UtilityProcess) {
    clearTimeout(this.heartbeat);
    if (this.suspended || this.stopping || this.child !== child) return;
    this.heartbeat = setTimeout(async () => {
      const controller = new AbortController();
      this.heartbeatRequest = controller;
      try {
        await this.call(
          "health",
          undefined,
          undefined,
          controller.signal,
          5000,
        );
      } catch {
        if (!this.suspended && !this.stopping && this.child === child) {
          ProcessSupervisor.trace.emit(this.name, "unresponsive", {
            epoch: this.epoch,
            releaseSet: this.environment.FLOWGATE_RELEASE ?? "bundled",
          });
          child.kill();
        }
      } finally {
        if (this.heartbeatRequest === controller)
          this.heartbeatRequest = undefined;
        if (this.child === child) this.watchHealth(child);
      }
    }, 5000);
    this.heartbeat.unref();
  }
  private capabilityRequests = new Map<string, AbortController>();
  private pending = new Map<
    string,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      timer: TimerTicket;
      cleanup: () => void;
    }
  >();
  onSnapshot: (snapshot: unknown) => void = () => {};
  onFault: (error: Error) => void = () => {};
  onCapability: (
    method: string,
    payload: unknown,
    signal?: AbortSignal,
  ) => Promise<unknown> = async () => {
    throw new Error("Capability denied");
  };
  constructor(
    readonly name: string,
    public entry: string,
    readonly environment: Record<string, string> = {},
  ) {}
  async start() {
    this.stopHeartbeat();
    this.stopping = false;
    this.epoch = ++nextEpoch;
    this.session = randomUUID();
    ProcessSupervisor.trace.emit(this.name, "starting", {
      epoch: this.epoch,
      releaseSet: this.environment.FLOWGATE_RELEASE ?? "bundled",
      hostVersion: this.environment.FLOWGATE_HOST_VERSION ?? BUILD_VERSION,
    });
    const child = utilityProcess.fork(this.entry, [], {
      serviceName: "FlowGate " + this.name,
      env: {
        ...process.env,
        ...this.environment,
        FLOWGATE_SESSION: this.session,
        FLOWGATE_EPOCH: String(this.epoch),
      },
    });
    this.child = child;
    this.notifyPower();
    child.on("message", async (data: any) => {
      if (data.epoch !== this.epoch) return;
      if (data.type === "trace" && data.session === this.session) {
        const event = data.event;
        if (
          event &&
          typeof event.name === "string" &&
          typeof event.status === "string" &&
          event.context &&
          JSON.stringify(event).length <= 16384
        )
          ProcessSupervisor.trace.emit(event.name, event.status, event.context);
        return;
      }
      if (data.type === "snapshot" && data.session === this.session) {
        this.onSnapshot(data.snapshot);
        return;
      }
      if (data.type === "capability.cancel" && data.session === this.session) {
        this.capabilityRequests.get(data.id)?.abort();
        return;
      }
      if (data.type === "capability") {
        if (data.session !== this.session) return;
        const controller = new AbortController();
        this.capabilityRequests.set(data.id, controller);
        try {
          const result = await requestTrace.run(data.context, async () => {
            ProcessSupervisor.trace.emit(
              this.name + ":" + data.method,
              "starting",
              data.context,
            );
            try {
              const value = await this.onCapability(
                data.method,
                data.payload,
                controller.signal,
              );
              ProcessSupervisor.trace.emit(
                this.name + ":" + data.method,
                "succeeded",
                data.context,
              );
              return value;
            } catch (error) {
              ProcessSupervisor.trace.emit(
                this.name + ":" + data.method,
                "failed",
                data.context,
              );
              throw error;
            }
          });
          if (this.child === child)
            child.postMessage({
              type: "capability.result",
              id: data.id,
              result,
            });
        } catch (error) {
          if (this.child === child)
            child.postMessage({
              type: "capability.result",
              id: data.id,
              error: {
                message:
                  error instanceof Error ? error.message : "Capability failed",
                outcome: (error as any).outcome ?? "failed",
              },
            });
        } finally {
          this.capabilityRequests.delete(data.id);
        }
        return;
      }
      if (data.protocol !== 1 || typeof data.id !== "string") return;
      const p = this.pending.get(data.id);
      if (!p) return;
      p.timer.cancel();
      p.cleanup();
      this.pending.delete(data.id);
      if (data.error)
        p.reject(
          Object.assign(new Error(data.error.message), {
            outcome: data.error.outcome,
          }),
        );
      else p.resolve(data.result);
    });
    child.on("exit", () => {
      if (this.child !== child) return;
      this.stopHeartbeat();
      this.child = undefined;
      ProcessSupervisor.trace.emit(
        this.name,
        this.stopping ? "stopped" : "failed",
        {
          epoch: this.epoch,
          releaseSet: this.environment.FLOWGATE_RELEASE ?? "bundled",
        },
      );
      for (const p of this.pending.values()) {
        p.timer.cancel();
        p.cleanup();
        p.reject(
          Object.assign(new Error("服务退出，操作结果待核实"), {
            outcome: "unknown",
          }),
        );
      }
      this.pending.clear();
      for (const controller of this.capabilityRequests.values())
        controller.abort();
      this.capabilityRequests.clear();
      if (!this.stopping) this.onFault(new Error(this.name + " exited"));
    });
    const health = await this.call("health");
    this.watchHealth(child);
    ProcessSupervisor.trace.emit(this.name, "ready", {
      epoch: this.epoch,
      releaseSet: this.environment.FLOWGATE_RELEASE ?? "bundled",
    });
    return health;
  }
  canRestart() {
    const now = Date.now();
    this.failures = this.failures.filter((t) => now - t < 60000);
    if (this.failures.length >= 3) return false;
    this.failures.push(now);
    return true;
  }
  resetRestartBudget() {
    this.failures = [];
  }
  call<T = unknown>(
    method: string,
    payload?: unknown,
    operationId?: string,
    signal?: AbortSignal,
    timeoutMs = 30000,
  ): Promise<T> {
    if (!this.child) return Promise.reject(new Error("服务未就绪"));
    if (signal?.aborted) return Promise.reject(new Error("请求已取消"));
    const child = this.child;
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const context = {
        ...(requestTrace.getStore() ?? {
          operationId: operationId ?? id,
          traceId: randomUUID().replaceAll("-", ""),
          configRevision: -1,
          releaseSet: this.environment.FLOWGATE_RELEASE ?? "bundled",
          serviceVersion: BUILD_VERSION,
        }),
        epoch: this.epoch,
        shellVersion: BUILD_VERSION,
        protocolVersion: 1,
        schemaVersion: 1,
      };
      const tracked = !["snapshot", "health", "status"].includes(method);
      if (tracked)
        ProcessSupervisor.trace.emit(
          this.name + ":" + method,
          "starting",
          context,
        );
      const succeed = (value: T) => {
        if (tracked)
          ProcessSupervisor.trace.emit(
            this.name + ":" + method,
            "succeeded",
            context,
          );
        resolve(value);
      };
      const fail = (error: Error) => {
        if (tracked)
          ProcessSupervisor.trace.emit(
            this.name + ":" + method,
            "failed",
            context,
          );
        reject(error);
      };
      const cleanup = () => signal?.removeEventListener("abort", abort);
      const cancel = (message: string) => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        timer.cancel();
        cleanup();
        if (this.child === child)
          child.postMessage({
            type: "cancel",
            protocol: 1,
            id,
            epoch: this.epoch,
            session: this.session,
          });
        fail(Object.assign(new Error(message), { outcome: "unknown" }));
      };
      const abort = () => cancel("请求已取消；已提交操作的结果仍需核对");
      const timer = this.timers.timeout(
        () => cancel("请求超时，操作结果未知"),
        timeoutMs,
      );
      this.pending.set(id, { resolve: succeed, reject: fail, timer, cleanup });
      signal?.addEventListener("abort", abort, { once: true });
      child.postMessage({
        protocol: 1,
        id,
        epoch: this.epoch,
        session: this.session,
        method,
        payload,
        operationId,
        context,
      });
    });
  }

  async stop(graceful = true) {
    this.stopHeartbeat();
    this.stopping = true;
    ProcessSupervisor.trace.emit(this.name, "draining", {
      epoch: this.epoch,
      releaseSet: this.environment.FLOWGATE_RELEASE ?? "bundled",
    });
    const child = this.child;
    if (!child) return;
    let failure: unknown;
    try {
      if (graceful) {
        await this.call("drain");
        await this.call("stop");
      }
    } catch (error) {
      failure = error;
    }
    if (this.child === child)
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("宿主退出超时")), 5000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        child.kill();
      });
    if (failure) throw failure;
  }
}
