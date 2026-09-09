import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import { mkdir, writeFile, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
const origin = createServer((_req, res) => res.end("flowgate-e2e-origin"));
await new Promise((r) => origin.listen(0, "127.0.0.1", r));
const originPort = origin.address().port;
const exec = promisify(execFile);
await mkdir("work", { recursive: true });
const data = await mkdtemp(resolve("work/e2e-"));
const app = await electron.launch({
  executablePath: process.env.FLOWGATE_ELECTRON_EXECUTABLE,
  args: ["."],
  env: { ...process.env, FLOWGATE_TEST_DATA: data },
});
try {
  const page = await app.firstWindow();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page
    .getByRole("heading", { name: "概览" })
    .waitFor({ timeout: 30000 });
  await page.getByRole("button", { name: "节点与订阅", exact: false }).click();
  await page
    .getByRole("textbox", { name: "订阅链接或配置" })
    .fill(
      JSON.stringify({
        outbounds: [
          {
            type: "socks",
            tag: "Local test",
            server: "127.0.0.1",
            server_port: 19999,
          },
        ],
      }),
    );
  await page.getByRole("button", { name: "导入节点", exact: true }).click();
  await page.getByText("Local test", { exact: true }).waitFor();
  await page.getByRole("button", { name: "分流规则", exact: false }).click();
  await page.getByRole("textbox", { name: "匹配内容" }).fill("example.com");
  await page.getByRole("button", { name: "添加规则" }).click();
  await page.getByText("example.com", { exact: true }).waitFor();

  await page.getByRole("textbox", { name: "目标域名" }).fill("www.example.com");
  await page.getByRole("button", { name: "检查路径" }).click();
  await page.getByRole("status").filter({ hasText: "direct" }).waitFor();
  await page.getByRole("button", { name: "概览", exact: true }).click();
  await page.getByRole("button", { name: "启动代理", exact: true }).click();
  await page.getByRole("button", { name: "停止代理", exact: true }).waitFor();
  const kernelBefore = await page.evaluate(
    async () => (await window.flowgate.request("snapshot")).kernel,
  );
  const request = () =>
    exec("/usr/bin/curl", [
      "--silent",
      "--fail",
      "--max-time",
      "5",
      "--noproxy",
      "",
      "--proxy",
      "http://127.0.0.1:17890",
      `http://127.0.0.1:${originPort}`,
    ]);
  assert.equal((await request()).stdout, "flowgate-e2e-origin");
  const before = await page.evaluate(() => window.flowgate.request("snapshot"));
  await page.reload();
  await page
    .getByRole("heading", { name: "概览" })
    .waitFor();
  const after = await page.evaluate(() => window.flowgate.request("snapshot"));
  assert.equal(after.epoch, before.epoch);
  assert.equal(after.configuration.revision, before.configuration.revision);
  assert.equal(after.kernel.pid, kernelBefore.pid);
  assert.equal((await request()).stdout, "flowgate-e2e-origin");
  const killed = await app.evaluate(({ app }) => {
    const metric = app
      .getAppMetrics()
      .find((m) => m.name === "FlowGate Service");
    if (!metric) return false;
    process.kill(metric.pid, "SIGKILL");
    return true;
  });
  assert.equal(killed, true, "Service process identifiable");
  await page.waitForFunction(
    async (epoch) => {
      try {
        return (await window.flowgate.request("snapshot")).epoch !== epoch;
      } catch {
        return false;
      }
    },
    before.epoch,
    { timeout: 15000 },
  );
  const recovered = await page.evaluate(() =>
    window.flowgate.request("snapshot"),
  );
  assert.equal(recovered.kernel.pid, kernelBefore.pid);
  assert.equal((await request()).stdout, "flowgate-e2e-origin");
  await page.evaluate(() =>
    window.flowgate.request("proxy.disconnect", {}, crypto.randomUUID()),
  );
  await page.getByRole("button", { name: "刷新状态", exact: false }).click();
  await page.waitForFunction(
    async () => !!(await window.flowgate.request("snapshot")).network,
    { timeout: 25000 },
  );
  assert.deepEqual(
    await page.evaluate(() => ({
      require: typeof window.require,
      node: typeof window.process,
    })),
    { require: "undefined", node: "undefined" },
  );
  await page.waitForFunction(
    () =>
      !Array.from(document.querySelectorAll("button")).some((b) =>
        b.textContent.includes("处理中"),
      ),
  );
  assert.deepEqual(errors, []);
  await page.screenshot({ path: "work/e2e-preview.png", fullPage: true });
  await writeFile(
    "work/e2e-result.json",
    JSON.stringify(
      {
        passed: true,
        runtime: await app.evaluate(() => process.versions.electron),
        at: new Date().toISOString(),
        checks: [
          "import nodes",
          "save rule",
          "preview",
          "renderer reload retains service epoch and data",
          "live network refresh",
          "sandbox isolation",
          "no page errors",
          "actual proxy survives renderer reload",
          "service crash restarts without killing kernel",
        ],
      },
      null,
      2,
    ),
  );
  console.log("PASS: workspace E2E");
} finally {
  await app.close();
  await new Promise((r) => origin.close(r));
}
