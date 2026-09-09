import { isolateProxyPort } from "./proxy-fixture.mjs";
import { _electron as electron } from "playwright";
import { createServer } from "node:https";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { promisify } from "node:util";
import { execFile, execFileSync } from "node:child_process";
import assert from "node:assert/strict";
const work = await mkdtemp(resolve("work/features-"));
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
let contents = "one.flowgate.test\ntwo.flowgate.test\n",
  broken = false;
const server = createServer(
  { key: await readFile(key), cert: await readFile(cert) },
  (_request, response) => response.writeHead(broken ? 503 : 200).end(contents),
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
  await isolateProxyPort(page);
  await app.evaluate(({ app }) =>
    app.emit("open-url", { preventDefault() {} }, "flowgate://open/rules"),
  );
  await page.getByRole("heading", { name: "分流规则", exact: true }).waitFor();
  const source = page.locator("section").filter({
    has: page.getByRole("heading", { name: /^规则集来源/ }),
  });
  await source.getByRole("button", { name: "添加规则集", exact: true }).click();
  const importDialog = page.getByRole("dialog", {
    name: "添加规则集",
    exact: true,
  });
  await importDialog.getByLabel("名称", { exact: true }).fill("规则测试来源");
  await importDialog
    .getByLabel("HTTPS 来源")
    .fill(`https://localhost:${server.address().port}/rules`);
  await importDialog
    .getByRole("button", { name: "导入规则集", exact: true })
    .click();
  await source.getByText("规则测试来源", { exact: true }).waitFor();
  let snapshot = await page.evaluate(() => window.flowgate.request("snapshot"));
  assert.equal(snapshot.configuration.ruleSources[0].count, 2);
  contents = "three.flowgate.test\n";
  await source.getByRole("button", { name: "更新", exact: true }).click();
  for (let n = 0; n < 80; n++) {
    snapshot = await page.evaluate(() => window.flowgate.request("snapshot"));
    if (snapshot.configuration.ruleSources[0].count === 1) break;
    await page.waitForTimeout(100);
  }
  assert.equal(
    snapshot.configuration.rules.filter((rule) => rule.sourceId).length,
    1,
  );
  assert.equal(
    snapshot.configuration.rules.find((rule) => rule.sourceId).value,
    "three.flowgate.test",
  );
  broken = true;
  await source.getByRole("button", { name: "更新", exact: true }).click();
  await source.getByRole("alert").waitFor();
  snapshot = await page.evaluate(() => window.flowgate.request("snapshot"));
  assert.equal(snapshot.configuration.ruleSources[0].count, 1);
  await page.getByPlaceholder("查找功能").fill("刷新网络状态");
  await page.getByPlaceholder("查找功能").press("Enter");
  await page.getByPlaceholder("查找功能").fill("");
  const trace = await page.evaluate(() =>
    window.shell.request("diagnostics.trace"),
  );
  assert.ok(trace.some((event) => event.name === "Service:network.refresh"));
  broken = false;
  await page.evaluate(() =>
    window.flowgate.request("proxy.connect", {}, "features-connect"),
  );
  const activeKernel = (
    await page.evaluate(() => window.flowgate.request("snapshot"))
  ).kernel;
  await app.evaluate(({ app }) => {
    const host = app
      .getAppMetrics()
      .find((metric) => metric.name === "FlowGate Extensions");
    if (!host) throw new Error("extension missing");
    process.kill(host.pid, "SIGKILL");
  });
  let refreshed = false;
  for (let n = 0; n < 100; n++) {
    try {
      await page.evaluate(() => window.flowgate.request("network.refresh"));
      refreshed = true;
      break;
    } catch {
      await page.waitForTimeout(100);
    }
  }
  assert.equal(refreshed, true);
  const nextWindow = app.waitForEvent("window");
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer(),
  );
  const recoveredPage = await nextWindow;
  await recoveredPage
    .getByRole("heading", { name: "概览", exact: true })
    .waitFor({ timeout: 20000 });
  snapshot = await recoveredPage.evaluate(() =>
    window.flowgate.request("snapshot"),
  );
  assert.equal(snapshot.configuration.ruleSources.length, 1);
  assert.equal(
    snapshot.kernel.pid,
    activeKernel.pid,
    "renderer/extension crashes preserve kernel",
  );
  const forwarded = (
    await promisify(execFile)(
      "/usr/bin/curl",
      [
        "--silent",
        "--show-error",
        "--fail",
        "--max-time",
        "8",
        "--noproxy",
        "",
        "--proxy",
        `http://127.0.0.1:${snapshot.configuration.settings.listenPort}`,
        "--cacert",
        cert,
        `https://127.0.0.1:${server.address().port}/rules`,
      ],
      { encoding: "utf8" },
    )
  ).stdout;
  assert.equal(forwarded, contents, "actual HTTPS forwarding survives crashes");
  await writeFile(
    "work/features-result.json",
    JSON.stringify(
      {
        passed: true,
        at: new Date().toISOString(),
        checks: [
          "deep link navigation",
          "ruleset HTTPS import and refresh",
          "failed refresh preserves snapshot",
          "command contribution executes",
          "Extension SIGKILL restarts",
          "Renderer crash restores business snapshot",
        ],
      },
      null,
      2,
    ),
  );
  console.log("PASS: ruleset UI, commands, deep links and host crashes");
} finally {
  await app.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
