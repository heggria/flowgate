import { openNodeImport, openRuleEditor } from "./ui-fixtures.mjs";
import { isolateProxyPort } from "./proxy-fixture.mjs";
import { _electron as electron } from "playwright";
import { mkdtemp, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const app = await electron.launch({
  args: ["."],
  env: {
    ...process.env,
    FLOWGATE_TEST_DATA: await mkdtemp(resolve("work/journeys-")),
  },
});
const checks = [];
try {
  const p = await app.firstWindow(),
    errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.getByRole("heading", { name: "概览", exact: true }).waitFor();
  await isolateProxyPort(p);
  await p.screenshot({ path: "work/journey-overview-light.png" });
  await p.getByRole("button", { name: "添加第一个节点" }).click();
  assert.equal(
    await p.evaluate(() => document.activeElement?.textContent),
    "节点与订阅",
  );
  const input = await openNodeImport(p);
  await input.fill(
    JSON.stringify({
      outbounds: [
        {
          type: "socks",
          tag: "Journey node",
          server: "127.0.0.1",
          server_port: 19999,
        },
      ],
    }),
  );
  await p.getByRole("button", { name: "预览转换", exact: true }).click();
  await p.getByRole("button", { name: "确认导入", exact: true }).click();
  await p.getByText("Journey node", { exact: true }).waitFor();
  await p.getByRole("dialog").waitFor({ state: "hidden" });
  await p.getByRole("button", { name: "选择出口", exact: true }).click();
  await p.getByRole("button", { name: "✓ 已选择", exact: true }).waitFor();
  assert.equal(
    await p
      .getByRole("button", { name: "测延迟 Journey node", exact: true })
      .isDisabled(),
    true,
  );
  checks.push(
    "first use -> import -> select, unavailable measurement explained",
  );
  await p.getByRole("textbox", { name: "搜索节点" }).fill("missing-node");
  await p.getByText("没有匹配的节点", { exact: true }).waitFor();
  await p.getByRole("button", { name: "清除搜索" }).first().click();
  await p.getByLabel("更多操作 Journey node").click();
  await p.getByRole("button", { name: "移除", exact: true }).click();
  await p.getByRole("dialog").waitFor();
  assert.equal(
    await p.evaluate(() => document.activeElement?.textContent),
    "取消",
  );
  await p.keyboard.press("Escape");
  await p.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(
    (await p.evaluate(() => window.flowgate.request("snapshot"))).configuration
      .nodes.length,
    1,
  );
  checks.push(
    "empty search recovery, destructive dialog Escape preserves node",
  );
  await p.screenshot({ path: "work/journey-nodes-light.png" });
  await p.getByRole("button", { name: "启动代理", exact: true }).click();
  await p.getByRole("button", { name: "停止代理", exact: true }).waitFor();
  await p.getByRole("button", { name: "分流规则", exact: true }).click();
  await openRuleEditor(p);
  await p.getByRole("textbox", { name: "匹配内容" }).fill("first.example");
  await p.getByRole("button", { name: "添加规则", exact: true }).click();
  await p.getByText("first.example", { exact: true }).waitFor();
  await p.getByText("有配置等待生效", { exact: true }).waitFor();
  await openRuleEditor(p);
  await p.getByRole("textbox", { name: "匹配内容" }).fill("second.example");
  await p.getByRole("button", { name: "添加规则", exact: true }).click();
  await p.getByText("second.example", { exact: true }).waitFor();
  await p
    .getByRole("button", { name: "上移规则 second.example", exact: true })
    .click();
  await p
    .getByRole("button", { name: "上移规则 second.example", exact: true })
    .isDisabled();
  // Snapshot is the service authority; after the mutation busy guard releases, the button reflects persisted order.
  for (let n = 0; n < 50; n++) {
    if (
      await p
        .getByRole("button", { name: "上移规则 second.example", exact: true })
        .isDisabled()
    )
      break;
    await p.waitForTimeout(100);
  }
  assert.equal(
    (await p.evaluate(() => window.flowgate.request("snapshot"))).configuration
      .rules[0].value,
    "second.example",
  );
  await p.getByRole("button", { name: "设置", exact: true }).click();
  await p.getByText("有配置等待生效", { exact: true }).waitFor();
  await p.getByRole("button", { name: "应用配置", exact: true }).click();
  for (let n = 0; n < 80; n++) {
    if ((await p.getByText("有配置等待生效", { exact: true }).count()) === 0)
      break;
    await p.waitForTimeout(100);
  }
  assert.equal(await p.getByText("有配置等待生效", { exact: true }).count(), 0);
  const snapshot = await p.evaluate(() => window.flowgate.request("snapshot"));
  assert.equal(
    snapshot.kernel.appliedRevision,
    snapshot.configuration.revision,
  );
  checks.push(
    "rule ordering persisted, cross-page pending configuration -> apply",
  );
  await p.getByRole("button", { name: "停止代理", exact: true }).click();
  await p.getByRole("button", { name: "启动代理", exact: true }).waitFor();
  await p.getByRole("button", { name: "切换深色外观" }).click();
  await p.getByRole("button", { name: "概览", exact: true }).click();
  await p.screenshot({ path: "work/journey-overview-dark.png" });
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(900, 760),
  );
  for (const route of ["节点与订阅", "分流规则", "网络环境", "设置", "概览"]) {
    await p
      .getByRole("button", { name: route, exact: route !== "节点与订阅" })
      .click();
    const overflow = await p.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    );
    assert.equal(overflow, false, route + " has no horizontal page overflow");
  }
  await p.screenshot({ path: "work/journey-narrow-dark.png" });
  await p.keyboard.press("Meta+k");
  assert.equal(
    await p
      .getByRole("textbox", { name: "查找功能" })
      .evaluate((el) => el === document.activeElement),
    true,
  );
  await p.getByRole("textbox", { name: "查找功能" }).fill("分流规则");
  await p.keyboard.press("Enter");
  await p.getByRole("heading", { name: "分流规则", exact: true }).waitFor();
  checks.push(
    "light/dark, narrow layout on five pages, keyboard search navigation",
  );
  assert.deepEqual(errors, []);
  await writeFile(
    "work/journeys-result.json",
    JSON.stringify(
      { passed: true, at: new Date().toISOString(), checks },
      null,
      2,
    ),
  );
  console.log("PASS: complete UI journeys", checks);
} finally {
  await app.close();
}
