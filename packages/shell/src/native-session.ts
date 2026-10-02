import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { KernelState, NativePort } from "../../contracts/src/index";
import { PausableTimers, type TimerTicket } from "./pausable-timers";
export class NativeSession implements NativePort {
  private readonly timers = new PausableTimers();
  private suspended = false;
  private closing = false;
  private starting?: Promise<void>;
  private recovery?: Promise<KernelState>;
  private closePromise?: Promise<void>;
  private recoveryRequired = false;
  private requiresSystemControl = false;
  setSuspended(suspended: boolean) {
    this.suspended = suspended;
    if (suspended) this.timers.pause();
    else this.timers.resume();
  }
  private process?: ChildProcessWithoutNullStreams;
  private retiring?: ChildProcessWithoutNullStreams;
  private pending = new Map<
    string,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      timer: TimerTicket;
    }
  >();
  private state: KernelState = {
    status: "stopped",
    systemControl: false,
    message: "原生桥接尚未启动",
  };
  constructor(
    readonly bridge: string,
    readonly kernel: string,
    readonly directory: string,
    readonly allowSystemHelper = false,
  ) {}
  start(): Promise<void> {
    if (this.closing) return Promise.reject(new Error("原生会话正在关闭"));
    if (this.starting) return this.starting;
    if (this.process) return Promise.resolve();
    this.starting = this.open().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }
  private async open() {
    await this.waitForRetirement();
    if (this.closing) throw new Error("原生会话正在关闭");
    if (this.suspended) throw new Error("原生会话已暂停");
    const child = spawn(this.bridge, [this.kernel, this.directory], {
      stdio: "pipe",
      env: {
        ...process.env,
        FLOWGATE_DISABLE_SYSTEM_HELPER: this.allowSystemHelper ? "0" : "1",
      },
    });
    this.process = child;
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (this.process !== child) return;
      let data: any;
      try {
        data = JSON.parse(line);
      } catch {
        return;
      }
      const p = this.pending.get(data.id);
      if (!p) return;
      p.timer.cancel();
      this.pending.delete(data.id);
      if (data.error) p.reject(new Error(data.error));
      else {
        if (data.result?.status) {
          this.state = data.result;
          if (data.result.systemControl) this.requiresSystemControl = true;
        }
        p.resolve(data.result);
      }
    });
    child.stderr.on("data", () => {});
    const failed = () => {
      if (this.process !== child) return;
      this.retire(child, "原生桥接失联；禁止新写入");
      child.kill();
    };
    child.stdin.on("error", failed);
    child.on("error", failed);
    child.on("exit", failed);
    try {
      await this.call("status");
    } catch {
      /* UI exposes unavailable state; no fallback writes. */
    }
  }
  private retire(child: ChildProcessWithoutNullStreams, message: string) {
    if (this.process !== child) return;
    this.process = undefined;
    this.retiring = child;
    this.recoveryRequired = true;
    this.state = { status: "unknown", systemControl: false, message };
    for (const pending of this.pending.values()) {
      pending.timer.cancel();
      pending.reject(
        Object.assign(new Error("原生操作结果未知"), { outcome: "unknown" }),
      );
    }
    this.pending.clear();
  }
  private async waitForRetirement() {
    const child = this.retiring;
    if (!child) return;
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve, reject) => {
        let graceful: ReturnType<typeof setTimeout>;
        let deadline: ReturnType<typeof setTimeout>;
        const finish = (error?: Error) => {
          clearTimeout(graceful);
          clearTimeout(deadline);
          child.removeListener("exit", exited);
          if (error) reject(error);
          else resolve();
        };
        const exited = () => finish();
        const unknown = () =>
          finish(
            Object.assign(new Error("旧原生桥接尚未确认退出，恢复结果未知"), {
              outcome: "unknown",
            }),
          );
        child.once("exit", exited);
        // EOF cleanup can still write the manual journal. Give it time to finish,
        // then force termination and require an actual exit before a new writer.
        graceful = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            unknown();
          }
        }, 6000);
        deadline = setTimeout(unknown, 8000);
      });
    }
    if (this.retiring === child) this.retiring = undefined;
  }
  private call<T = KernelState>(method: string, payload?: unknown): Promise<T> {
    if (!this.process) return Promise.reject(new Error("原生桥接不可用"));
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = this.timers.timeout(() => {
        this.pending.delete(id);
        reject(
          Object.assign(new Error("原生操作超时，结果未知"), {
            outcome: "unknown",
          }),
        );
      }, 12000);
      this.pending.set(id, { resolve, reject, timer });
      this.process!.stdin.write(JSON.stringify({ id, method, payload }) + "\n");
    });
  }
  control() {
    return this.process
      ? this.call<{ endpoint: string; secret: string } | null>("control")
      : Promise.resolve(null);
  }
  async status() {
    if (!this.process) return this.state;
    try {
      const state = await this.call<KernelState>("status");
      return this.recoveryRequired || this.recovery
        ? {
            ...state,
            status: "unknown" as const,
            message: "原生桥接已重建；请完成紧急断开以核实旧连接恢复",
          }
        : state;
    } catch {
      return {
        status: "unknown" as const,
        systemControl: false,
        message: "辅助服务状态未知，暂停系统操作",
      };
    }
  }
  async apply(
    config: unknown,
    revision: number,
    operationId: string,
    mode = "manual",
  ) {
    if (
      this.closing ||
      this.suspended ||
      this.recovery ||
      this.recoveryRequired
    )
      throw Object.assign(new Error("原生会话暂停、关闭或恢复中，禁止新连接"), {
        outcome: "unknown",
      });
    const previous = this.requiresSystemControl;
    if (mode !== "manual") this.requiresSystemControl = true;
    try {
      return await this.call("apply", { config, revision, operationId, mode });
    } catch (error) {
      if ((error as any).outcome !== "unknown")
        this.requiresSystemControl = previous;
      throw error;
    }
  }
  helperInfo() {
    return this.call("helper.info");
  }
  resetHelper() {
    return this.call("helper.reset");
  }
  installHelper() {
    return this.call("helper.install");
  }
  stop(operationId: string) {
    if (this.recovery) return Promise.reject(new Error("原生恢复正在进行"));
    return this.call("stop", { operationId });
  }
  recoverStop(operationId: string): Promise<KernelState> {
    if (this.closing) return Promise.reject(new Error("原生会话正在关闭"));
    if (this.suspended) return Promise.reject(new Error("原生会话已暂停"));
    if (this.recovery) return this.recovery;
    this.recovery = Promise.resolve()
      .then(async () => {
        await this.start();
        if (this.closing) throw new Error("原生会话正在关闭");
        if (this.suspended) throw new Error("原生会话已暂停");
        const state = await this.call<KernelState>("stop", { operationId });
        if (
          state.status !== "stopped" ||
          state.operationId !== operationId ||
          (this.requiresSystemControl && !state.systemControl)
        ) {
          this.recoveryRequired = true;
          throw Object.assign(
            new Error("原生恢复结果未明确，不能确认旧连接已停止"),
            { outcome: "unknown" },
          );
        }
        this.recoveryRequired = false;
        this.requiresSystemControl = false;
        return state;
      })
      .finally(() => {
        this.recovery = undefined;
      });
    return this.recovery;
  }
  close(): Promise<void> {
    this.closing = true;
    this.timers.resume();
    this.closePromise ??= this.finishClose().catch((error) => {
      // The application cancels quitting on cleanup failure. Keep writes fenced
      // until explicit recovery, but permit that recovery and a later close.
      this.recoveryRequired = true;
      this.closing = false;
      this.closePromise = undefined;
      throw error;
    });
    return this.closePromise;
  }
  private async finishClose() {
    await this.recovery?.catch(() => {});
    await this.starting?.catch(() => {});
    const child = this.process;
    let failure: { error: unknown } | undefined;
    if (child) {
      try {
        await this.call("stop", { operationId: randomUUID() });
      } catch (error) {
        failure = { error };
      }
      // EOF releases the bridge/helper lease even when stop reports that
      // owned system cleanup still needs recovery. Detach before late responses.
      this.retire(child, "原生桥接已关闭；请显式恢复并核实旧连接");
      try {
        child.stdin.end();
      } catch (error) {
        failure ??= { error };
      }
    }
    try {
      // A retry can have no active child but still have a retiring journal writer.
      await this.waitForRetirement();
    } catch (error) {
      failure ??= { error };
    }
    if (failure) throw failure.error;
  }
}
