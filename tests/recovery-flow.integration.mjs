import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { isolateProxyPort } from "./proxy-fixture.mjs";
const data = await mkdtemp(resolve("work/recovery-flow-"));
await mkdir(join(data, "business"), { mode: 0o700 });
await writeFile(
  join(data, "business/state.json"),
  JSON.stringify({
    configuration: {
      schema: 2,
      revision: 0,
      nodes: [],
      subscriptions: [],
      rules: [],
      settings: {
        mode: "manual",
        listenPort: 17890,
        selectedNode: "direct",
        finalOutbound: "select",
        dnsServer: "https://1.1.1.1/dns-query",
        autoConnect: false,
      },
    },
    operations: [
      {
        id: "uncertain",
        kind: "proxy.connect",
        state: "pending",
        revision: 0,
        nativeMode: "manual",
        traceId: "fixture",
        startedAt: new Date().toISOString(),
        message: "原生操作超时，结果未知",
      },
    ],
  }),
  { mode: 0o600 },
);
const app = await electron.launch({
  args: ["."],
  env: { ...process.env, FLOWGATE_TEST_DATA: data, FLOWGATE_TEST_VISIBLE: "0" },
});
try {
  const page = await app.firstWindow();
  await page.getByRole("heading", { name: "概览", exact: true }).waitFor();
  assert.equal(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some(
        (w) => w.isVisible() || w.isFocused() || w.isFocusable(),
      ),
    ),
    false,
  );
  const refused = await page.evaluate(async () => {
    try {
      await window.flowgate.request("proxy.connect", {}, crypto.randomUUID());
      return false;
    } catch {
      return true;
    }
  });
  assert.equal(refused, true);
  await page.getByRole("button", { name: "问题与恢复", exact: true }).click();
  await page
    .getByRole("button", { name: "断开并重新核对", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "暂无待处理问题", exact: true })
    .waitFor();
  const snapshot = await page.evaluate(() =>
    window.flowgate.request("snapshot"),
  );
  assert.equal(snapshot.kernel.status, "stopped");
  assert.equal(
    snapshot.operations.find((o) => o.id === "uncertain").state,
    "failed",
  );
  assert.equal(
    snapshot.operations.find((o) => o.id === "uncertain").recoveredBy,
    "recovery-disconnect",
  );
  await isolateProxyPort(page);
  await page.getByRole("button", { name: "启动代理", exact: true }).click();
  await page.getByRole("button", { name: "停止代理", exact: true }).waitFor();
  await page.getByRole("button", { name: "停止代理", exact: true }).click();
  console.log(
    "PASS actual Service/native/UI: unknown result fences connect; explicit disconnect reconciles durable record; reconnect succeeds without clearing user data",
  );
} finally {
  await app.close();
}
