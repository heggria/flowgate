import { _electron as electron } from "playwright";
import { createServer, request } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
const directory = await mkdtemp(resolve("work/power-"));
const origin = createServer((_req, res) => res.end("resumed-real-request"));
await new Promise((r) => origin.listen(0, "127.0.0.1", r));
const reserve = createServer();
await new Promise((r) => reserve.listen(0, "127.0.0.1", r));
const proxyPort = reserve.address().port;
await new Promise((r) => reserve.close(r));
const app = await electron.launch({
  args: ["."],
  env: { ...process.env, FLOWGATE_TEST_DATA: directory },
});
try {
  const page = await app.firstWindow();
  await page.getByRole("heading", { name: "概览" }).waitFor({ timeout: 20000 });
  await page.evaluate(async (port) => {
    const snapshot = await window.flowgate.request("snapshot");
    await window.flowgate.request(
      "configuration.save",
      {
        revision: snapshot.configuration.revision,
        rules: snapshot.configuration.rules,
        settings: { ...snapshot.configuration.settings, listenPort: port },
      },
      "power-config",
    );
    await window.flowgate.request("proxy.connect", {}, "power-connect");
  }, proxyPort);
  const before = await page.evaluate(() => window.flowgate.request("snapshot"));
  await app.evaluate(({ powerMonitor }) => powerMonitor.emit("suspend"));
  await assert.rejects(
    page.evaluate(() =>
      window.flowgate.request("proxy.disconnect", {}, "sleep-write"),
    ),
  );
  assert.equal(
    (await page.evaluate(() => window.shell.request("release.status")))
      .suspended,
    true,
  );
  await new Promise((r) => setTimeout(r, 1000));
  await app.evaluate(({ powerMonitor }) => powerMonitor.emit("resume"));
  let resumed = false;
  for (let i = 0; i < 100; i++) {
    if (
      !(await page.evaluate(() => window.shell.request("release.status")))
        .suspended
    ) {
      resumed = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(resumed, true);
  const after = await page.evaluate(() => window.flowgate.request("snapshot"));
  assert.equal(after.lifecycle, "ready");
  assert.equal(after.kernel.pid, before.kernel.pid);
  assert.ok(!after.operations.some((o) => o.id === "sleep-write"));
  const body = await new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port: proxyPort,
        path: `http://127.0.0.1:${origin.address().port}/`,
      },
      (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve(text));
      },
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(body, "resumed-real-request");
  await page.evaluate(() =>
    window.flowgate.request("proxy.disconnect", {}, "power-disconnect"),
  );
  await writeFile(
    "work/power-result.json",
    JSON.stringify(
      {
        passed: true,
        at: new Date().toISOString(),
        scope:
          "injected Electron suspend/resume events; actual manual proxy request; not an OS sleep or privileged test",
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS: suspend admission fence and resume reconciliation with real forwarding",
  );
} finally {
  await app.close();
  await new Promise((r) => origin.close(r));
}
