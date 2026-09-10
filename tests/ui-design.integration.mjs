import { _electron as electron } from "playwright";
import { createServer } from "node:https";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
import { isolateProxyPort } from "./proxy-fixture.mjs";
const work = await mkdtemp(resolve("work/ui-design-"));
const evidence = resolve("work/ui-redesign");
await mkdir(evidence, { recursive: true });
const key = join(work, "server.key"),
  cert = join(work, "server.crt"),
  config = join(work, "openssl.cnf");
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
const nodes = [
  "Tokyo · 01",
  "Singapore · 02",
  "香港 · 工作网络",
  "用于检查长名称展示与省略行为的备用节点 / Backup connection",
].map((tag, i) => ({
  type: "socks",
  tag,
  server: "127.0.0.1",
  server_port: 22000 + i,
}));
let fetches = 0,
  cancelledFetches = 0;
const server = createServer(
  { key: await readFile(key), cert: await readFile(cert) },
  (req, res) => {
    fetches++;
    const delay = req.url === "/slow" ? 8000 : 350;
    const timer = setTimeout(
      () => res.end(JSON.stringify({ outbounds: nodes })),
      delay,
    );
    res.on("close", () => {
      clearTimeout(timer);
      if (!res.writableEnded && req.url === "/slow") cancelledFetches++;
    });
  },
);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const app = await electron.launch({
  args: ["."],
  env: {
    ...process.env,
    FLOWGATE_TEST_DATA: join(work, "data"),
    NODE_EXTRA_CA_CERTS: cert,
  },
});
const checks = [];
try {
  const p = await app.firstWindow(),
    errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.getByRole("heading", { name: "概览", exact: true }).waitFor();
  await isolateProxyPort(p);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1180, 820),
  );
  await p.getByRole("button", { name: "节点与订阅", exact: false }).click();
  assert.equal(
    await p.getByRole("textbox", { name: "订阅链接或配置" }).count(),
    0,
    "resource list does not expose creation form by default",
  );
  await p.getByRole("button", { name: "添加订阅", exact: true }).click();
  let dialog = p.getByRole("dialog");
  assert.equal(
    await dialog
      .getByRole("textbox", { name: "订阅链接", exact: true })
      .evaluate((el) => el === document.activeElement),
    true,
    "modal focuses the primary input",
  );
  for (let i = 0; i < 14; i++) {
    await p.keyboard.press("Tab");
    assert.equal(
      await dialog.evaluate((el) => el.contains(document.activeElement)),
      true,
      "native dialog contains keyboard focus",
    );
  }

  await dialog.getByLabel("订阅名称").fill("工作网络");
  await dialog
    .getByRole("textbox", { name: "订阅链接", exact: true })
    .fill("http://example.com/subscribe");
  await dialog.getByRole("button", { name: "预览转换", exact: true }).click();
  await dialog.getByRole("alert").filter({ hasText: "HTTPS" }).waitFor();
  assert.equal(fetches, 0);
  await p.screenshot({ path: join(evidence, "subscription-error-light.png") });
  assert.ok(
    (await dialog.boundingBox()).width <= 540,
    "creation dialog remains compact at desktop width",
  );
  await dialog
    .getByRole("textbox", { name: "订阅链接", exact: true })
    .fill(`https://localhost:${server.address().port}/subscription`);
  await p.screenshot({ path: join(evidence, "subscription-light.png") });
  await dialog.getByRole("button", { name: "预览转换", exact: true }).click();
  await dialog.getByRole("button", { name: "确认导入", exact: true }).click();
  await p.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(fetches, 1);
  let snapshot = await p.evaluate(() => window.flowgate.request("snapshot"));
  assert.equal(snapshot.configuration.nodes.length, 4);
  assert.equal(snapshot.configuration.subscriptions[0].name, "工作网络");
  checks.push(
    "compact subscription dialog, local HTTPS validation, actual HTTPS import with saved source name",
  );
  await p.getByRole("button", { name: "添加订阅", exact: true }).click();
  dialog = p.getByRole("dialog");
  await dialog
    .getByRole("textbox", { name: "订阅链接", exact: true })
    .fill(`https://localhost:${server.address().port}/slow`);
  await dialog.getByRole("button", { name: "预览转换", exact: true }).click();
  await dialog.getByRole("button", { name: "取消请求", exact: true }).click();
  await dialog.getByRole("alert").filter({ hasText: "取消" }).waitFor();
  assert.equal(
    await dialog
      .getByRole("textbox", { name: "订阅链接", exact: true })
      .inputValue(),
    `https://localhost:${server.address().port}/slow`,
  );
  assert.equal(
    (await p.evaluate(() => window.flowgate.request("snapshot"))).configuration
      .subscriptions.length,
    1,
  );
  await p.keyboard.press("Escape");
  checks.push(
    "dialog cancellation retains URL and does not partially import a subscription",
  );
  const nodeRow = p
    .locator(".node")
    .filter({ has: p.getByText("Tokyo · 01", { exact: true }) });
  await nodeRow.getByRole("button", { name: "选择出口", exact: true }).click();
  await nodeRow
    .getByRole("button", { name: "✓ 已选择", exact: true })
    .waitFor();
  await p.screenshot({ path: join(evidence, "nodes-light.png") });
  await nodeRow.getByLabel("更多操作 Tokyo · 01").click();
  await nodeRow.getByRole("button", { name: "编辑", exact: true }).click();
  dialog = p.getByRole("dialog");
  await dialog.getByLabel("节点名称").fill("Tokyo · 主线路");
  await dialog.getByRole("button", { name: "保存节点" }).click();
  await dialog.waitFor({ state: "hidden" });
  await p.getByText("Tokyo · 主线路", { exact: true }).waitFor();
  await p.getByRole("button", { name: "分流规则", exact: true }).click();
  await p.getByRole("button", { name: "＋ 添加规则", exact: true }).click();
  dialog = p.getByRole("dialog");
  await dialog.getByLabel("匹配内容").fill("example.com");
  await dialog.getByRole("button", { name: "规则出口", exact: true }).click();
  const search = p.getByRole("combobox", { name: "搜索规则出口" });
  await search.fill("Tokyo");
  await p.screenshot({ path: join(evidence, "rule-picker-light.png") });
  await search.press("ArrowDown");
  await search.press("Enter");
  assert.equal(
    await dialog
      .getByRole("button", { name: "规则出口", exact: true })
      .innerText(),
    "Tokyo · 主线路",
  );
  await dialog.getByRole("button", { name: "规则出口", exact: true }).click();
  await p.keyboard.press("Escape");
  assert.equal(
    await dialog.count(),
    1,
    "Escape closes chooser before closing modal",
  );
  assert.equal(
    await dialog
      .getByRole("button", { name: "规则出口", exact: true })
      .evaluate((el) => el === document.activeElement),
    true,
  );
  await p.keyboard.press("Escape");
  assert.equal(await dialog.count(), 0);
  await p.getByRole("button", { name: "＋ 添加规则", exact: true }).click();
  dialog = p.getByRole("dialog");
  for (
    let i = 0;
    i < 50 &&
    (await dialog.getByLabel("匹配内容").inputValue()) !== "example.com";
    i++
  )
    await p.waitForTimeout(50);
  assert.equal(await dialog.getByLabel("匹配内容").inputValue(), "example.com");
  await dialog.getByRole("button", { name: "添加规则", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  snapshot = await p.evaluate(() => window.flowgate.request("snapshot"));
  assert.equal(
    snapshot.configuration.rules[0].outbound,
    snapshot.configuration.nodes.find((n) => n.name === "Tokyo · 主线路").id,
  );
  checks.push(
    "node edit, searchable grouped outlet with keyboard selection, nested Escape/focus return, rule draft restoration and persisted outlet",
  );
  const waitInput = async (expected) => {
    for (let i = 0; i < 50; i++) {
      if (
        (await p.getByLabel("匹配内容", { exact: true }).inputValue()) ===
        expected
      )
        return;
      await p.waitForTimeout(50);
    }
    assert.equal(
      await p.getByLabel("匹配内容", { exact: true }).inputValue(),
      expected,
    );
  };
  await p.getByRole("button", { name: "＋ 添加规则", exact: true }).click();
  await p.getByLabel("匹配内容", { exact: true }).fill("unsaved.example");
  await p.keyboard.press("Escape");
  await p
    .locator(".rulerow")
    .getByRole("button", { name: "编辑", exact: true })
    .click();
  await p.getByLabel("匹配内容", { exact: true }).fill("modified.example");
  await p.keyboard.press("Escape");
  await p.getByRole("button", { name: "＋ 添加规则", exact: true }).click();
  await waitInput("unsaved.example");
  await p.keyboard.press("Escape");
  await p
    .locator(".rulerow")
    .getByRole("button", { name: "编辑", exact: true })
    .click();
  await waitInput("modified.example");
  await p
    .getByRole("dialog")
    .getByRole("button", { name: "保存规则", exact: true })
    .click();
  await p.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(
    (await p.evaluate(() => window.flowgate.request("snapshot"))).configuration
      .rules[0].value,
    "modified.example",
  );
  checks.push(
    "new-rule draft and existing-rule edit draft remain independent across close/reopen",
  );
  await p.screenshot({ path: join(evidence, "rules-light.png") });
  await p.getByRole("button", { name: "设置", exact: true }).click();
  await p
    .getByRole("textbox", { name: "DNS 服务器", exact: true })
    .fill("https://9.9.9.9/dns-query");
  await p.screenshot({ path: join(evidence, "settings-light.png") });
  await p.getByRole("button", { name: "保存网络设置", exact: true }).click();
  await p
    .getByRole("status")
    .filter({ hasText: "网络设置已保存，下次启动或应用配置时生效" })
    .waitFor();
  snapshot = await p.evaluate(() => window.flowgate.request("snapshot"));
  assert.equal(
    snapshot.configuration.settings.dnsServer,
    "https://9.9.9.9/dns-query",
  );
  assert.ok(
    (await p.getByRole("spinbutton", { name: "本地端口" }).boundingBox())
      .width <= 120,
    "port keeps a short field",
  );
  await p.getByRole("button", { name: "切换深色外观" }).click();
  await p.screenshot({ path: join(evidence, "settings-dark.png") });
  await p.getByRole("button", { name: "节点与订阅", exact: false }).click();
  await p.screenshot({ path: join(evidence, "nodes-dark.png") });
  await p.getByRole("button", { name: "添加订阅", exact: true }).click();
  await p.screenshot({ path: join(evidence, "subscription-dark.png") });
  await p.keyboard.press("Escape");
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(960, 760),
  );
  for (const route of [
    "节点与订阅",
    "分流规则",
    "网络环境",
    "设置",
    "扩展",
    "连接",
    "操作记录",
  ]) {
    await p
      .getByRole("button", { name: route, exact: route !== "节点与订阅" })
      .click();
    assert.equal(
      await p.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
      route + " does not overflow narrow window",
    );
  }
  await p.getByRole("button", { name: "分流规则", exact: true }).click();
  await p.getByRole("button", { name: "＋ 添加规则", exact: true }).click();
  await p
    .getByRole("dialog")
    .getByRole("button", { name: "规则出口", exact: true })
    .click();
  const box = await p.locator(".selectpopover:popover-open").boundingBox();
  assert.ok(
    box.y >= 0 && box.y + box.height <= 760,
    "chooser stays within narrow window",
  );
  await p.screenshot({ path: join(evidence, "rule-picker-narrow-dark.png") });
  await p.keyboard.press("Escape");
  await p.keyboard.press("Escape");
  checks.push(
    "setting row proportions and persisted save, light/dark real screenshots, seven narrow pages and chooser viewport placement",
  );
  assert.deepEqual(errors, []);
  await writeFile(
    join(evidence, "design-result.json"),
    JSON.stringify(
      {
        passed: true,
        at: new Date().toISOString(),
        checks,
        scope:
          "isolated application data; local HTTPS fixture; screenshots include test resources",
      },
      null,
      2,
    ),
  );
  console.log("PASS: UI design and interaction acceptance", checks);
} finally {
  await app.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
}
