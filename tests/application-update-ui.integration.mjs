// Presentation/event contract acceptance only; no signed feed or real download.
import { _electron as electron } from "playwright";
import { createUISurface } from "./fixtures/ui-surface.mjs";
import assert from "node:assert/strict";
const fixture = await createUISurface();
const app = await electron.launch({ args: [fixture.main] });
try {
  const p = await app.firstWindow();
  p.setDefaultTimeout(5000);
  await p.waitForFunction(() => Boolean(window.uiFixture));
  const state = async (phase, message, revision) =>
    p.evaluate(
      ({ phase, message, revision }) => {
        const value = { phase, message, revision, configured: true };
        window.uiFixture.release.application = value;
        window.uiFixture.applicationListener?.(value);
      },
      { phase, message, revision },
    );
  await state("checking", "正在检查应用更新", 1);
  await p.evaluate(() => window.uiFixture.releaseLoading());
  const nav = async (name) =>
    p
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name, exact: true })
      .click();
  await nav("设置");
  await p.getByRole("status").filter({ hasText: "正在检查应用更新" }).waitFor();
  assert.equal(
    await p
      .getByRole("button", { name: "检查完整应用更新", exact: true })
      .isDisabled(),
    true,
  );
  await state("downloading", "正在下载完整应用更新", 2);
  await p
    .getByRole("status")
    .filter({ hasText: "正在下载完整应用更新" })
    .waitFor();
  await nav("概览");
  await state("failed", "应用更新失败，当前版本保留", 3);
  await nav("设置");
  await p
    .getByRole("alert")
    .filter({ hasText: "应用更新失败，当前版本保留" })
    .waitFor();
  assert.equal(
    await p
      .getByRole("button", { name: "检查完整应用更新", exact: true })
      .isEnabled(),
    true,
  );
  await state("ready", "完整应用更新已下载，下次启动时安装", 5);
  await state("checking", "过期检查结果", 4);
  await p
    .getByRole("status")
    .filter({ hasText: "完整应用更新已下载，下次启动时安装" })
    .waitFor();
  assert.equal(await p.getByText("过期检查结果").count(), 0);
  assert.equal(
    await p
      .getByRole("button", { name: "检查完整应用更新", exact: true })
      .isDisabled(),
    true,
  );
  console.log(
    "Application update UI events, remount, retry and stale snapshot checks passed (fixture only)",
  );
} finally {
  await app.close();
}

// Real main/preload/renderer IPC on an isolated unpackaged app. No feed access.
const { mkdtemp } = await import("node:fs/promises");
const { resolve } = await import("node:path");
const data = await mkdtemp(resolve("work/application-update-ipc-"));
const real = await electron.launch({
  args: ["."],
  env: { ...process.env, FLOWGATE_TEST_DATA: data },
});
try {
  const p = await real.firstWindow();
  await p
    .getByRole("heading", { name: "概览", exact: true })
    .waitFor({ timeout: 30000 });
  const result = await p.evaluate(async () => {
    const received = [];
    const unsubscribe = window.shell.onApplicationUpdate((s) =>
      received.push(s),
    );
    const before = await window.shell.request("release.status");
    let error;
    try {
      await window.shell.request("application.check");
    } catch (e) {
      error = String(e);
    }
    const after = await window.shell.request("release.status");
    unsubscribe();
    return {
      before: before.application,
      after: after.application,
      received,
      error,
    };
  });
  assert.equal(result.before.phase, "idle");
  assert.equal(result.after.phase, "failed");
  assert.equal(result.received.at(-1)?.phase, "failed");
  assert.ok(result.error);
  await p
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "设置", exact: true })
    .click();
  await p
    .getByRole("alert")
    .filter({ hasText: result.after.message })
    .waitFor();
  console.log(
    "Real isolated application update IPC and persisted error UI passed; no signed feed/download tested",
  );
} finally {
  await real.close();
}
