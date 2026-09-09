import { parentPort, workerData } from "node:worker_threads";
import { verifyDirectory } from "./loader";
void verifyDirectory(workerData.directory, workerData.manifest).then(
  () => parentPort!.postMessage({ ok: true }),
  (error) =>
    parentPort!.postMessage({
      ok: false,
      message: error instanceof Error ? error.message : "版本验证失败",
    }),
);
