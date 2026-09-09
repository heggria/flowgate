import { fork } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
const child = fork("dist/internal/gateway.mjs", [], {
  env: { ...process.env, FLOWGATE_MODEL_TOKEN: "internal-model-token" },
  stdio: ["ignore", "ignore", "pipe", "ipc"],
});
let stderr = "";
child.stderr?.on("data", (b) => (stderr += b));
function call(method: string) {
  return new Promise<any>((resolve, reject) => {
    const id = randomUUID();
    const timeout = setTimeout(() => {
      child.off("message", handler);
      reject(new Error("Gateway control timeout " + stderr));
    }, 6000);
    const handler = (message: any) => {
      if (message.id !== id) return;
      clearTimeout(timeout);
      child.off("message", handler);
      if (message.error) reject(new Error(message.error));
      else resolve(message.result);
    };
    child.on("message", handler);
    child.send({ id, method });
  });
}
try {
  const [ready] = (await Promise.race([
    once(child, "message", { signal: AbortSignal.timeout(10000) }),
    once(child, "exit").then(() => {
      throw new Error("Gateway exited before ready: " + stderr);
    }),
  ])) as any[];
  assert.equal(ready.type, "ready");
  const response = await fetch(`http://127.0.0.1:${ready.port}/v1/mock`, {
    method: "POST",
    headers: { authorization: "Bearer internal-model-token" },
  });
  const draining = call("drain");
  const text = await response.text();
  await draining;
  assert.match(text, /tool.delta/);
  assert.match(text, /unknown.event/);
  const status = await call("status");
  assert.equal(status.ledger.length, 1);
  assert.equal(status.ledger[0].state, "unknown");
  await call("stop");
  await writeFile(
    "work/gateway-result.json",
    JSON.stringify(
      {
        passed: true,
        at: new Date().toISOString(),
        checks: [
          "independent process",
          "direct HTTP stream",
          "explicit mock egress",
          "tool JSON fragments",
          "stream error preserved",
          "drain waits without replay",
          "unknown usage retained",
        ],
      },
      null,
      2,
    ),
  );
  console.log("PASS: independent gateway capability lifecycle");
} finally {
  child.kill();
}
