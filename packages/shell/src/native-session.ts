import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { KernelState, NativePort } from "../../contracts/src/index";
import { PausableTimers, type TimerTicket } from "./pausable-timers";
export class NativeSession implements NativePort {
  private readonly timers = new PausableTimers();
  setSuspended(suspended: boolean) {
    if (suspended) this.timers.pause();
    else this.timers.resume();
  }
  private process?: ChildProcessWithoutNullStreams;
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
  ) {}
  async start() {
    const child = spawn(this.bridge, [this.kernel, this.directory], {
      stdio: "pipe",
    });
    this.process = child;
    createInterface({ input: child.stdout }).on("line", (line) => {
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
        if (data.result?.status) this.state = data.result;
        p.resolve(data.result);
      }
    });
    child.stderr.on("data", () => {});
    const failed = () => {
      if (this.process !== child) return;
      this.process = undefined;
      child.kill();
      this.state = {
        status: "unknown",
        systemControl: false,
        message: "原生桥接失联；禁止新写入",
      };
      for (const p of this.pending.values()) {
        p.timer.cancel();
        p.reject(
          Object.assign(new Error("原生操作结果未知"), { outcome: "unknown" }),
        );
      }
      this.pending.clear();
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
      return await this.call("status");
    } catch {
      return {
        status: "unknown" as const,
        systemControl: false,
        message: "辅助服务状态未知，暂停系统操作",
      };
    }
  }
  apply(
    config: unknown,
    revision: number,
    operationId: string,
    mode = "manual",
  ) {
    return this.call("apply", { config, revision, operationId, mode });
  }
  installHelper() {
    return this.call("helper.install");
  }
  stop(operationId: string) {
    return this.call("stop", { operationId });
  }
  async close() {
    if (this.process) {
      await this.stop(randomUUID());
      this.process?.stdin.end();
    }
  }
}
