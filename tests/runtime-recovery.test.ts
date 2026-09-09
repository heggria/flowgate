import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReleaseManager } from "../packages/release/src/manager";
import { cleanupStages } from "../packages/shell/src/cleanup";

test("runtime crash budget persists across launches and quarantine survives restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "flowgate-runtime-failure-"));
  try {
    let manager = new ReleaseManager(dir);
    await manager.init();
    manager.state.current = "broken";
    manager.state.previous = "unverified";
    assert.equal(await manager.recordRuntimeFault("broken", 100), false);
    manager = new ReleaseManager(dir);
    await manager.init();
    assert.equal(await manager.recordRuntimeFault("broken", 200), false);
    assert.equal(await manager.recordRuntimeFault("broken", 300), true);
    assert.equal(await manager.quarantineRuntime("broken"), null);
    manager = new ReleaseManager(dir);
    await manager.init();
    assert.equal(manager.state.current, null);
    assert.deepEqual(manager.state.quarantine, ["broken"]);
    await assert.rejects(manager.resolve("broken"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("host cleanup failure cannot skip native restoration or diagnostic flush", async () => {
  const called: string[] = [];
  await assert.rejects(
    cleanupStages([
      {
        name: "hosts",
        run: async () => {
          called.push("hosts");
          throw new Error("drain failed");
        },
      },
      {
        name: "native",
        run: async () => {
          called.push("native");
        },
      },
      {
        name: "diagnostics",
        run: async () => {
          called.push("diagnostics");
        },
      },
    ]),
    AggregateError,
  );
  assert.deepEqual(called, ["hosts", "native", "diagnostics"]);
});
