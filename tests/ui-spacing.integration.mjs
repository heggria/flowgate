// Geometry regressions use presentation fixtures; they never modify network state.
import { _electron as electron } from "playwright";
import { createUISurface } from "./fixtures/ui-surface.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
const output = "work/ui-spacing";
await mkdir(output, { recursive: true });
const fixture = await createUISurface();
const app = await electron.launch({ args: [fixture.main] });
const report = {
  pages: [],
  popovers: [],
  dialogs: [],
  menus: [],
  checks: [],
  errors: [],
};
const close = (a, b, message) =>
  assert.ok(Math.abs(a - b) <= 1, `${message}: ${a} vs ${b}`);
try {
  const p = await app.firstWindow();
  p.on("pageerror", (e) => report.errors.push(e.message));
  await p.getByRole("status").filter({ hasText: "正在连接服务" }).waitFor();
  await p.evaluate(() => uiFixture.releaseLoading());
  await p.getByRole("heading", { name: "概览", exact: true }).waitFor();
  const settle = () =>
    p.evaluate(
      () =>
        new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r)),
        ),
    );
  const nav = async (name) => {
    await p
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name, exact: true })
      .click();
    await settle();
  };
  for (const theme of ["light", "dark"]) {
    await p.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    for (const width of [1440, 1180, 1100, 960, 768, 640, 480]) {
      await app.evaluate(({ BrowserWindow }, width) => {
        const w = BrowserWindow.getAllWindows()[0],
          physical = Math.max(960, width);
        w.setSize(physical, 900);
        w.webContents.setZoomFactor(physical / width);
      }, width);
      await settle();
      close(await p.evaluate(() => innerWidth), width, "actual CSS viewport");
      for (const name of [
        "概览",
        "节点与订阅",
        "分流规则",
        "设置",
        "连接",
        "网络环境",
        "操作记录",
        "扩展",
      ]) {
        await nav(name);
        const geometry = await p.evaluate(() => {
          const box = (el) => {
            const r = el.getBoundingClientRect();
            return {
              left: r.left,
              right: r.right,
              top: r.top,
              bottom: r.bottom,
              width: r.width,
              height: r.height,
            };
          };
          const visible = (selector) =>
            Array.from(document.querySelectorAll(selector))
              .filter((el) => el.getBoundingClientRect().height > 0)
              .map(box);
          return {
            viewport: innerWidth,
            heading: box(document.querySelector(".resourceheading")),
            banner: visible(".configurationbar")[0],
            metrics: visible(".metriclabel"),
            dashboards: Array.from(
              document.querySelectorAll(".dashboardgrid"),
            ).map((el) => ({
              box: box(el),
              gap: parseFloat(getComputedStyle(el).rowGap),
              margin: parseFloat(getComputedStyle(el).marginBottom),
              panels: Array.from(el.children).map(box),
            })),
            settings: visible(".settingrow"),
            switch: Array.from(
              document.querySelectorAll(".settingcontrol > .switchinput"),
            ).map((el) => ({ input: box(el), parent: box(el.parentElement) })),
            nodeIcons: visible(".nodeicon"),
            sourceIcons: visible(".sourceicon"),
            nodeText: visible(".nodeidentity"),
            sourceText: visible(".subscriptionrow:has(.sourceicon) > div"),
            panelTitles: visible(".dashboardgrid:not(.lowergrid) .paneltitle"),
            overflow: document.documentElement.scrollWidth > innerWidth,
          };
        });
        assert.equal(geometry.overflow, false, `${name}/${width} no overflow`);
        if (geometry.banner)
          close(
            geometry.banner.left,
            geometry.heading.left,
            `${name}/${width} shared page gutter`,
          );
        if (name === "概览" && width > 1100)
          close(
            geometry.panelTitles[0].top,
            geometry.panelTitles[1].top,
            "dashboard headers share top alignment",
          );
        if (name === "概览" && width <= 1100)
          close(
            geometry.metrics[0].left,
            geometry.metrics[2].left,
            "metric rows share column origin",
          );
        if (name === "概览") {
          for (const grid of geometry.dashboards) {
            for (let i = 1; i < grid.panels.length; i++) {
              if (grid.panels[i].top > grid.panels[i - 1].top + 1)
                close(
                  grid.panels[i].top - grid.panels[i - 1].bottom,
                  grid.gap,
                  "stacked panels have one gap owner",
                );
            }
          }
          close(
            geometry.dashboards[1].box.top - geometry.dashboards[0].box.bottom,
            geometry.dashboards[0].margin,
            "dashboard sections use the declared gap",
          );
        }
        if (name === "节点与订阅") {
          close(
            geometry.nodeIcons[0].left,
            geometry.sourceIcons[0].left,
            "resource icon column",
          );
          close(
            geometry.nodeText[0].left,
            geometry.sourceText[0].left,
            "resource text column",
          );
        }
        if (name === "设置") {
          for (const row of geometry.settings)
            close(
              row.right,
              geometry.heading.right,
              "contributed settings use the same width",
            );
          for (const sw of geometry.switch) {
            close(
              sw.input.left,
              sw.parent.left,
              "switch has no UA left margin",
            );
            if (width > 640)
              close(
                sw.input.right,
                sw.parent.right,
                "switch has no UA right margin",
              );
          }
        }
        report.pages.push({ theme, width, name, geometry });
        const auditChoices = async (scope) => {
          const triggers = scope.locator(".selecttrigger");
          for (let i = 0; i < (await triggers.count()); i++) {
            const trigger = triggers.nth(i);
            if (!(await trigger.isVisible()) || (await trigger.isDisabled()))
              continue;
            await trigger.click();
            await settle();
            const popup = p.locator(".selectpopover:popover-open");
            const measurement = await popup.evaluate((el) => {
              const box = (e) => {
                const r = e.getBoundingClientRect();
                return {
                  left: r.left,
                  right: r.right,
                  top: r.top,
                  bottom: r.bottom,
                  width: r.width,
                  height: r.height,
                };
              };
              const search = el.querySelector(".selectsearch"),
                group = el.querySelector(".optiongroup"),
                option = el.querySelector(".selectoption");
              const contentLeft = (e) =>
                e.getBoundingClientRect().left +
                parseFloat(getComputedStyle(e).paddingLeft);
              return {
                popup: box(el),
                search: box(search),
                input: box(search.querySelector("input")),
                icon: box(search.querySelector("svg")),
                list: box(el.querySelector(".selectoptions")),
                groupLeft: group ? contentLeft(group) : null,
                optionLeft: option ? contentLeft(option) : null,
                option: option ? box(option) : null,
                viewport: { width: innerWidth, height: innerHeight },
              };
            });
            const anchor = await trigger.boundingBox();
            close(
              measurement.popup.left,
              anchor.x,
              "choice popup aligns to trigger left",
            );
            close(
              measurement.popup.right,
              anchor.x + anchor.width,
              "choice popup aligns to trigger right",
            );
            assert.ok(
              measurement.popup.bottom <= measurement.viewport.height - 11 &&
                measurement.popup.top >= 11,
              "popup remains within viewport",
            );
            const belowGap = measurement.popup.top - (anchor.y + anchor.height);
            const aboveGap = anchor.y - measurement.popup.bottom;
            assert.ok(
              Math.abs(belowGap - 6) <= 1 || Math.abs(aboveGap - 6) <= 1,
              `popup never overlaps trigger: ${belowGap}/${aboveGap}`,
            );
            close(
              (measurement.icon.top + measurement.icon.bottom) / 2,
              (measurement.search.top + measurement.search.bottom) / 2,
              "search icon vertically centered",
            );
            close(
              (measurement.input.top + measurement.input.bottom) / 2,
              (measurement.search.top + measurement.search.bottom) / 2,
              "search input vertically centered",
            );
            close(measurement.icon.width, 15, "search icon never shrinks");
            if (measurement.groupLeft !== null)
              close(
                measurement.groupLeft,
                measurement.icon.left,
                "group and leading icon share inset",
              );
            if (measurement.optionLeft !== null)
              close(
                measurement.optionLeft,
                measurement.icon.left,
                "option and group share inset",
              );
            close(
              measurement.search.left - measurement.popup.left,
              measurement.popup.right - measurement.search.right,
              "search has symmetric outer gutter",
            );
            assert.ok(
              measurement.list.bottom <= measurement.popup.bottom - 6,
              "scroll region respects bottom gutter",
            );
            report.popovers.push({ theme, width, name, anchor, measurement });
            if (name === "概览" && [1180, 960, 480].includes(width))
              await p.screenshot({
                path: `${output}/outlet-${theme}-${width}.png`,
              });
            await p.keyboard.press("Escape");
            assert.equal(
              await trigger.evaluate((el) => el === document.activeElement),
              true,
              "focus returns to aligned trigger",
            );
          }
        };
        await auditChoices(p);
        if (["节点与订阅", "分流规则"].includes(name)) {
          if (name === "节点与订阅") {
            const summary = p.locator(".node .actionmenu > summary").first();
            await summary.click();
            const anchor = await summary.boundingBox(),
              menu = await p.locator(".actionitems:popover-open").boundingBox();
            close(
              menu.x + menu.width,
              anchor.x + anchor.width,
              "action menu aligns to trigger end",
            );
            assert.ok(
              Math.abs(menu.y - anchor.y - anchor.height - 6) <= 1 ||
                Math.abs(anchor.y - menu.y - menu.height - 6) <= 1,
              "action menu does not overlap trigger",
            );
            report.menus.push({ theme, width, anchor, menu });
            await p.keyboard.press("Escape");
          }
          await p
            .getByRole("button", {
              name: name === "节点与订阅" ? "添加订阅" : "＋ 添加规则",
              exact: true,
            })
            .click();
          const dialog = p.getByRole("dialog");
          const heading = await dialog
              .locator(".dialogheading h2")
              .boundingBox(),
            footer = await dialog.locator(".dialogfooter").boundingBox();
          close(heading.x, footer.x, "dialog heading and footer share inset");
          for (const field of await dialog.locator(".field").all()) {
            const box = await field.boundingBox();
            if (box && box.width > footer.width * 0.8) {
              close(
                box.x,
                heading.x,
                "full-width fields align to dialog heading",
              );
              close(
                box.x + box.width,
                footer.x + footer.width,
                "dialog field and footer right edges align",
              );
            }
          }
          const buttons = await dialog
            .locator(".dialogfooter button")
            .evaluateAll((els) =>
              els.map((el) => el.getBoundingClientRect().height),
            );
          if (buttons.length > 1)
            close(
              Math.max(...buttons),
              Math.min(...buttons),
              "dialog actions share height",
            );
          report.dialogs.push({ theme, width, name, heading, footer });
          await auditChoices(dialog);
          if (width === 1180)
            await p.screenshot({
              path: `${output}/dialog-${name}-${theme}.png`,
            });
          await p.keyboard.press("Escape");
        }
        if (
          ["概览", "节点与订阅", "设置"].includes(name) &&
          [1180, 960].includes(width)
        ) {
          await p.evaluate(() => window.scrollTo(0, 0));
          await settle();
          await p.screenshot({
            path: `${output}/${name}-${theme}-${width}.png`,
          });
        }
      }
    }
  }
  // Reproduce the narrow right-column outlet at the screenshot's window size.
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setSize(1180, 820);
    w.webContents.setZoomFactor(1);
  });
  await p.evaluate(() => {
    document.documentElement.dataset.theme = "light";
  });
  await nav("概览");
  const outlet = p.locator(".exitpanel .selecttrigger");
  await outlet.click();
  await settle();
  const anchor = await outlet.boundingBox(),
    tall = await p.locator(".selectpopover:popover-open").boundingBox();
  close(
    anchor.y - tall.y - tall.height,
    6,
    "long outlet menu flips above instead of covering the trigger",
  );
  await p.keyboard.press("Escape");
  await p.evaluate(() => {
    const next = structuredClone(uiFixture.snapshot);
    next.configuration.nodes = [];
    next.configuration.externalNetworks = [];
    next.configuration.settings.selectedNode = "direct";
    uiFixture.push(next);
  });
  await settle();
  await outlet.click();
  await settle();
  const shortAnchor = await outlet.boundingBox(),
    shortMenu = await p.locator(".selectpopover:popover-open").boundingBox();
  close(
    shortMenu.y - shortAnchor.y - shortAnchor.height,
    6,
    "single-option menu fits below",
  );
  close(shortMenu.x, shortAnchor.x, "screenshot case left aligned");
  close(shortMenu.width, shortAnchor.width, "screenshot case width aligned");
  const card = await p.locator(".exitpanel").boundingBox();
  await p.screenshot({
    path: `${output}/screenshot-case-fixed.png`,
    clip: {
      x: card.x - 8,
      y: card.y - 8,
      width: card.width + 16,
      height:
        Math.max(card.height, shortMenu.y + shortMenu.height - card.y) + 16,
    },
  });
  report.reproduction = {
    window: { width: 1180, height: 820 },
    long: { anchor, menu: tall },
    single: { anchor: shortAnchor, menu: shortMenu },
  };
  assert.deepEqual(report.errors, []);
  report.checks.push(
    "112 page/theme/viewport cases; aligned popovers with no anchor overlap; symmetric insets; stable search icons; metric columns; resource columns; shared settings widths and switch edges",
  );
  await writeFile(
    `${output}/result.json`,
    JSON.stringify(
      { passed: true, at: new Date().toISOString(), ...report },
      null,
      2,
    ),
  );
  console.log(
    `PASS spacing: ${report.pages.length} page cases, ${report.popovers.length} popup cases`,
  );
} catch (error) {
  await writeFile(
    `${output}/result.json`,
    JSON.stringify({ passed: false, error: String(error), ...report }, null, 2),
  );
  throw error;
} finally {
  await app.close();
}
