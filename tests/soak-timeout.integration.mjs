import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  appendFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { stopOwnedChild, cleanupStages } from "./fixtures/owned-cleanup.mjs";
import { within } from "./fixtures/soak-cleanup.mjs";

assert.ok(
  process.env.FLOWGATE_PACKAGE_DIR,
  "Select the exact candidate package",
);
await mkdir("work", { recursive: true });
const directory = await mkdtemp(resolve("work/soak-timeout-"));
const result = {
  passed: false,
  checks: [],
  scope:
    "harness never-settling IPC fixtures with a real hidden isolated app and real loopback forwarding; no product IPC defect or sleep reproduced",
};
try {
  for (const mode of ["command", "snapshot"]) {
    const output = join(directory, mode + ".json");
    const child = spawn(process.execPath, ["tests/soak.integration.mjs"], {
      env: {
        ...process.env,
        FLOWGATE_SOAK_SECONDS: "20",
        FLOWGATE_SOAK_RESULT: output,
        FLOWGATE_SOAK_IPC_TIMEOUT_MS: "10000",
        FLOWGATE_SOAK_TEST_HANG: mode,
        FLOWGATE_SOAK_TEST_DISCONNECT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const log = join(directory, mode + ".log");
    let logs = Promise.resolve(),
      logFailure,
      scenarioFailure;
    const closed = new Promise((resolve) => child.once("close", resolve));
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (data) => {
        logs = logs
          .then(() => appendFile(log, data))
          .catch((error) => {
            logFailure ??= error;
          });
      });
    const exited = once(child, "exit");
    try {
      const [code, signal] = await within(
        exited,
        60000,
        "hung-read regression child deadline exceeded",
      );
      await logs;
      assert.equal(signal, null);
      assert.equal(
        code,
        1,
        await readFile(log, "utf8").catch(() => "no diagnostic"),
      );
      const observed = JSON.parse(await readFile(output, "utf8"));
      assert.equal(observed.passed, false);
      assert.equal(observed.injectedIPCHang, mode);
      assert.match(
        observed.error,
        new RegExp(`Soak ${mode}.*deadline exceeded`),
      );
      assert.equal(observed.networkUnchanged, true);
      assert.ok(
        observed.requests > 0,
        "actual HTTP/SOCKS forwarding must precede injected hang",
      );
      assert.equal(observed.cleanup.processExited, true);
      assert.equal(observed.cleanup.graceful, true);
      for (const pid of [
        observed.cleanup.pid,
        observed.lastObservation.kernel.pid,
      ]) {
        assert.ok(Number.isInteger(pid) && pid > 0);
        assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      }
      result.checks.push({
        mode,
        passed: true,
        output,
        log,
        cleanup: observed.cleanup,
      });
      console.log(
        "PASS bounded " + mode + ", actual app/kernel exit, unchanged network",
      );
    } catch (error) {
      scenarioFailure = error;
      throw error;
    } finally {
      try {
        await cleanupStages([
          async () => {
            if (child.exitCode === null && child.signalCode === null) {
              const cleanup = await stopOwnedChild(child, { timeout: 30000 });
              assert.equal(
                cleanup.forced,
                false,
                "Forced regression harness cleanup fails acceptance",
              );
            }
          },
          async () => {
            // Child exit precedes stdio close: wait for all data events first.
            await within(
              closed,
              5000,
              "Regression child stdio drain deadline exceeded",
            );
            await logs;
            if (logFailure) throw logFailure;
          },
        ]);
      } catch (error) {
        result.cleanupFailures ??= [];
        result.cleanupFailures.push(
          ...error.errors.map((item) => String(item.stack ?? item)),
        );
        if (!scenarioFailure) throw error;
        // Retain the original assertion/timeout failure alongside cleanup errors.
      }
    }
  }
  result.passed = true;
} catch (error) {
  result.error = String(error.stack ?? error);
  console.error(result.error);
  process.exitCode = 1;
} finally {
  await writeFile(
    "work/soak-timeout-result.json",
    JSON.stringify(result, null, 2),
  );
}
