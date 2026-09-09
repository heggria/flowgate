import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
const output = resolve(
  process.env.AUDIT_OUTPUT || "work/ui-audit/layout-final",
);
await mkdir(output, { recursive: true });
const app = await electron.launch({
  args: ["."],
  env: {
    ...process.env,
    FLOWGATE_TEST_DATA: await mkdtemp(resolve("work/ui-audit-data-")),
  },
});
const report = {
  viewports: [],
  pages: [],
  dialogs: [],
  axe: [],
  errors: [],
  interactionFailures: [],
};
try {
  const p = await app.firstWindow();
  p.setDefaultTimeout(4000);
  p.on("pageerror", (e) => report.errors.push(e.message));
  await p.getByRole("heading", { name: "概览", exact: true }).waitFor();
  report.window = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    return {
      visible: w.isVisible(),
      focusable: w.isFocusable(),
      minimum: w.getMinimumSize(),
    };
  });
  if (report.window.visible || report.window.focusable)
    throw Error("Test window must remain hidden/non-focusable");
  await p.evaluate(async () => {
    await window.flowgate.request(
      "subscription.import",
      {
        text: JSON.stringify({
          outbounds: Array.from({ length: 12 }, (_, i) => ({
            type: "socks",
            tag: i === 0 ? "名称".repeat(95) : "测试线路 " + (i + 1),
            server: "127.0.0.1",
            server_port: 24001 + i,
          })),
        }),
      },
      crypto.randomUUID(),
    );
    const s = await window.flowgate.request("snapshot"),
      c = s.configuration;
    c.externalNetworks = [
      {
        id: "audit-network",
        name: "外部工作网络".repeat(15),
        interface: "en0",
        dnsServer:
          "https://" +
          ("abcdefghij".repeat(6) + ".").repeat(3) +
          "example.com/dns-query",
      },
    ];
    c.rules = [
      {
        id: "audit-rule",
        kind: "domain_suffix",
        value: ("abcdefghij".repeat(6) + ".").repeat(3) + "example.com",
        outbound: c.nodes[0].id,
      },
    ];
    await window.flowgate.request("configuration.save", c, crypto.randomUUID());
  });
  const names = {
    overview: "概览",
    connections: "连接",
    nodes: "节点与订阅",
    rules: "分流规则",
    network: "网络环境",
    activity: "操作记录",
    extensions: "扩展",
    settings: "设置",
  };
  const settle = async () =>
    p.evaluate(
      () =>
        new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r)),
        ),
    );
  const nav = async (id) => {
    const button = p
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name: new RegExp("^" + names[id]) });
    try {
      await button.click();
    } catch (e) {
      report.interactionFailures.push({
        id,
        viewport: await p.evaluate(() => ({
          width: innerWidth,
          height: innerHeight,
        })),
        reason: e.message.slice(0, 300),
      });
      throw e;
    }
    await p.locator('.content[data-page="' + id + '"] h1').waitFor();
    await settle();
  };
  const measure = async () =>
    p.evaluate(() => {
      const box = (el) => {
        const r = el.getBoundingClientRect();
        return {
          x: Math.round(r.x),
          y: Math.round(r.y),
          w: Math.round(r.width),
          h: Math.round(r.height),
        };
      };
      return {
        width: innerWidth,
        height: innerHeight,
        scrollWidth: document.documentElement.scrollWidth,
        sidebar: box(document.querySelector(".sidebar")),
        sidebarScroll: {
          height: document.querySelector(".sidebar").clientHeight,
          scroll: document.querySelector(".sidebar").scrollHeight,
        },
        overflows: [
          ...document.querySelectorAll(
            ".resourcetools,.settingrow,.modecard,.subscriptionrow,.entry,.dialogfooter,.extensionheading,.headingactions",
          ),
        ]
          .filter((el) => el.scrollWidth > el.clientWidth + 2)
          .map((el) => ({
            class: el.className,
            box: box(el),
            scroll: el.scrollWidth,
            text: el.textContent.slice(0, 70),
          })),
        tables: [...document.querySelectorAll(".connectionpanel")].map(
          (panel) => ({
            panel: box(panel),
            table: box(panel.querySelector(".tablewrap")),
            padding: getComputedStyle(panel).paddingLeft,
          }),
        ),
        danger: [...document.querySelectorAll("button.dangertext")].map(
          (el) => ({
            color: getComputedStyle(el).color,
            expected: getComputedStyle(document.documentElement)
              .getPropertyValue("--danger")
              .trim(),
          }),
        ),
      };
    });
  const axe = async (label) => {
    await p.evaluate(
      await readFile("node_modules/axe-core/axe.min.js", "utf8"),
    );
    const v = await p.evaluate(async () => {
      const r = await window.axe.run(document, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
      });
      return r.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        nodes: v.nodes.map((n) => ({
          target: n.target,
          summary: n.failureSummary,
        })),
      }));
    });
    report.axe.push({ label, violations: v });
  };
  for (const theme of ["light", "dark"]) {
    if ((await p.locator("html").getAttribute("data-theme")) !== theme)
      await p
        .getByRole("button", {
          name: theme === "dark" ? "切换深色外观" : "切换浅色外观",
        })
        .click();
    for (const [width, height, zoom] of [
      [1440, 900, 1],
      [1180, 820, 1],
      [960, 650, 1],
      [960, 650, 1.25],
      [960, 650, 1.5],
      [960, 650, 2],
    ]) {
      await app.evaluate(
        ({ BrowserWindow }, { width, height, zoom }) => {
          const w = BrowserWindow.getAllWindows()[0];
          w.setSize(width, height);
          w.webContents.setZoomFactor(zoom);
        },
        { width, height, zoom },
      );
      await settle();
      const vp = await p.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
      }));
      report.viewports.push({
        theme,
        requested: { width, height, zoom },
        actual: vp,
      });
      for (const id of Object.keys(names)) {
        await nav(id);
        const measurement = await measure();
        report.pages.push({
          theme,
          id,
          zoom,
          requestedWidth: width,
          ...measurement,
        });
        if ((zoom === 1 && width === 1180) || zoom === 1.5) {
          const png = await app.evaluate(async ({ BrowserWindow }) =>
            (await BrowserWindow.getAllWindows()[0].webContents.capturePage())
              .toPNG()
              .toString("base64"),
          );
          await writeFile(
            join(output, id + "-" + theme + "-" + zoom + ".png"),
            Buffer.from(png, "base64"),
          );
        }
        if (zoom === 1 && width === 1180) await axe(id + "-" + theme);
      }
      await nav("nodes");
      await p.getByRole("button", { name: "添加订阅", exact: true }).click();
      await settle();
      report.dialogs.push({
        name: "subscription",
        theme,
        zoom,
        requestedWidth: width,
        ...(await measure()),
        dialog: await p.getByRole("dialog").boundingBox(),
      });
      if (width === 1180 && zoom === 1) await axe("subscription-" + theme);
      await p.keyboard.press("Escape");
    }
  }
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setSize(960, 650);
    w.webContents.setZoomFactor(1);
  });
  await nav("nodes");
  const menu = p.locator(".node .actionmenu > summary").nth(8);
  await menu.evaluate((el) =>
    window.scrollTo(
      0,
      scrollY + el.getBoundingClientRect().top - (innerHeight - 45),
    ),
  );
  await menu.click();
  await settle();
  report.menu = {
    viewport: await p.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
    })),
    trigger: await menu.boundingBox(),
    panel: await p
      .locator(".node .actionmenu[open] .actionitems")
      .boundingBox(),
  };
  await p.screenshot({ path: join(output, "menu-bottom.png") });
  assert.ok(
    report.menu.panel.y >= 12 &&
      report.menu.panel.y + report.menu.panel.height <=
        report.menu.viewport.height - 12,
    "action menu flips at viewport edge",
  );
  await p.keyboard.press("Escape");
  await settle();
  assert.equal(
    await menu.evaluate((el) => el === document.activeElement),
    true,
    "menu Escape restores focus",
  );
  await menu.press("ArrowDown");
  await p.locator(".actionitems:popover-open").waitFor();
  await p.keyboard.press("End");
  await p.keyboard.press("Enter");
  const dialog = p.getByRole("dialog");
  await dialog.waitFor();
  assert.equal(
    await dialog.evaluate((el) => el.parentElement === document.body),
    true,
    "dialog is isolated from resource row styles",
  );
  assert.equal(
    await dialog
      .getByRole("button", { name: "取消", exact: true })
      .evaluate((el) => el === document.activeElement),
    true,
  );
  await p.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await settle();
  assert.equal(
    await menu.evaluate((el) => el === document.activeElement),
    true,
    "dialog Escape restores persistent menu trigger",
  );
  await menu.click();
  await p.locator(".actionitems:popover-open").waitFor();
  await p.evaluate(() => window.scrollBy(0, 20));
  await p.locator(".actionitems:popover-open").waitFor({ state: "hidden" });
  for (const page of report.pages) {
    assert.ok(
      page.scrollWidth <= page.width,
      page.id + " page overflow at " + page.width,
    );
    assert.deepEqual(
      page.overflows,
      [],
      page.id + " row overflow at " + page.width,
    );
    for (const t of page.tables) {
      assert.ok(
        t.table.x >= t.panel.x - 1 &&
          t.table.x + t.table.w <= t.panel.x + t.panel.w + 1,
        "table inside panel at " + page.width,
      );
    }
  }
  for (const d of report.dialogs) {
    assert.ok(
      d.dialog.x >= 0 && d.dialog.x + d.dialog.width <= d.width,
      "dialog horizontal bounds",
    );
    assert.ok(
      d.dialog.y >= 0 && d.dialog.y + d.dialog.height <= d.height + 1,
      "dialog vertical bounds",
    );
    assert.deepEqual(d.overflows, []);
  }
  assert.deepEqual(
    report.axe.filter((a) => a.violations.length),
    [],
  );
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.interactionFailures, []);
  report.passed = true;
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(
    "PASS: " +
      report.pages.length +
      " page/theme/viewport cases; long resources; actual 480–1440 CSS px; axe; popup edge, keyboard, portal and focus restoration",
  );
} finally {
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  await app.close();
}
