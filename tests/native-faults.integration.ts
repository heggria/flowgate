import { NativeSession } from "../packages/shell/src/native-session";
import {
  initialConfiguration,
  compileConfiguration,
} from "../packages/domain/src/configuration";
import { mkdtemp, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createServer, connect } from "node:net";
import assert from "node:assert/strict";
const dir = await mkdtemp(resolve("work/native-faults-"));
const probe = createServer();
await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
const port = (probe.address() as any).port;
await new Promise<void>((r) => probe.close(() => r()));
const native = new NativeSession(
  resolve("dist/flowgate-bridge"),
  resolve("dist/sing-box"),
  dir,
);
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function wait(test: () => Promise<boolean> | boolean) {
  for (let i = 0; i < 120; i++) {
    if (await test()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("fault recovery timeout");
}
try {
  await native.start();
  const config = initialConfiguration();
  config.settings.listenPort = port;
  const first = await native.apply(
    compileConfiguration(config),
    1,
    "kernel-fault",
  );
  process.kill(first.pid!, "SIGKILL");
  await wait(async () => (await native.status()).status === "failed");
  const second = await native.apply(
    compileConfiguration(config),
    2,
    "bridge-fault",
  );
  const bridgePID = (native as any).process.pid;
  await new Promise((r) => setTimeout(r, 300));
  process.kill(bridgePID, "SIGKILL");
  await wait(async () => (await native.status()).status === "unknown");
  await assert.rejects(() =>
    native.apply(compileConfiguration(config), 3, "must-reject"),
  );
  await wait(() => !alive(second.pid!));
  const bound = createServer();
  await new Promise<void>((resolve, reject) => {
    bound.once("error", reject);
    bound.listen(port, "127.0.0.1", resolve);
  });
  await new Promise<void>((r) => bound.close(() => r()));
  await writeFile(
    join("work", "native-faults-result.json"),
    JSON.stringify(
      {
        passed: true,
        at: new Date().toISOString(),
        checks: [
          "kernel SIGKILL reported as failed",
          "explicit restart recovers",
          "bridge SIGKILL reports unknown and rejects writes",
          "independent watchdog terminates orphan kernel",
          "owned port released",
        ],
        scope: "manual mode only; no global network changes",
      },
      null,
      2,
    ),
  );
  console.log("PASS: actual kernel and bridge SIGKILL recovery");
} finally {
  await native.close();
}
