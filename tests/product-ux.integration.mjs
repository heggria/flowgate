import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createUISurface } from "./fixtures/ui-surface.mjs";
import { isolateProxyPort } from "./proxy-fixture.mjs";
const output = resolve("work/product-ux");
await mkdir(output, { recursive: true });
const checks = [],
  errors = [];
const app = await electron.launch({
  args: ["."],
  env: {
    ...process.env,
    FLOWGATE_TEST_DATA: await mkdtemp(resolve("work/product-ux-data-")),
  },
});
async function choose(p, label, option) {
  await p.getByRole("button", { name: label, exact: true }).click();
  await p.getByRole("option", { name: option, exact: true }).click();
}
async function settle(p, predicate) {
  await p.waitForFunction(predicate, null, { timeout: 10000 });
}
try {
  const p = await app.firstWindow();
  p.setDefaultTimeout(7000);
  p.on("pageerror", (e) => errors.push(e.message));
  await p.getByRole("heading", { name: "概览", exact: true }).waitFor();
  assert.equal(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some(
        (w) => w.isVisible() || w.isFocusable(),
      ),
    ),
    false,
  );
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1180, 820),
  );
  await isolateProxyPort(p);
  const nav = async (name) => {
    await p
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name, exact: true })
      .click();
    await p.getByRole("heading", { name, exact: true }).first().waitFor();
  };
  await p.evaluate(async () => {
    await window.flowgate.request(
      "subscription.import",
      {
        text: JSON.stringify({
          outbounds: Array.from({ length: 40 }, (_, i) => ({
            type: "socks",
            tag: `线路 ${String(i + 1).padStart(2, "0")}`,
            server: "127.0.0.1",
            server_port: 20000 + i,
          })),
        }),
      },
      crypto.randomUUID(),
    );
    const c = (await window.flowgate.request("snapshot")).configuration;
    c.rules = Array.from({ length: 80 }, (_, i) => ({
      id: `rule-${i}`,
      kind: "domain_suffix",
      value: `site-${i}.example.com`,
      outbound: "select",
    }));
    await window.flowgate.request("configuration.save", c, crypto.randomUUID());
  });
  await p.getByRole("button", { name: "启动代理", exact: true }).click();
  await p.getByRole("button", { name: "停止代理", exact: true }).waitFor();
  await nav("节点与订阅");
  await p
    .locator(".node")
    .first()
    .getByRole("button", { name: "选择出口", exact: true })
    .click();
  await p
    .locator(".configurationbar")
    .filter({ hasText: /当前 直连/ })
    .waitFor();
  const snapshot = () => p.evaluate(() => window.flowgate.request("snapshot"));
  assert.equal((await snapshot()).appliedConnection.outletName, "直连");
  assert.equal(
    (await snapshot()).configuration.settings.selectedNode,
    (await snapshot()).configuration.nodes[0].id,
  );
  await nav("概览");
  assert.equal(await p.locator(".heroidentity h2").textContent(), "直连");
  assert.equal(
    await p
      .locator(".herometa")
      .getByText("节点未检测", { exact: true })
      .count(),
    1,
  );
  await p.screenshot({ path: join(output, "overview-pending.png") });
  checks.push(
    "real Service: current direct outlet remains distinct from saved node; startup does not imply a health check",
  );
  await p.getByRole("button", { name: "停止代理", exact: true }).click();
  await p.getByRole("button", { name: "启动代理", exact: true }).waitFor();
  await nav("节点与订阅");
  await p.getByRole("button", { name: /^订阅来源 1$/ }).click();
  assert.equal(await p.locator(".subscriptions").isVisible(), true);
  assert.equal(
    await p.locator('.resourcesection[aria-label="代理节点"]').isVisible(),
    false,
  );
  await p.getByRole("button", { name: "节点 40", exact: true }).click();
  await choose(p, "节点来源", "本地节点");
  await p.getByText("没有匹配的节点", { exact: true }).waitFor();
  await p.getByRole("button", { name: "清除搜索", exact: true }).click();
  assert.equal(await p.locator(".node").count(), 40);
  await p
    .getByRole("textbox", { name: "搜索节点", exact: true })
    .fill("线路 40");
  assert.equal(await p.locator(".node").count(), 1);
  await p.getByRole("button", { name: "清空节点搜索", exact: true }).click();
  const nodeGeometry = await p.locator(".node").first().boundingBox();
  assert.ok(nodeGeometry.height <= 50);
  await p.screenshot({ path: join(output, "nodes-40.png") });
  await p.getByRole("button", { name: "切换列表密度", exact: true }).click();
  assert.ok((await p.locator(".node").first().boundingBox()).height >= 60);
  await p.getByRole("button", { name: "切换列表密度", exact: true }).click();
  checks.push(
    "40 real nodes: subscriptions reachable independently, source/search filters, compact and comfortable row density",
  );
  await nav("分流规则");
  await p
    .getByRole("textbox", { name: "搜索规则", exact: true })
    .fill("site-39");
  assert.equal(await p.locator(".rulerow").count(), 1);
  assert.equal((await p.locator(".rulerow .index").textContent()).trim(), "40");
  await p.getByLabel("管理规则 site-39.example.com", { exact: true }).click();
  await p.getByRole("button", { name: "移至顶部", exact: true }).click();
  await settle(
    p,
    () =>
      document.querySelector(".rulerow .index")?.textContent?.trim() === "01",
  );
  await p.getByRole("textbox", { name: "搜索规则", exact: true }).fill("");
  const before = (await snapshot()).configuration.rules.map((r) => r.id);
  await p.getByLabel("管理规则 site-39.example.com", { exact: true }).click();
  await p
    .getByRole("button", { name: "删除规则 site-39.example.com", exact: true })
    .click();
  await p.getByRole("button", { name: "撤销删除", exact: true }).waitFor();
  await p.getByRole("button", { name: "撤销删除", exact: true }).click();
  await p.getByText("规则已恢复原位置。", { exact: true }).waitFor();
  assert.deepEqual(
    (await snapshot()).configuration.rules.map((r) => r.id),
    before,
  );
  await p.getByRole("button", { name: "检查路径", exact: true }).click();
  const dialog = p.getByRole("dialog", { name: "路径预览", exact: true });
  await dialog
    .getByRole("textbox", { name: "目标域名", exact: true })
    .fill("SITE-39.EXAMPLE.COM.");
  await dialog.getByRole("button", { name: "检查路径", exact: true }).click();
  await dialog.getByRole("status").filter({ hasText: "线路 01" }).waitFor();
  await p.evaluate(async () => {
    const config = (await window.flowgate.request("snapshot")).configuration;
    config.rules[0].outbound = "direct";
    await window.flowgate.request(
      "configuration.save",
      config,
      crypto.randomUUID(),
    );
  });
  await dialog
    .getByRole("status")
    .filter({ hasText: "配置已变化，请重新检查" })
    .waitFor();
  await dialog.getByRole("button", { name: "检查路径", exact: true }).click();
  await dialog.getByRole("status").filter({ hasText: "直连" }).waitFor();
  assert.ok(
    !(await dialog.getByRole("status").textContent()).includes("配置已变化"),
  );
  await p.keyboard.press("Escape");
  await p.getByRole("button", { name: "管理规则集", exact: true }).click();
  await p.getByRole("heading", { name: /^规则集来源/ }).waitFor();
  await p.getByRole("button", { name: "返回规则", exact: true }).click();
  await p.screenshot({ path: join(output, "rules-80.png") });
  checks.push(
    "80 real rules: true priority under filters, move-to-top, delete/undo preserves exact order, readable preview and reachable rule sources",
  );
  await nav("设置");
  const oldPort = await p.getByLabel("本地端口", { exact: true }).inputValue();
  await p
    .getByLabel("本地端口", { exact: true })
    .fill(String(Number(oldPort) + 1));
  await nav("概览");
  await p.locator(".draftbadge").filter({ hasText: "草稿" }).waitFor();
  await nav("设置");
  await p.waitForFunction(
    (expected) => document.querySelector("#listen-port")?.value === expected,
    String(Number(oldPort) + 1),
  );
  assert.equal(
    await p.getByLabel("本地端口", { exact: true }).inputValue(),
    String(Number(oldPort) + 1),
  );
  await p.getByRole("button", { name: "放弃更改", exact: true }).click();
  await settle(p, () => !document.querySelector(".draftbadge"));
  const radios = p.locator('.modecard input[type="radio"]');
  assert.equal(await radios.nth(1).isDisabled(), true);
  assert.equal(await radios.nth(2).isDisabled(), true);
  await nav("扩展");
  await p.getByRole("button", { name: "管理更新", exact: true }).click();
  await p.getByRole("heading", { name: "设置", exact: true }).waitFor();
  const heading = p.getByRole("heading", { name: "关于与更新", exact: true });
  await heading.waitFor();
  assert.ok(
    (await heading.boundingBox()).y < 820,
    "updates destination scrolls into view",
  );
  checks.push(
    "settings: cross-page draft indicator and preserved values, capability-aware modes, one updates destination",
  );
  const search = p.getByRole("textbox", { name: "查找功能", exact: true });
  await search.fill("线路 40");
  await search.press("Enter");
  await p.getByRole("heading", { name: "节点与订阅", exact: true }).waitFor();
  assert.equal(
    await p
      .getByRole("textbox", { name: "搜索节点", exact: true })
      .inputValue(),
    "线路 40",
  );
  checks.push(
    "command search finds a real node and opens a filtered node view",
  );
} finally {
  await app.close();
}
// Presentation fixture is explicitly separate from real Service and packet forwarding.
const fixture = await createUISurface();
const surface = await electron.launch({ args: [fixture.main] });
try {
  const p = await surface.firstWindow();
  p.setDefaultTimeout(7000);
  p.on("pageerror", (e) => errors.push(e.message));
  await p.getByRole("status").filter({ hasText: "正在连接服务" }).waitFor();
  await p.evaluate(() => window.uiFixture.releaseLoading());
  await p.getByRole("heading", { name: "概览", exact: true }).waitFor();
  await p.evaluate(() => {
    const next = structuredClone(uiFixture.snapshot);
    next.traffic.flows = Array.from({ length: 200 }, (_, i) => ({
      id: `flow-${i}`,
      target: `request-${i}.example.com`,
      protocol: "https",
      outbound: "node-one",
      rule: "default",
      upload: i,
      download: 200 - i,
      state: "active",
    }));
    uiFixture.push(next);
  });
  await p
    .getByRole("navigation")
    .getByRole("button", { name: "连接", exact: true })
    .click();
  for (const index of [0, 149]) {
    const target = p.locator(".targetbutton").nth(index);
    await target.scrollIntoViewIfNeeded();
    const before = await p.evaluate(() => ({
      page: scrollY,
      list: document.querySelector(".tablewrap").scrollTop,
    }));
    await target.click();
    await p.getByRole("dialog", { name: "连接详情", exact: true }).waitFor();
    await p.screenshot({ path: join(output, `connections-200-${index}.png`) });
    await p.keyboard.press("Escape");
    await p.getByRole("dialog").waitFor({ state: "hidden" });
    assert.deepEqual(
      await p.evaluate(() => ({
        page: scrollY,
        list: document.querySelector(".tablewrap").scrollTop,
      })),
      before,
    );
    assert.equal(
      await target.evaluate((el) => el === document.activeElement),
      true,
    );
  }
  checks.push(
    "presentation fixture only: 200 connections, opening and closing first/150th details preserves table and page scroll plus keyboard focus",
  );
  await p
    .getByRole("navigation")
    .getByRole("button", { name: "概览", exact: true })
    .click();
  const info = p.getByRole("button", { name: "节点检测说明", exact: true });
  await info.focus();
  await p.getByRole("tooltip").filter({ hasText: "节点检测仅代表" }).waitFor();
  await p.keyboard.press("Escape");
  assert.equal(
    await p
      .getByRole("tooltip")
      .filter({ hasText: "节点检测仅代表" })
      .isVisible(),
    false,
  );
  await info.hover();
  await p.getByRole("tooltip").filter({ hasText: "节点检测仅代表" }).waitFor();
  checks.push(
    "help tooltips are available to keyboard and pointer, and dismiss with Escape",
  );
} finally {
  await surface.close();
}
assert.deepEqual(errors, []);
await writeFile(
  join(output, "result.json"),
  JSON.stringify({ passed: true, checks, errors }, null, 2),
);
console.log("PASS", checks);
