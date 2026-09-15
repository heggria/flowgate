import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { isolateProxyPort } from "./proxy-fixture.mjs";
import { verifyArtifacts } from "../scripts/artifacts.mjs";

const seconds = Number(process.env.FLOWGATE_SOAK_SECONDS ?? 1800);
assert.ok(
  Number.isInteger(seconds) && seconds >= 20 && seconds <= 86400,
  "Soak duration must be 20–86400 seconds",
);
assert.ok(
  process.env.FLOWGATE_PACKAGE_DIR,
  "Select the exact candidate with FLOWGATE_PACKAGE_DIR",
);
const bundle = resolve(process.env.FLOWGATE_PACKAGE_DIR);
const build = await verifyArtifacts(
  join(bundle, "Contents/Resources/app/dist"),
);
const output = resolve(
  process.env.FLOWGATE_SOAK_RESULT ?? "work/soak-result.json",
);
await mkdir(resolve("work"), { recursive: true });
const data = await mkdtemp(resolve("work/soak-private-"));
const exec = promisify(execFile);
const observe = async () => ({
  proxy: (await exec("/usr/sbin/scutil", ["--proxy"])).stdout,
  dns: (await exec("/usr/sbin/scutil", ["--dns"])).stdout,
  route: (await exec("/sbin/route", ["-n", "get", "default"])).stdout,
});
const before = await observe();
let served = 0;
const origin = createServer((_req, res) => {
  served++;
  res.end("flowgate-soak-origin");
});
await new Promise((r) => origin.listen(0, "127.0.0.1", r));
const result = {
  at: new Date().toISOString(),
  commit: build.commit,
  dirty: build.dirty,
  requestedSeconds: seconds,
  scope:
    "isolated manual-mode loopback forwarding, stop/start, renderer reload and process liveness; no real sleep or privileged acceptance",
  samples: [],
  cycles: 0,
  reloads: 0,
};
const retired = new Set();
let app,
  page,
  currentPID,
  interrupted = false;
const interrupt = () => {
  interrupted = true;
};
process.on("SIGTERM", interrupt);
process.on("SIGINT", interrupt);
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (e.code === "ESRCH") return false;
    throw e;
  }
};
try {
  app = await electron.launch({
    executablePath: join(bundle, "Contents/MacOS/FlowGate"),
    env: {
      ...process.env,
      FLOWGATE_TEST_DATA: data,
      FLOWGATE_TEST_VISIBLE: "0",
    },
  });
  page = await app.firstWindow();
  await page
    .getByRole("heading", { name: "概览", exact: true })
    .waitFor({ timeout: 30000 });
  const port = await isolateProxyPort(page);
  const command = (method) =>
    page.evaluate(
      (method) => window.flowgate.request(method, {}, crypto.randomUUID()),
      method,
    );
  const snapshot = () =>
    page.evaluate(() => window.flowgate.request("snapshot"));
  await command("proxy.connect");
  const initial = await snapshot();
  assert.equal(initial.configuration.settings.mode, "manual");
  assert.equal(initial.kernel.systemControl, false);
  currentPID = initial.kernel.pid;
  const started = Date.now();
  while (Date.now() - started < seconds * 1000 && !interrupted) {
    const round = result.samples.length;
    assert.equal(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some(
          (w) => w.isVisible() || w.isFocused() || w.isFocusable(),
        ),
      ),
      false,
    );
    if (round > 0 && round % 6 === 0) {
      const oldPID = currentPID;
      await command("proxy.disconnect");
      assert.equal((await snapshot()).kernel.status, "stopped");
      assert.equal(alive(oldPID), false, "Stopped kernel must not survive");
      retired.add(oldPID);
      await command("proxy.connect");
      currentPID = (await snapshot()).kernel.pid;
      result.cycles++;
    }
    if (round > 0 && round % 12 === 0) {
      await page.reload();
      await page
        .getByRole("heading", { name: "概览", exact: true })
        .waitFor({ timeout: 30000 });
      result.reloads++;
    }
    const responses = await Promise.all(
      ["http", "socks5h"].map((type) =>
        exec(
          "/usr/bin/curl",
          [
            "--silent",
            "--show-error",
            "--fail",
            "--max-time",
            "8",
            "--noproxy",
            "",
            "--proxy",
            `${type}://127.0.0.1:${port}`,
            `http://127.0.0.1:${origin.address().port}/`,
          ],
          { timeout: 10000 },
        ),
      ),
    );
    for (const response of responses)
      assert.equal(response.stdout, "flowgate-soak-origin");
    const state = await snapshot();
    assert.equal(
      state.epoch,
      initial.epoch,
      "Service must not restart unexpectedly",
    );
    assert.equal(state.kernel.status, "running");
    assert.equal(
      state.kernel.pid,
      currentPID,
      "Kernel changed without an explicit restart",
    );
    assert.equal(
      state.operations.some(
        (o) => o.state === "unknown" || o.state === "pending",
      ),
      false,
    );
    const memoryKiB = await app.evaluate(({ app }) =>
      app
        .getAppMetrics()
        .reduce((sum, metric) => sum + metric.memory.workingSetSize, 0),
    );
    result.samples.push({
      seconds: Math.round((Date.now() - started) / 1000),
      requests: responses.length,
      memoryKiB,
    });
    await writeFile(
      output + ".progress.json",
      JSON.stringify(
        {
          commit: build.commit,
          elapsedSeconds: result.samples.at(-1).seconds,
          samples: result.samples.length,
          cycles: result.cycles,
          reloads: result.reloads,
          memoryKiB,
        },
        null,
        2,
      ),
    );
    await new Promise((r) =>
      setTimeout(
        r,
        Math.min(10000, Math.max(0, seconds * 1000 - (Date.now() - started))),
      ),
    );
  }
  result.elapsedSeconds = Math.round((Date.now() - started) / 1000);
  assert.equal(interrupted, false, "Soak interrupted before completion");
  await command("proxy.disconnect");
  retired.add(currentPID);
  for (const pid of retired)
    assert.equal(alive(pid), false, "Retired test kernel is still alive");
  assert.equal((await snapshot()).kernel.status, "stopped");
  result.requests = served;
  assert.equal(served, result.samples.length * 2);
  result.passed = true;
} catch (error) {
  result.passed = false;
  result.error = String(error.message).slice(0, 1600);
} finally {
  try {
    if (page)
      await page.evaluate(() =>
        window.flowgate.request("proxy.disconnect", {}, crypto.randomUUID()),
      );
  } catch {}
  await app?.close();
  origin.closeAllConnections();
  await new Promise((r) => origin.close(r));
  result.networkUnchanged =
    JSON.stringify(before) === JSON.stringify(await observe());
  if (!result.networkUnchanged) result.passed = false;
  await writeFile(output, JSON.stringify(result, null, 2));
  process.removeListener("SIGTERM", interrupt);
  process.removeListener("SIGINT", interrupt);
  console.log(
    JSON.stringify({
      passed: result.passed,
      elapsedSeconds: result.elapsedSeconds,
      samples: result.samples.length,
      cycles: result.cycles,
      reloads: result.reloads,
      networkUnchanged: result.networkUnchanged,
      error: result.error,
    }),
  );
  if (!result.passed) process.exitCode = 1;
}
