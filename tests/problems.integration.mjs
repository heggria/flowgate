import { _electron as electron } from "playwright";
import { createUISurface } from "./fixtures/ui-surface.mjs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
const fixture = await createUISurface();
const app = await electron.launch({ args: [fixture.main] });
await mkdir("work/problems-sidebar", { recursive: true });
const checks = [];
try {
  const p = await app.firstWindow();
  p.setDefaultTimeout(10000);
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.waitForFunction(() => Boolean(window.uiFixture));
  await p.evaluate(() => {
    uiFixture.snapshot.operations = [];
    uiFixture.releaseLoading();
  });
  await p.getByRole("heading", { name: "概览", exact: true }).waitFor();
  const nav = p.getByRole("button", { name: "问题与恢复", exact: true });
  assert.equal(await nav.count(), 0);
  await p.evaluate(() => {
    uiFixture.push({
      ...uiFixture.snapshot,
      kernel: { status: "stopped", systemControl: false },
    });
    uiFixture.outcomes["proxy.connect"] =
      "EADDRINUSE address already in use https://private:secret@example.com?token=hidden";
  });
  await p.getByRole("button", { name: "启动代理", exact: true }).waitFor();
  const before = await p
    .getByRole("heading", { name: "概览", exact: true })
    .boundingBox();
  await p.getByRole("button", { name: "启动代理", exact: true }).click();
  await nav.waitFor();
  assert.equal(
    (await p.getByRole("heading", { name: "概览", exact: true }).boundingBox())
      .y,
    before.y,
    "error does not move page",
  );
  assert.equal(await p.locator(".problemcenter").count(), 0);
  const sidebarPosition = await nav.boundingBox();
  assert.ok(
    sidebarPosition.y > (await p.viewportSize())?.height * 0.65 ||
      sidebarPosition.y > 550,
    "problem entry near sidebar bottom",
  );
  await p.getByRole("button", { name: "关闭错误", exact: true }).click();
  await nav.click();
  await p.getByRole("heading", { name: "问题与恢复", exact: true }).waitFor();
  const list = p.getByRole("region", { name: "问题列表" });
  await list.getByText("本地端口被占用", { exact: true }).waitFor();
  await list.getByText("错误详情", { exact: true }).click();
  assert.equal((await list.innerText()).includes("private:secret"), false);
  await list.getByRole("button", { name: "修改本地端口" }).click();
  await p.getByRole("heading", { name: "设置", exact: true }).waitFor();
  assert.equal(await p.locator(".problemspage").count(), 0);

  await nav.click();
  await list.getByText("本地端口被占用", { exact: true }).waitFor();
  checks.push(
    "no layout shift; sidebar bottom badge and dedicated page; dismiss toast retains problem; recovery navigates to settings",
  );
  await p.evaluate(() => {
    delete uiFixture.outcomes["proxy.connect"];
  });
  await p.getByRole("button", { name: "启动代理", exact: true }).click();
  await p.getByRole("heading", { name: "暂无待处理问题" }).waitFor();
  await p.getByRole("button", { name: /全部记录/ }).click();
  await p.getByText(/后续操作已成功/).waitFor();
  checks.push("pending/all filters retain resolved history");
  await p.evaluate(() =>
    uiFixture.push({
      ...uiFixture.snapshot,
      kernel: { status: "stopped", systemControl: false },
      operations: [
        {
          id: "background",
          traceId: "background",
          kind: "proxy.connect",
          state: "failed",
          revision: 1,
          startedAt: new Date().toISOString(),
          message: "后台自动连接失败",
        },
      ],
    }),
  );
  await p.getByRole("button", { name: /待处理/ }).click();
  await p.getByText("错误详情", { exact: true }).click();
  await p.getByText("后台自动连接失败", { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  checks.push("background auto-connect failure visible while kernel stopped");
  await p.screenshot({ path: "work/problems-sidebar/review.png" });
  console.log("PASS", checks);
} finally {
  await app.close();
}
