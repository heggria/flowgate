import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, writeFile, readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { resolve, join, dirname } from "node:path";
import { isolateProxyPort } from "./proxy-fixture.mjs";
import { verifyArtifacts } from "../scripts/artifacts.mjs";
import {
  explainCoordinatedRestart,
  readSoakStopRequest,
} from "./fixtures/soak-observation.ts";
import {
  captureSoakProcess,
  closeSoakApp,
  within,
} from "./fixtures/soak-cleanup.mjs";

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
await mkdir(dirname(output), { recursive: true });
const data = await mkdtemp(resolve("work/soak-private-"));
const exec = promisify(execFile);
const observe = async () => ({
  proxy: (await exec("/usr/sbin/scutil", ["--proxy"])).stdout,
  dns: (await exec("/usr/sbin/scutil", ["--dns"])).stdout,
  route: (await exec("/sbin/route", ["-n", "get", "default"])).stdout,
});
const before = await observe();
await writeFile(
  join(data, "soak-network-observations.json"),
  JSON.stringify({ before }),
  { mode: 0o600 },
);
let served = 0;
const origin = createServer((_req, res) => {
  served++;
  res.end("flowgate-soak-origin");
});
await new Promise((r) => origin.listen(0, "127.0.0.1", r));
const result = {
  runId: randomUUID(),
  at: new Date().toISOString(),
  commit: build.commit,
  dirty: build.dirty,
  buildNumber: (
    await exec("/usr/libexec/PlistBuddy", [
      "-c",
      "Print :CFBundleVersion",
      join(bundle, "Contents/Info.plist"),
    ])
  ).stdout.trim(),
  harnessSHA256: createHash("sha256")
    .update(await readFile(new URL(import.meta.url)))
    .update(
      await readFile(
        new URL("./fixtures/soak-observation.ts", import.meta.url),
      ),
    )
    .update(
      await readFile(new URL("./fixtures/soak-cleanup.mjs", import.meta.url)),
    )
    .digest("hex"),
  requestedSeconds: seconds,
  scope:
    "isolated manual-mode loopback forwarding, stop/start, renderer reload and process liveness; no real sleep or privileged acceptance",
  samples: [],
  cycles: 0,
  reloads: 0,
  coordinatedRestarts: [],
  lifecycle: [],
};
let app,
  ownedProcess,
  page,
  currentPID,
  previousState,
  lastObservedState,
  started,
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
  ownedProcess = await captureSoakProcess(
    app,
    data,
    join(bundle, "Contents/MacOS/FlowGate"),
  );
  const record = (event) => {
    if (result.lifecycle.length < 20)
      result.lifecycle.push({ at: new Date().toISOString(), event });
  };
  app.on("close", () => record("automation-app-close"));
  ownedProcess.child.once("exit", () => record("application-process-exit"));
  page = await app.firstWindow();
  page.on("close", () => record("automation-page-close"));
  page.on("crash", () => record("renderer-crash"));
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
  previousState = initial;
  lastObservedState = initial;
  const probe = async () => {
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
    return responses.length;
  };
  started = Date.now();
  while (Date.now() - started < seconds * 1000 && !interrupted) {
    const stopReason = await readSoakStopRequest(
      output + ".stop.json",
      result.runId,
    );
    if (stopReason !== undefined) {
      interrupted = true;
      result.stopReason = stopReason;
      break;
    }
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
      await command("proxy.connect");
      previousState = await snapshot();
      currentPID = previousState.kernel.pid;
      result.cycles++;
    }
    if (round > 0 && round % 12 === 0) {
      await page.reload();
      await page
        .getByRole("heading", { name: "概览", exact: true })
        .waitFor({ timeout: 30000 });
      result.reloads++;
    }
    let requests = await probe();
    const state = await snapshot();
    lastObservedState = state;
    assert.equal(
      state.epoch,
      initial.epoch,
      "Service must not restart unexpectedly",
    );
    assert.equal(state.kernel.status, "running");
    if (state.kernel.pid !== currentPID) {
      const replacement = explainCoordinatedRestart(
        previousState,
        state,
        alive(currentPID),
      );
      // An explained restart must also forward through the replacement kernel.
      requests += await probe();
      result.coordinatedRestarts.push(replacement);
      currentPID = state.kernel.pid;
    }
    assert.equal(
      state.operations.some(
        (o) => o.state === "unknown" || o.state === "pending",
      ),
      false,
    );
    previousState = state;
    const memoryKiB = await app.evaluate(({ app }) =>
      app
        .getAppMetrics()
        .reduce((sum, metric) => sum + metric.memory.workingSetSize, 0),
    );
    const elapsed = Math.round((Date.now() - started) / 1000);
    assert.ok(
      elapsed - (result.samples.at(-1)?.seconds ?? 0) <= 60,
      "Long observation gap: continuous runtime was not verified",
    );
    result.samples.push({
      seconds: elapsed,
      requests,
      memoryKiB,
    });
    await writeFile(
      output + ".progress.json",
      JSON.stringify(
        {
          runId: result.runId,
          commit: build.commit,
          elapsedSeconds: result.samples.at(-1).seconds,
          samples: result.samples.length,
          cycles: result.cycles,
          reloads: result.reloads,
          coordinatedRestarts: result.coordinatedRestarts.length,
          memoryKiB,
        },
        null,
        2,
      ),
    );
    if (round === 0 && process.env.FLOWGATE_SOAK_TEST_DISCONNECT === "1") {
      // Regression fixture only: drop Chromium's automation transport while the
      // real isolated application and kernel remain alive. This is not sleep.
      result.injectedTransportDisconnect = true;
      app._connection.toImpl(app)._browserContext._browser._connection.close();
    }
    await new Promise((r) =>
      setTimeout(
        r,
        Math.min(10000, Math.max(0, seconds * 1000 - (Date.now() - started))),
      ),
    );
  }
  result.elapsedSeconds = Math.round((Date.now() - started) / 1000);
  assert.ok(
    result.elapsedSeconds - (result.samples.at(-1)?.seconds ?? 0) <= 60,
    "Long final observation gap: continuous runtime was not verified",
  );
  assert.equal(interrupted, false, "Soak interrupted before completion");
  await command("proxy.disconnect");
  // Earlier kernels were checked immediately after each stop. Rechecking old
  // numeric PIDs after a long run could misidentify an unrelated reused PID.
  assert.equal(alive(currentPID), false, "Stopped test kernel is still alive");
  assert.equal((await snapshot()).kernel.status, "stopped");
  result.requests = served;
  assert.equal(
    served,
    result.samples.reduce((sum, sample) => sum + sample.requests, 0),
  );
  result.passed = true;
} catch (error) {
  result.passed = false;
  result.error = String(error.message).slice(0, 1600);
  if (lastObservedState)
    result.lastObservation = {
      epoch: lastObservedState.epoch,
      revision: lastObservedState.configuration.revision,
      kernel: {
        pid: lastObservedState.kernel.pid,
        status: lastObservedState.kernel.status,
        operationId: lastObservedState.kernel.operationId,
        appliedRevision: lastObservedState.kernel.appliedRevision,
      },
      operations: lastObservedState.operations
        .slice(0, 10)
        .map(({ id, kind, state, revision, startedAt, completedAt }) => ({
          id,
          kind,
          state,
          revision,
          startedAt,
          completedAt,
        })),
    };
} finally {
  result.interrupted = interrupted;
  if (started)
    result.elapsedSeconds = Math.round((Date.now() - started) / 1000);
  result.finishedAt = new Date().toISOString();
  result.requests = served;
  try {
    if (page)
      await within(
        page.evaluate(() =>
          window.flowgate.request("proxy.disconnect", {}, crypto.randomUUID()),
        ),
        5000,
      );
  } catch {}
  result.cleanup = await closeSoakApp(app, ownedProcess).catch((error) => ({
    processExited: false,
    graceful: false,
    error: String(error.message).slice(0, 300),
  }));
  if (!result.cleanup.processExited || !result.cleanup.graceful)
    result.passed = false;
  origin.closeAllConnections();
  await new Promise((r) => origin.close(r));
  try {
    const after = await observe();
    result.networkChangedFields = Object.keys(before).filter(
      (key) => before[key] !== after[key],
    );
    result.networkUnchanged = result.networkChangedFields.length === 0;
    await writeFile(
      join(data, "soak-network-observations.json"),
      JSON.stringify({ before, after }),
      { mode: 0o600 },
    );
  } catch (error) {
    result.networkUnchanged = false;
    result.networkObservationError = String(error.message).slice(0, 300);
  }
  if (!result.networkUnchanged) result.passed = false;
  result.cleanupFinishedAt = new Date().toISOString();
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
