import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";

await mkdir("work", { recursive: true });
const activatedPids = [];
let observer;
let app;
if (process.platform === "darwin") {
  execFileSync("/usr/bin/swiftc", [
    "tests/ForegroundObserver.swift",
    "-o",
    "work/foreground-observer",
  ]);
  observer = spawn(resolve("work/foreground-observer"), [], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Foreground observer did not start")),
      10000,
    );
    observer.once("error", reject);
    createInterface({ input: observer.stdout }).on("line", (line) => {
      activatedPids.push(Number(line));
      clearTimeout(timer);
      resolve();
    });
  });
}
try {
  app = await electron.launch({
    args: ["."],
    env: {
      ...process.env,
      FLOWGATE_TEST_DATA: await mkdtemp(resolve("work/background-data-")),
      FLOWGATE_TEST_VISIBLE: "0",
    },
  });
  const pid = app.process().pid;
  const check = async () => {
    const states = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((window) => ({
        visible: window.isVisible(),
        focused: window.isFocused(),
        focusable: window.isFocusable(),
      })),
    );
    assert.ok(states.length > 0);
    for (const state of states)
      assert.deepEqual(state, {
        visible: false,
        focused: false,
        focusable: false,
      });
    assert.equal(
      activatedPids.includes(pid),
      false,
      "Test Electron must never activate in macOS",
    );
  };
  let page = await app.firstWindow();
  await page.getByRole("heading", { name: "概览", exact: true }).waitFor();
  await check();
  await page.getByRole("button", { name: "节点与订阅", exact: false }).click();
  await page.screenshot({ path: "work/background-preview.png" });
  await check();
  await app.evaluate(({ app }) => app.emit("activate"));
  await page.reload();
  await page.getByRole("heading", { name: "概览", exact: true }).waitFor();
  await check();
  const replacement = app.waitForEvent("window");
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer(),
  );
  page = await replacement;
  await page
    .getByRole("heading", { name: "概览", exact: true })
    .waitFor({ timeout: 20000 });
  await check();
  await app.close();
  app = undefined;
  // Allow queued OS activation notifications to arrive before checking shutdown.
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(
    activatedPids.includes(pid),
    false,
    "No activation during the entire test lifetime",
  );
  await writeFile(
    "work/background-result.json",
    JSON.stringify(
      {
        passed: true,
        at: new Date().toISOString(),
        nativeActivationObserved: process.platform === "darwin",
        checks: [
          "hidden and non-focusable",
          "background click and screenshot",
          "activate event and reload",
          "renderer crash recovery",
          "no native foreground activation",
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS: background Electron stays hidden and never takes foreground focus",
  );
} finally {
  await app?.close();
  observer?.kill();
}
