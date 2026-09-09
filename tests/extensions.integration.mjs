import { isolateProxyPort } from "./proxy-fixture.mjs";
import { _electron as electron } from "playwright";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const data = await mkdtemp(resolve("work/extensions-"));
const origin = createServer((_req, res) => res.end("extension-forwarding"));
await new Promise((resolve) => origin.listen(0, "127.0.0.1", resolve));
const launch = () =>
  electron.launch({
    ...(process.env.FLOWGATE_TEST_EXECUTABLE
      ? { executablePath: process.env.FLOWGATE_TEST_EXECUTABLE }
      : { args: ["."] }),
    env: { ...process.env, FLOWGATE_TEST_DATA: data },
  });
let app = await launch();
const checks = [],
  errors = [];
const waitFor = async (read, predicate) => {
  for (let n = 0; n < 100; n++) {
    try {
      const value = await read();
      if (predicate(value)) return value;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("State did not converge");
};
try {
  let page = await app.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.getByRole("heading", { name: "概览", exact: true }).waitFor();
  await isolateProxyPort(page);
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "扩展", exact: true })
    .click();
  await page.getByRole("heading", { name: "扩展", exact: true }).waitFor();
  const snapshot = () =>
    page.evaluate(() => window.flowgate.request("snapshot"));
  await waitFor(
    snapshot,
    (value) =>
      value.extensions?.length === 5 &&
      value.extensions.every((entry) => entry.status === "ready"),
  );
  assert.equal(await page.getByRole("article").count(), 5);
  const core = page.getByRole("article", { name: "系统网络发现" });
  assert.equal(
    await core.getByRole("button", { name: "停用", exact: true }).count(),
    0,
  );
  const denied = await page.evaluate(async () => {
    const s = await window.flowgate.request("snapshot");
    return window.flowgate
      .request(
        "extensions.setEnabled",
        {
          id: "builtin.network",
          enabled: false,
          revision: s.extensionRevision,
        },
        "deny-core",
      )
      .then(
        () => "allowed",
        (error) => error.message,
      );
  });
  assert.match(denied, /核心/);
  checks.push(
    "normal navigation and all five packages; core cannot be disabled through IPC",
  );
  await page.evaluate(() =>
    window.flowgate.request("proxy.connect", {}, "extensions-proxy"),
  );
  const before = await snapshot();
  const forward = async () => {
    const response = await promisify(execFile)("/usr/bin/curl", [
      "--silent",
      "--show-error",
      "--fail",
      "--max-time",
      "5",
      "--noproxy",
      "",
      "--proxy",
      `http://127.0.0.1:${before.configuration.settings.listenPort}`,
      `http://127.0.0.1:${origin.address().port}`,
    ]);
    assert.equal(response.stdout, "extension-forwarding");
  };
  await forward();
  const optional = page.getByRole("article", { name: "Tailscale 状态诊断" });
  await optional.getByRole("button", { name: "停用", exact: true }).click();
  await optional.getByRole("button", { name: "启用", exact: true }).waitFor();
  const disabled = await snapshot();
  assert.equal(disabled.configuration.revision, before.configuration.revision);
  assert.equal(disabled.kernel.pid, before.kernel.pid);
  await page.evaluate(() => window.flowgate.request("network.refresh"));
  assert.equal(
    (await snapshot()).network.plugins.some(
      (entry) => entry.id === "builtin.tailscale",
    ),
    false,
  );
  await forward();
  checks.push(
    "optional disable changes real diagnostics without stopping kernel or changing network revision",
  );
  await optional.getByRole("button", { name: "查看详情", exact: true }).click();
  await page
    .getByRole("region", { name: "扩展详情" })
    .getByText("技术信息与故障追踪")
    .click();
  await page.getByRole("button", { name: "读取此扩展诊断" }).click();
  await page
    .getByRole("region", { name: "扩展详情" })
    .getByText(/stopped/)
    .waitFor();
  await page.getByRole("textbox", { name: "搜索扩展" }).fill("not-found");
  await page.getByText("没有匹配的扩展").waitFor();
  await page.getByRole("button", { name: "清除筛选" }).click();
  await page
    .getByRole("combobox", { name: "扩展类型" })
    .selectOption("optional");
  assert.equal(await page.getByRole("article").count(), 2);
  await page.screenshot({ path: "work/extensions-light.png", fullPage: true });
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(960, 760),
  );
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
  );
  checks.push("details, lifecycle trace, search, filters and narrow window");
  const prior = await snapshot();
  await app.evaluate(({ app }) => {
    const host = app
      .getAppMetrics()
      .find((metric) => metric.name === "FlowGate Extensions");
    if (!host) throw new Error("Missing host");
    process.kill(host.pid, "SIGKILL");
  });
  const recovered = await waitFor(
    snapshot,
    (value) =>
      value.extensions?.find((entry) => entry.id === "builtin.network")
        ?.status === "ready" &&
      value.extensions.find((entry) => entry.id === "builtin.network")
        .instance !==
        prior.extensions.find((entry) => entry.id === "builtin.network")
          .instance,
  );
  assert.equal(
    recovered.extensions.find((entry) => entry.id === "builtin.tailscale")
      .status,
    "stopped",
  );
  assert.equal(recovered.kernel.pid, before.kernel.pid);
  await forward();
  checks.push(
    "host SIGKILL replays durable disabled preference without kernel interruption",
  );
  for (let crash = 0; crash < 3; crash++) {
    const previous = (await snapshot()).extensions.find(
      (entry) => entry.id === "builtin.network",
    ).instance;
    await app.evaluate(({ app }) => {
      const host = app
        .getAppMetrics()
        .find((metric) => metric.name === "FlowGate Extensions");
      if (!host) throw new Error("Missing host");
      process.kill(host.pid, "SIGKILL");
    });
    if (crash < 2)
      await waitFor(
        snapshot,
        (state) =>
          state.extensions.find((entry) => entry.id === "builtin.network")
            .instance !== previous &&
          state.extensions.find((entry) => entry.id === "builtin.network")
            .status === "ready",
      );
  }
  await page
    .getByRole("button", { name: "重启扩展宿主", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "重启扩展宿主", exact: true }).click();
  await waitFor(snapshot, (state) =>
    state.extensions.every(
      (entry) => entry.status === "ready" || entry.status === "stopped",
    ),
  );
  assert.equal(
    (await snapshot()).extensions.find(
      (entry) => entry.id === "builtin.tailscale",
    ).status,
    "stopped",
  );
  assert.equal((await snapshot()).kernel.pid, before.kernel.pid);
  await forward();
  await page.getByRole("button", { name: "切换深色外观", exact: true }).click();
  await page.screenshot({
    path: "work/extensions-dark-narrow.png",
    fullPage: true,
  });
  checks.push(
    "restart budget exhaustion keeps management UI; explicit restart restores preferences and actual forwarding",
  );
  await app.close();
  app = await launch();
  page = await app.firstWindow();
  await page.getByRole("heading", { name: "概览", exact: true }).waitFor();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "扩展", exact: true })
    .click();
  const row = page.getByRole("article", { name: "Tailscale 状态诊断" });
  await row.getByRole("button", { name: "启用", exact: true }).waitFor();
  await row.getByRole("button", { name: "启用", exact: true }).click();
  await row.getByRole("button", { name: "停用", exact: true }).waitFor();
  await page.evaluate(() => window.flowgate.request("network.refresh"));
  assert.equal(
    (await snapshot()).network.plugins.some(
      (entry) => entry.id === "builtin.tailscale",
    ),
    true,
  );
  await page.getByRole("button", { name: "检查更新", exact: true }).click();
  await page
    .getByRole("status")
    .filter({ hasText: "官方更新源尚未配置" })
    .waitFor();
  assert.equal(
    (await snapshot()).extensions.every((entry) => entry.status === "ready"),
    true,
  );
  checks.push(
    "app restart persists disabled state; re-enable restores diagnostics; offline catalog preserves running modules",
  );
  assert.deepEqual(errors, []);
  await writeFile(
    "work/extensions-result.json",
    JSON.stringify(
      { passed: true, at: new Date().toISOString(), checks },
      null,
      2,
    ),
  );
  console.log(
    "PASS: builtin extension management, persistence, host crash, actual forwarding and UI",
  );
} finally {
  await app.close();
  await new Promise((resolve) => origin.close(resolve));
}
