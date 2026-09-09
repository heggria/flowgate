import { _electron as electron } from "playwright";
import { createServer } from "node:https";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
const work = await mkdtemp(resolve("work/cancel-"));
const config = join(work, "openssl.cnf"),
  key = join(work, "server.key"),
  cert = join(work, "server.crt");
await writeFile(
  config,
  "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n",
);
execFileSync(
  "/usr/bin/openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    key,
    "-out",
    cert,
    "-days",
    "1",
    "-config",
    config,
  ],
  { stdio: "ignore" },
);
let received = false,
  closed = false;
const server = createServer(
  { key: await readFile(key), cert: await readFile(cert) },
  (_request, response) => {
    received = true;
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"outbounds":[');
    response.on("close", () => {
      closed = true;
    });
  },
);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const app = await electron.launch({
  args: ["."],
  env: {
    ...process.env,
    FLOWGATE_TEST_DATA: join(work, "data"),
    NODE_EXTRA_CA_CERTS: cert,
  },
});
try {
  const page = await app.firstWindow();
  await page.getByRole("heading", { name: "概览" }).waitFor({ timeout: 20000 });
  const request = page.evaluate(
    (url) =>
      window.flowgate
        .request("subscription.import", { url }, "cancel-fixture")
        .then(
          () => ({ ok: true }),
          (error) => ({ error: error.message }),
        ),
    `https://localhost:${server.address().port}/subscription`,
  );
  for (let n = 0; n < 100 && !received; n++)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(received, true, "extension must actually start download");
  const canceled = await page.evaluate(() =>
    window.flowgate.cancel("cancel-fixture"),
  );
  assert.equal(canceled.requested, true);
  assert.match((await request).error, /取消/);
  for (let n = 0; n < 100 && !closed; n++)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(closed, true, "cancel must close upstream connection");
  const snapshot = await page.evaluate(() =>
    window.flowgate.request("snapshot"),
  );
  assert.equal(snapshot.lifecycle, "ready");
  assert.equal(snapshot.configuration.subscriptions.length, 0);
  const trace = await page.evaluate(() =>
    window.shell.request("diagnostics.trace"),
  );
  const calls = trace.filter(
    (event) => event.context.operationId === "cancel-fixture",
  );
  assert.ok(
    calls.some((event) => event.name === "Service:subscription.import"),
  );
  assert.ok(calls.some((event) => event.name === "Service:extension.call"));
  assert.ok(
    calls.some((event) => event.name === "Extensions:subscription.fetch"),
  );
  assert.ok(
    calls.some((event) =>
      event.context.pluginInstance?.startsWith("builtin.subscription:"),
    ),
  );
  assert.equal(
    new Set(calls.map((event) => event.context.traceId)).size,
    1,
    "same trace crosses all process boundaries",
  );
  assert.ok(
    !JSON.stringify(trace).includes("/subscription"),
    "trace must not contain subscription URL",
  );
  await writeFile(
    "work/cancellation-result.json",
    JSON.stringify(
      {
        passed: true,
        at: new Date().toISOString(),
        checks: [
          "Renderer to Main to Service to Extension cancellation",
          "actual HTTPS stream closed",
          "no partial subscription commit",
          "service remains ready",
          "same trace across all process boundaries",
          "no payloads in trace",
        ],
      },
      null,
      2,
    ),
  );
  console.log("PASS: real cross-process download cancellation");
} finally {
  await app.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
