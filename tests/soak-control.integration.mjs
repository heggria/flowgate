import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, rename } from "node:fs/promises";
import { resolve, join } from "node:path";

assert.ok(process.env.FLOWGATE_PACKAGE_DIR, "Select the packaged candidate");
await mkdir("work", { recursive: true });
const directory = await mkdtemp(resolve("work/soak-control-"));
const result = { checks: [], passed: false };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function within(promise, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Soak control deadline exceeded")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
try {
  for (const cancel of [false, true]) {
    const output = join(
      directory,
      cancel ? "cancel-result.json" : "complete-result.json",
    );
    // A previous run's request must not stop a new invocation.
    await writeFile(
      output + ".stop.json",
      JSON.stringify({ runId: "previous-run", reason: "stale" }),
      { mode: 0o600 },
    );
    const child = spawn(process.execPath, ["tests/soak.integration.mjs"], {
      env: {
        ...process.env,
        FLOWGATE_SOAK_SECONDS: cancel ? "60" : "20",
        FLOWGATE_SOAK_RESULT: output,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let diagnostic = "";
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (data) => {
        diagnostic = (diagnostic + data).slice(-8000);
      });
    const exited = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    try {
      if (cancel) {
        const progress = await within(
          (async () => {
            while (child.exitCode === null && child.signalCode === null) {
              try {
                return JSON.parse(
                  await readFile(output + ".progress.json", "utf8"),
                );
              } catch (error) {
                if (error.code !== "ENOENT" && !(error instanceof SyntaxError))
                  throw error;
              }
              await pause(100);
            }
            throw new Error(
              "Soak exited before publishing progress: " + diagnostic,
            );
          })(),
          30000,
        );
        await writeFile(
          output + ".stop.tmp",
          JSON.stringify({
            runId: progress.runId,
            reason: "control acceptance",
          }),
          { mode: 0o600 },
        );
        await rename(output + ".stop.tmp", output + ".stop.json");
      }
      const exit = await within(exited, 90000);
      assert.equal(exit.signal, null);
      assert.equal(exit.code, cancel ? 1 : 0, diagnostic);
      const observed = JSON.parse(await readFile(output, "utf8"));
      assert.equal(observed.passed, !cancel);
      assert.equal(observed.interrupted, cancel);
      assert.equal(observed.networkUnchanged, true);
      assert.ok(observed.requests > 0);
      if (cancel) {
        assert.equal(observed.stopReason, "control acceptance");
        assert.match(observed.error, /Soak interrupted before completion/);
        assert.ok(observed.elapsedSeconds < observed.requestedSeconds);
        const pid = observed.lastObservation.kernel.pid;
        assert.ok(Number.isInteger(pid) && pid > 0);
        assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      } else {
        assert.ok(observed.elapsedSeconds >= observed.requestedSeconds);
      }
      result.checks.push({
        case: cancel
          ? "cooperative stop"
          : "completion with stale stop request",
        ...observed,
      });
    } catch (error) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await within(exited, 15000).catch(() => child.kill("SIGKILL"));
      }
      throw error;
    }
  }
  result.passed = true;
} catch (error) {
  result.error = String(error.message).slice(0, 1600);
} finally {
  await writeFile(
    "work/soak-control-result.json",
    JSON.stringify(result, null, 2),
  );
  console.log(
    JSON.stringify({
      passed: result.passed,
      checks: result.checks.length,
      error: result.error,
    }),
  );
  if (!result.passed) process.exitCode = 1;
}
