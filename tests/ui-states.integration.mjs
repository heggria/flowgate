import { _electron as electron } from "playwright";
import { createUISurface } from "./fixtures/ui-surface.mjs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
const fixture = await createUISurface(),
  evidence = resolve("work/ui-audit/states");
await mkdir(evidence, { recursive: true });
const app = await electron.launch({ args: [fixture.main] }),
  checks = [],
  failures = [];
try {
  const p = await app.firstWindow();
  p.setDefaultTimeout(10000);
  const pageErrors = [];
  p.on("pageerror", (e) => pageErrors.push(e.message));
  const capture = async (name) => {
    await p.screenshot({ path: join(evidence, name + ".png") });
  };
  await p.getByRole("status").filter({ hasText: "正在连接服务" }).waitFor();
  await capture("loading");
  await p.evaluate(() => window.uiFixture.releaseLoading());
  await p.getByRole("heading", { name: "概览", exact: true }).waitFor();
  const nav = async (name) => {
    await p
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name, exact: true })
      .click();
    await p.getByRole("heading", { name, exact: true }).first().waitFor();
  };
  const scan = async (name) => {
    await capture(name);
    await p.evaluate(
      await readFile(resolve("node_modules/axe-core/axe.min.js"), "utf8"),
    );
    const r = await p.evaluate(async () => {
      const r = await axe.run(document, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
      });
      return r.violations.map((v) => ({
        id: v.id,
        nodes: v.nodes.map((n) => ({
          target: n.target,
          summary: n.failureSummary,
        })),
      }));
    });
    if (r.length) failures.push({ name, violations: r });
    assert.equal(
      await p.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
      name + " fits",
    );
    await capture(name);
  };
  const before = await p.evaluate(() =>
    structuredClone(window.uiFixture.snapshot),
  );
  for (const theme of ["light", "dark"]) {
    if ((await p.locator("html").getAttribute("data-theme")) !== theme)
      await p
        .getByRole("button", {
          name: theme === "dark" ? "切换深色外观" : "切换浅色外观",
        })
        .click();
    for (const name of [
      "概览",
      "节点与订阅",
      "分流规则",
      "网络环境",
      "操作记录",
      "扩展",
      "设置",
    ]) {
      await nav(name);
      await scan(name + "-" + theme);
    }
    await nav("连接");
    await p.locator(".targetbutton").first().click();
    await scan("connection-details-" + theme);
    await p.keyboard.press("Escape");
    await nav("扩展");
    const error = p
      .getByRole("article")
      .filter({ has: p.getByRole("alert") })
      .first();
    await error.waitFor();
    assert.equal(
      await error
        .getByRole("alert")
        .evaluate((el) => getComputedStyle(el).color),
      await p.evaluate(() => {
        const probe = document.createElement("span");
        probe.style.color = "var(--danger)";
        document.body.append(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
      }),
      "extension error uses shared danger color",
    );
    await p
      .getByRole("button", { name: /查看 .* 详情/ })
      .first()
      .click();
    await p.getByText("技术信息与故障追踪", { exact: true }).click();
    await scan("extension-expanded-" + theme);
    await p.keyboard.press("Escape");
    await nav("设置");
    await p.getByText("组件版本", { exact: true }).click();
    await scan("update-metadata-" + theme);
    await p.evaluate(() => {
      uiFixture.release.revoked = [uiFixture.release.release];
    });
    await nav("概览");
    await nav("设置");
    await scan("update-revoked-" + theme);
    await p.evaluate(() => {
      uiFixture.release.revoked = [];
      uiFixture.outcomes["release.check"] = "hold";
    });
    await p.getByRole("button", { name: "检查更新", exact: true }).click();
    await p.getByRole("button", { name: "检查中…" }).waitFor();
    assert.equal(
      await p.getByRole("button", { name: "检查中…" }).isDisabled(),
      true,
    );
    assert.equal(
      await p
        .getByRole("button", { name: "更新通道", exact: true })
        .isDisabled(),
      true,
    );
    await capture("update-pending-" + theme);
    await p.evaluate(() =>
      uiFixture.finish("release.check", "测试：更新验证未通过。"),
    );
    await p
      .getByRole("alert")
      .filter({ hasText: "测试：更新验证未通过。" })
      .first()
      .waitFor();
    await scan("update-error-" + theme);
    assert.equal(
      await p.getByRole("button", { name: "关闭错误" }).count(),
      0,
      "update failure stays local",
    );
    await p.evaluate(() => {
      delete uiFixture.outcomes["release.check"];
    });
    await p.getByRole("button", { name: "检查更新", exact: true }).click();
    await p.getByRole("region", { name: "候选版本详情" }).waitFor();
    await scan("update-candidate-" + theme);
    await nav("操作记录");
    await p.getByText("服务诊断", { exact: true }).click();
    await p.evaluate(() => {
      uiFixture.outcomes["diagnostics.trace"] = "hold";
    });
    await p.getByRole("button", { name: "读取最近调用" }).click();
    await p.getByRole("button", { name: "读取中…" }).waitFor();
    const count = await p.evaluate(() => uiFixture.calls["diagnostics.trace"]);
    await p.keyboard.press("Enter");
    assert.equal(
      await p.evaluate(() => uiFixture.calls["diagnostics.trace"]),
      count,
    );
    await p.evaluate(() =>
      uiFixture.finish("diagnostics.trace", "测试：诊断读取失败。"),
    );
    await p
      .getByRole("alert")
      .filter({ hasText: "测试：诊断读取失败。" })
      .waitFor();
    await scan("diagnostics-error-" + theme);
    await nav("节点与订阅");
    await p.getByRole("button", { name: "导入资源", exact: true }).click();
    let dialog = p.getByRole("dialog");
    await dialog
      .getByRole("textbox", { name: "订阅链接", exact: true })
      .fill("https://example.com/fixture");
    await p.evaluate(() => {
      uiFixture.outcomes["subscription.preview"] = "hold";
    });
    await dialog.getByRole("button", { name: "预览转换", exact: true }).click();
    await dialog.getByRole("button", { name: "取消请求" }).waitFor();
    await p.keyboard.press("Escape");
    assert.equal(await dialog.isVisible(), true);
    await scan("subscription-pending-" + theme);
    await dialog.getByRole("button", { name: "取消请求" }).click();
    await dialog.getByRole("alert").waitFor();
    await scan("subscription-cancelled-" + theme);
    await p.keyboard.press("Escape");
    await p.evaluate((next) => uiFixture.push(next), before);
  }
  checks.push(
    "presentation-only fixtures: loading, pending, revoked/candidate/error updates, extension failures/details, diagnostic failure, cancelling import, pending/applied config, synthetic chart/flow details",
  );
  await writeFile(
    join(evidence, "result.json"),
    JSON.stringify(
      { passed: !failures.length, checks, axe: failures, pageErrors },
      null,
      2,
    ),
  );
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(failures, []);
  console.log("PASS: UI state presentation and accessibility", checks);
} finally {
  await writeFile(
    join(evidence, "findings.json"),
    JSON.stringify(failures, null, 2),
  );
  await app.close();
}
