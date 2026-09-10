import { Worker } from "node:worker_threads";
import type {
  SubscriptionDocument,
  SubscriptionParseOptions,
} from "../../../contracts/src/subscriptions";
import { SUBSCRIPTION_LIMITS } from "../../../contracts/src/subscriptions";

/** Workers load the same verified extension artifact; no separate executable is admitted. */
export class SubscriptionWorkers {
  private stopped = false;
  private active = new Map<Worker, () => void>();
  constructor(
    private readonly filename: string | URL,
    private readonly timeout: number = SUBSCRIPTION_LIMITS.parseMs,
  ) {}
  parse(
    text: string,
    options: SubscriptionParseOptions,
    signal: AbortSignal,
  ): Promise<SubscriptionDocument> {
    if (this.stopped || signal.aborted)
      return Promise.reject(new Error("订阅解析已取消"));
    if (this.active.size >= 2)
      return Promise.reject(new Error("已有订阅正在解析，请稍后重试"));
    if (
      typeof text !== "string" ||
      Buffer.byteLength(text) > SUBSCRIPTION_LIMITS.bytes
    )
      return Promise.reject(new Error("订阅超过 4 MB 限制"));
    return new Promise((resolve, reject) => {
      const worker = new Worker(this.filename, {
        execArgv: [],
        workerData: { kind: "subscription-parser", text, options },
        resourceLimits: {
          maxOldGenerationSizeMb: 96,
          maxYoungGenerationSizeMb: 16,
          stackSizeMb: 4,
        },
      });
      let settled = false;
      const finish = (error?: Error, result?: SubscriptionDocument) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
        // Keep the slot occupied until the thread has really exited.
        void worker.terminate().finally(() => this.active.delete(worker));
        if (error) reject(error);
        else resolve(result!);
      };
      const cancel = () => finish(new Error("订阅解析已取消"));
      const timer = setTimeout(
        () => finish(new Error("订阅解析超时，原配置未改变")),
        this.timeout,
      );
      timer.unref();
      this.active.set(worker, cancel);
      signal.addEventListener("abort", cancel, { once: true });
      worker.once("message", (message) =>
        message?.error
          ? finish(new Error("订阅解析失败，请检查格式或转换选项"))
          : message?.result?.version === 2
            ? finish(undefined, message.result)
            : finish(new Error("订阅解析返回无效结果")),
      );
      worker.once("error", () => finish(new Error("订阅解析工作线程失败")));
      worker.once("exit", (code) => {
        this.active.delete(worker);
        if (!settled)
          finish(
            new Error(code ? "订阅解析工作线程异常退出" : "订阅解析未返回结果"),
          );
      });
      if (signal.aborted) cancel();
    });
  }
  async dispose() {
    this.stopped = true;
    const workers = [...this.active];
    for (const [, cancel] of workers) cancel();
    await Promise.allSettled(workers.map(([worker]) => worker.terminate()));
    this.active.clear();
  }
}
