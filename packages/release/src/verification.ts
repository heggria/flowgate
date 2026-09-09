import { Worker } from "node:worker_threads";
import type { ReleaseSet } from "../../contracts/src/index";
export function supervisedVerification(entry: string, timeout = 30000) {
  return (directory: string, manifest: ReleaseSet): Promise<ReleaseSet> =>
    new Promise((resolve, reject) => {
      const worker = new Worker(entry, {
        workerData: { directory, manifest },
        resourceLimits: { maxOldGenerationSizeMb: 128 },
      });
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void worker.terminate();
        if (error) reject(error);
        else resolve(manifest);
      };
      const timer = setTimeout(
        () => finish(new Error("版本验证超时")),
        timeout,
      );
      worker.once("message", (message) =>
        finish(
          message?.ok === true
            ? undefined
            : new Error(message?.message ?? "版本验证失败"),
        ),
      );
      worker.once("error", finish);
      worker.once("exit", () => finish(new Error("版本验证进程提前退出")));
    });
}
