import { _electron as electron } from "playwright";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const exec = promisify(execFile);
let tick = 0;
const origin = createServer((req, res) => {
  req.resume();
  res.writeHead(200, { "Content-Type": "application/octet-stream" });
  const timer = setInterval(() => {
    tick++;
    res.write(Buffer.alloc(8192 * (1 + (tick % 13))));
  }, 100);
  const end = setTimeout(() => res.end(), 32000);
  res.on("close", () => {
    clearInterval(timer);
    clearTimeout(end);
  });
});
await new Promise((r) => origin.listen(0, "127.0.0.1", r));
const app = await electron.launch({
  args: ["."],
  env: {
    ...process.env,
    FLOWGATE_TEST_DATA: await mkdtemp(resolve("work/ui-")),
  },
});
try {
  const page = await app.firstWindow();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.getByRole("heading", { name: "概览", exact: true }).waitFor();
  await page.screenshot({ path: "work/ui-empty.png" });
  await page.getByRole("button", { name: "启动代理", exact: true }).click();
  await page.getByRole("button", { name: "停止代理", exact: true }).waitFor();
  const download = exec("/usr/bin/curl", [
    "--silent",

    "--max-time",
    "40",
    "--noproxy",
    "",
    "--proxy",
    "http://127.0.0.1:17890",
    `http://127.0.0.1:${origin.address().port}/stream`,
    "--output",
    "work/ui-stream.bin",
    "--write-out",
    "%{http_code}",
  ]).catch((e) => ({ stdout: "curl failed " + e.code }));
  let snapshot;
  const deadline = Date.now() + 30000;
  do {
    await new Promise((r) => setTimeout(r, 1000));
    snapshot = await page.evaluate(() => window.flowgate.request("snapshot"));
    if (
      snapshot.traffic?.history?.length >= 18 &&
      snapshot.traffic.downloadRate > 0
    )
      break;
  } while (Date.now() < deadline);
  assert(snapshot.traffic?.history?.length >= 18, "18 real samples received");
  await page.getByText("实时更新", { exact: true }).waitFor();
  assert(snapshot.traffic.download > 0);
  assert(snapshot.traffic.history.some((p) => p.downloadRate > 0));
  await page.screenshot({ path: "work/ui-live.png" });
  await page.getByRole("button", { name: "5 分钟", exact: true }).click();
  assert.equal(
    await page
      .getByRole("button", { name: "5 分钟", exact: true })
      .getAttribute("aria-pressed"),
    "true",
  );
  await page.getByRole("button", { name: "1 分钟", exact: true }).click();
  await page.getByRole("button", { name: "查看全部", exact: false }).click();
  await page
    .getByRole("textbox", { name: "搜索连接" })
    .fill("no-such-domain.invalid");
  await page.getByText("没有匹配的连接", { exact: true }).waitFor();
  await page.getByRole("textbox", { name: "搜索连接" }).fill("127.0.0.1");
  await page
    .getByRole("button", { name: "127.0.0.1", exact: true })
    .first()
    .click();
  await page.getByRole("heading", { name: "连接详情" }).waitFor();
  await page.screenshot({ path: "work/ui-connections.png" });
  await page.getByRole("button", { name: "关闭连接详情" }).click();
  await page.getByRole("textbox", { name: "查找功能" }).fill("概览");
  await page.getByRole("textbox", { name: "查找功能" }).press("Enter");
  await page.getByRole("heading", { name: "概览", exact: true }).waitFor();
  await page.getByRole("button", { name: "切换深色外观" }).click();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  await page.screenshot({ path: "work/ui-dark.png" });
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(960, 700),
  );
  assert(
    await page
      .getByRole("button", { name: "停止代理", exact: true })
      .isVisible(),
  );
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    ),
    false,
  );
  await page.screenshot({ path: "work/ui-narrow.png" });
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1320, 860),
  );
  await page.getByRole("button", { name: "切换浅色外观" }).click();
  assert.equal((await download).stdout, "200");
  await page.getByRole("button", { name: "停止代理", exact: true }).click();
  await page.getByRole("button", { name: "启动代理", exact: true }).waitFor();
  assert.deepEqual(errors, []);
  await writeFile(
    "work/ui-result.json",
    JSON.stringify(
      {
        passed: true,
        at: new Date().toISOString(),
        sampleCount: snapshot.traffic.history.length,
        downloadBytes: snapshot.traffic.download,
        checks: [
          "real loopback stream reflected in rates and chart",
          "empty state",
          "range switch",
          "connection search/no-results/inspector",
          "navigation search Enter",
          "dark/light mode",
          "960px no horizontal overflow",
          "stop state",
        ],
        pageErrors: errors,
      },
      null,
      2,
    ),
  );
  console.log("PASS: UI dashboard with real loopback traffic");
} finally {
  await app.close();
  origin.closeAllConnections();
  await new Promise((r) => origin.close(r));
}
