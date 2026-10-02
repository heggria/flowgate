import assert from "node:assert/strict";
import { test } from "node:test";
import { within, closeSoakApp } from "./fixtures/soak-cleanup.mjs";

test("never-settling read rejects within its deadline and retains diagnostic", async () => {
  const started = performance.now();
  await assert.rejects(
    within(new Promise(() => {}), 40, "snapshot deadline exceeded"),
    /snapshot deadline exceeded/,
  );
  assert.ok(performance.now() - started < 1000);
});
test("bounded read returns the awaited value", async () => {
  assert.equal(await within(Promise.resolve(false), 100), false);
});
test("automation close alone cannot prove application process exit", async () => {
  const cleanup = await closeSoakApp({ close: async () => {} });
  assert.equal(cleanup.processExited, false);
  assert.equal(cleanup.graceful, false);
  assert.match(cleanup.errors.join(" "), /identity was not captured/);
});

test("identity read timeout retains owned child for actual cleanup", async () => {
  const { spawn } = await import("node:child_process");
  const { once } = await import("node:events");
  const { captureSoakChild, captureSoakProcess } =
    await import("./fixtures/soak-cleanup.mjs");
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"]);
  await once(child, "spawn");
  const app = {
    process: () => child,
    evaluate: () => new Promise(() => {}),
    close: async () => {
      child.kill("SIGTERM");
    },
  };
  const owned = captureSoakChild(app);
  try {
    await assert.rejects(
      captureSoakProcess(app, "isolated", process.execPath, {
        owned,
        timeout: 30,
      }),
      /identity capture deadline/,
    );
    const cleanup = await closeSoakApp(app, owned);
    assert.equal(cleanup.processExited, true);
    assert.equal(cleanup.signalCode, "SIGTERM");
    assert.equal(
      cleanup.graceful,
      false,
      "signal termination is never graceful acceptance",
    );
  } finally {
    if (!owned.isExited()) child.kill("SIGKILL");
  }
});

test("nonzero child exit cannot become graceful when automation close fails", async () => {
  const child = { pid: 123, exitCode: 7, signalCode: null };
  const cleanup = await closeSoakApp(
    {
      close: async () => {
        throw new Error("automation closed");
      },
    },
    { child, waitForExit: async () => true },
  );
  assert.equal(cleanup.processExited, true);
  assert.equal(cleanup.exitCode, 7);
  assert.equal(cleanup.graceful, false);
});
