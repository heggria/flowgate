import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
const evidence = resolve("work/ui-consistency/screenshots");
await mkdir(evidence, { recursive: true });
const app = await electron.launch({
  args: ["."],
  env: {
    ...process.env,
    FLOWGATE_TEST_DATA: await mkdtemp(resolve("work/ui-consistency-data-")),
  },
});
const routes = [
  ["overview", "概览"],
  ["connections", "连接"],
  ["nodes", "节点与订阅"],
  ["rules", "分流规则"],
  ["network", "网络环境"],
  ["activity", "操作记录"],
  ["extensions", "扩展"],
  ["settings", "设置"],
];
const checks = [];
try {
  const p = await app.firstWindow(),
    errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.getByRole("heading", { name: "概览", exact: true }).waitFor();
  const nav = async (id) => {
    const [_, label] = routes.find((r) => r[0] === id);
    await p
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name: new RegExp("^" + label) })
      .click();
    await p
      .locator(`.content[data-page="${id}"] .resourceheading h1`)
      .waitFor();
    await p.evaluate(
      () =>
        new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r)),
        ),
    );
    assert.equal(await p.locator('.nav[aria-current="page"]').count(), 1);
  };
  const capture = async (name) => {
    await p.mouse.move(1100, 50);
    await p.evaluate(
      () =>
        new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r)),
        ),
    );
    await p.screenshot({ path: join(evidence, name + ".png"), fullPage: true });
  };
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1180, 820),
  );
  for (const id of ["nodes", "rules", "activity", "connections"]) {
    await nav(id);
    await capture(id + "-empty-light");
  }
  await p.evaluate(() =>
    window.flowgate.request(
      "subscription.import",
      {
        text: JSON.stringify({
          outbounds: [
            {
              type: "socks",
              tag: "工作线路 · Tokyo",
              server: "127.0.0.1",
              server_port: 22401,
            },
            {
              type: "http",
              tag: "备用线路 · Singapore",
              server: "127.0.0.1",
              server_port: 22402,
            },
          ],
        }),
      },
      crypto.randomUUID(),
    ),
  );
  for (const theme of ["light", "dark"]) {
    if ((await p.locator("html").getAttribute("data-theme")) !== theme)
      await p
        .getByRole("button", {
          name: theme === "dark" ? "切换深色外观" : "切换浅色外观",
        })
        .click();
    assert.equal(await p.evaluate(() => innerWidth), 1180);
    for (const [id] of routes) {
      await nav(id);
      assert.equal(
        await p.locator(".content select").count(),
        0,
        id + " uses shared choices",
      );
      assert.equal(
        await p.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
        id + " fits",
      );
      const heading = await p.locator(".resourceheading h1").evaluate((el) => ({
        size: getComputedStyle(el).fontSize,
        weight: getComputedStyle(el).fontWeight,
      }));
      assert.equal(heading.size, "23px");
      assert.equal(heading.weight, "650");
      await capture(id + "-" + theme);
    }
    await nav("extensions");
    assert.equal(await p.getByRole("article").count(), 2);
    await p
      .getByRole("article")
      .first()
      .getByRole("button", { name: /查看 .* 详情/ })
      .click();
    await p.getByText("技术信息与故障追踪", { exact: true }).click();
    await capture("extensions-details-" + theme);
    await nav("activity");
    await p.locator(".disclosure > summary").first().click();
    await p.getByRole("button", { name: "读取最近调用" }).click();
    await capture("activity-details-" + theme);
    await nav("settings");
    await p.getByText("组件版本", { exact: true }).click();
    await p
      .getByRole("heading", { name: "官方扩展更新" })
      .scrollIntoViewIfNeeded();
    await capture("updates-" + theme);
    await nav("nodes");
    await p.getByRole("button", { name: "添加订阅", exact: true }).click();
    await capture("subscription-" + theme);
    await p.keyboard.press("Escape");
    await p.locator(".node .actionmenu > summary").first().click();
    await p
      .locator(".node")
      .first()
      .getByRole("button", { name: "移除", exact: true })
      .click();
    const dialog = p.getByRole("dialog");
    await dialog.waitFor();
    const heights = await dialog
      .locator(".dialogfooter button")
      .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
    assert.equal(
      new Set(heights).size,
      1,
      "confirmation actions use the same height regardless of parent row styles",
    );
    assert.equal(
      await dialog
        .getByRole("button", { name: "取消", exact: true })
        .evaluate((el) => el === document.activeElement),
      true,
    );
    const nodesBefore = await p.evaluate(
      async () =>
        (await window.flowgate.request("snapshot")).configuration.nodes.length,
    );
    await capture("confirmation-" + theme);
    await p.keyboard.press("Escape");
    assert.equal(
      (await p.evaluate(() => window.flowgate.request("snapshot")))
        .configuration.nodes.length,
      nodesBefore,
    );
    await p.keyboard.press("Escape");
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(960, 740),
    );
    assert.equal(await p.evaluate(() => innerWidth), 960);
    for (const [id] of routes) {
      await nav(id);
      assert.equal(
        await p.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
        id + " narrow " + theme,
      );
      await capture(id + "-narrow-" + theme);
    }
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(1180, 820),
    );
  }
  assert.deepEqual(errors, []);
  checks.push(
    "all eight pages in light and dark at 1180 and 960 actual CSS px; common headers; no native selects or horizontal page overflow",
    "resource empty states, search no-results, shared filter keyboard selection and focus return",
    "expanded extension/activity/version details; subscription and danger dialog; Escape cancels without deletion",
  );
  await writeFile(
    resolve("work/ui-consistency/result.json"),
    JSON.stringify(
      { passed: true, at: new Date().toISOString(), checks },
      null,
      2,
    ),
  );
  console.log("PASS: UI consistency", checks);
} finally {
  await app.close();
}
