// Real renderer interaction contract; fixture outcomes are presentation evidence only.
import { _electron as electron } from "playwright";
import { createUISurface } from "./fixtures/ui-surface.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
const fixture = await createUISurface();
const evidence = "work/interaction-fixes";
await mkdir(evidence, { recursive: true });
const app = await electron.launch({ args: [fixture.main] });
const checks = [];
try {
  const p = await app.firstWindow();
  await p.getByRole("status").filter({ hasText: "正在连接服务" }).waitFor();
  await p.evaluate(() => uiFixture.releaseLoading());
  await p.getByRole("heading", { name: "概览", exact: true }).waitFor();
  const nav = async (name) => {
    await p
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name, exact: true })
      .click();
  };
  const focus = async (l) =>
    assert.equal(await l.evaluate((el) => el === document.activeElement), true);
  const style = async (l) =>
    l.evaluate((el) => {
      const s = getComputedStyle(el);
      return [
        s.backgroundColor,
        s.borderColor,
        s.filter,
        s.outlineWidth,
        s.outlineColor,
      ].join("|");
    });
  for (const theme of ["light", "dark"]) {
    await p.evaluate(
      (t) => (document.documentElement.dataset.theme = t),
      theme,
    );
    await nav("节点与订阅");
    const add = p.getByRole("button", { name: "导入资源", exact: true });
    // Explicit CSS probes ensure every action family is covered even when the route has no disabled action.
    for (const className of [
      "primary",
      "secondary",
      "quiet",
      "iconbutton",
      "dangerbutton",
    ]) {
      await p.evaluate((className) => {
        const el = document.createElement("button");
        el.id = "disabled-probe";
        el.className = className;
        el.textContent = "测试不可用操作";
        el.disabled = true;
        el.style.cssText =
          "position:fixed;right:20px;bottom:100px;z-index:1000";
        document.body.append(el);
      }, className);
      const probe = p.locator("#disabled-probe");
      await p.mouse.move(900, 40);
      const rest = await style(probe);
      await probe.hover({ force: true });
      await p.waitForTimeout(150);
      assert.equal(
        await style(probe),
        rest,
        `${className} disabled hover unchanged`,
      );
      await probe.evaluate((el) => el.remove());
    }

    await add.hover();
    await p.waitForTimeout(150);
    const hover = await style(add);
    await p.mouse.down();
    await p.waitForTimeout(150);
    assert.notEqual(await style(add), hover, "pressed differs from hover");
    await p.mouse.move(900, 65);
    await p.mouse.up();
    assert.equal(await p.getByRole("dialog").count(), 0, "drag away cancels");
    const search = p.locator(".searchfield input").first();
    await search.fill("no-result");
    await search.press("Tab");
    const clear = p.locator(".searchfield button").first();
    await focus(clear);
    assert.equal(
      await clear
        .locator("..")
        .evaluate((el) => getComputedStyle(el).outlineStyle),
      "none",
      "only clear owns focus",
    );
    await clear.press("Enter");
    await focus(search);
    assert.equal(await search.inputValue(), "");
    const ns = p.getByRole("textbox", { name: "查找功能", exact: true });
    await ns.focus();
    assert.equal(
      await ns.evaluate((el) => getComputedStyle(el).outlineStyle),
      "none",
      "sidebar input no inner focus",
    );
    assert.equal(
      await ns
        .locator("..")
        .evaluate((el) => getComputedStyle(el).outlineWidth),
      "2px",
    );
    await add.click();
    const dialog = p.getByRole("dialog");
    const url = dialog.getByRole("textbox", { name: "订阅链接", exact: true });
    await url.fill("https://example.com/test");
    await p.evaluate(
      () => (uiFixture.outcomes["subscription.preview"] = "hold"),
    );
    const submit = dialog.getByRole("button", {
      name: "预览转换",
      exact: true,
    });
    await submit.hover();
    await p.waitForTimeout(150);
    const primaryHover = await style(submit);
    await p.mouse.down();
    await p.waitForTimeout(150);
    assert.notEqual(
      await style(submit),
      primaryHover,
      "primary has distinct pressed treatment",
    );
    await p.mouse.move(900, 40);
    await p.mouse.up();
    await submit.focus();
    await p.keyboard.press("Enter");
    const processing = dialog.getByRole("button", { name: "处理中…" });
    await processing.waitFor();
    await focus(processing);
    assert.equal(await processing.getAttribute("aria-busy"), "true");
    const count = await p.evaluate(
      () => uiFixture.calls["subscription.preview"],
    );
    await p.keyboard.press("Enter");
    await p.keyboard.press("Space");
    assert.equal(
      await p.evaluate(() => uiFixture.calls["subscription.preview"]),
      count,
    );
    await p.evaluate(() =>
      uiFixture.finish("subscription.preview", "测试失败"),
    );
    await dialog.getByRole("alert").waitFor();
    await focus(dialog.getByRole("button", { name: "预览转换", exact: true }));
    await p.keyboard.press("Escape");
    await nav("设置");
    const disabled = p.locator("button:disabled").first();
    if (await disabled.count()) {
      await p.mouse.move(900, 40);
      const rest = await style(disabled);
      await disabled.hover({ force: true });
      await p.waitForTimeout(150);
      assert.equal(await style(disabled), rest, "disabled cannot hover");
    }
    const radio = p.locator(".modecard input").first();
    await p.keyboard.press("Tab");
    await radio.focus();
    assert.equal(
      await radio
        .locator("..")
        .evaluate((el) => getComputedStyle(el).outlineWidth),
      "2px",
    );
    assert.equal(
      await radio.evaluate((el) => getComputedStyle(el).outlineStyle),
      "none",
    );
    const card = radio.locator("..");
    await card.hover();
    const cardHover = await style(card);
    await p.mouse.down();
    assert.notEqual(await style(card), cardHover, "radio card press distinct");
    await p.mouse.move(900, 40);
    await p.mouse.up();
    const sw = p.locator("input.switchinput").first();
    const box = await sw.boundingBox();
    assert.ok(box.width >= 24 && box.height >= 24, "switch hit size");
    await sw.hover();
    const switchHover = await style(sw);
    await p.mouse.down();
    assert.notEqual(await style(sw), switchHover);
    await p.mouse.move(900, 40);
    await p.mouse.up();
    await p.evaluate(() => (uiFixture.outcomes["configuration.save"] = "hold"));
    await sw.focus();
    await sw.press("Space");
    await p.waitForFunction(
      () =>
        document.querySelector("#auto-connect").getAttribute("aria-busy") ===
        "true",
    );
    await focus(sw);
    const writes = await p.evaluate(
      () => uiFixture.calls["configuration.save"],
    );
    await sw.press("Space");
    assert.equal(
      await p.evaluate(() => uiFixture.calls["configuration.save"]),
      writes,
    );
    await p.evaluate(() =>
      uiFixture.finish("configuration.save", "测试开关保存失败"),
    );
    await p.getByRole("button", { name: "关闭错误" }).waitFor();
    await focus(sw);
    await p.getByRole("button", { name: "关闭错误" }).click();
    await p.evaluate(() => delete uiFixture.outcomes["configuration.save"]);
    await p.screenshot({ path: `${evidence}/states-${theme}.png` });
    checks.push(
      `${theme}: press cancellation, single focus, clear focus return, pending duplicate guard and failure focus, disabled hover, switch target/press`,
    );
  }
  await nav("设置");
  const choice = p.locator(".selecttrigger").first();
  await choice.click();
  await p.evaluate(() => document.dispatchEvent(new Event("scroll")));
  assert.equal(
    await choice.getAttribute("aria-expanded"),
    "true",
    "queued scroll without anchor movement keeps popup open",
  );
  const input = p.locator(".selectsearch input");
  await input.fill("test");
  await p.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  await focus(input);
  assert.equal(await choice.getAttribute("aria-expanded"), "true");
  for (const key of ["Home", "End"])
    assert.equal(
      await input.evaluate((el, key) => {
        const event = new KeyboardEvent("keydown", {
          key,
          bubbles: true,
          cancelable: true,
        });
        el.dispatchEvent(event);
        return event.defaultPrevented;
      }, key),
      false,
      "native editing key preserved",
    );
  await input.press("ArrowLeft");
  assert.equal(await input.evaluate((el) => el.selectionStart), 3);
  await input.fill("");
  await input.press("ArrowDown");
  assert.ok(await input.getAttribute("aria-activedescendant"));
  await input.press("Escape");
  await focus(choice);
  const themeButton = p.getByRole("button", { name: /切换.*外观/ });
  await themeButton.focus();
  const titled = p
    .locator("button[aria-describedby]")
    .filter({ hasText: "概览" })
    .first();
  await titled.focus();
  await p.getByRole("tooltip").filter({ hasText: "概览" }).waitFor();
  await p.keyboard.press("Escape");
  assert.equal(await p.locator("[role=tooltip]:popover-open").count(), 0);
  await p.emulateMedia({ reducedMotion: "reduce", forcedColors: "active" });
  await choice.focus();
  assert.equal(
    await choice.evaluate((el) => getComputedStyle(el).outlineStyle),
    "solid",
  );
  assert.equal(
    await choice.evaluate((el) => getComputedStyle(el).transitionDuration),
    "0s",
  );
  checks.push(
    "combobox text editing and arrow navigation, tooltip keyboard/Escape, reduced motion and forced colors",
  );
  await writeFile(
    `${evidence}/result.json`,
    JSON.stringify({ passed: true, checks }, null, 2),
  );
  console.log("PASS", checks);
} finally {
  await app.close();
}
