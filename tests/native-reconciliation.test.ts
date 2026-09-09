import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../packages/service/src/store";
import { ServiceCore } from "../packages/service/src/core";
import type { KernelState } from "../packages/contracts/src/index";

test("unknown native result fences update and new native writes until late result is reconciled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "flowgate-unknown-"));
  let state: KernelState = { status: "stopped", systemControl: false };
  let writes = 0;
  const core = new ServiceCore(
    new StateStore(dir, 1),
    {
      status: async () => state,
      apply: async () => {
        writes++;
        throw Object.assign(new Error("reply lost"), { outcome: "unknown" });
      },
      stop: async () => {
        writes++;
        return state;
      },
    },
    async () => {},
    "test",
  );
  try {
    await core.start();
    await assert.rejects(core.request("proxy.connect", {}, "pending-connect"));
    await assert.rejects(core.drain(), { outcome: "unknown" });
    assert.equal(core.lifecycle, "ready");
    await assert.rejects(new StateStore(dir, 2).start());
    await assert.rejects(core.request("proxy.disconnect", {}, "new-stop"));
    assert.equal(writes, 1);
    state = {
      status: "running",
      systemControl: false,
      operationId: "pending-connect",
      appliedRevision: 0,
    };
    const operation = (await core.request("operation.get", {
      id: "pending-connect",
    })) as any;
    assert.equal(operation.state, "succeeded");
    await core.drain();
    const handoff = JSON.parse(
      await readFile(join(dir, "handoff.json"), "utf8"),
    );
    assert.deepEqual(handoff.pendingOperationIds, []);
  } finally {
    core.store.operations = [];
    await core.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("restart reconciles an interrupted disconnect by matching terminal operation identity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "flowgate-stop-recovery-"));
  const old = new StateStore(dir, 1);
  await old.start();
  old.operations.push({
    id: "stop-1",
    kind: "proxy.disconnect",
    state: "pending",
    revision: 0,
    traceId: "trace",
    startedAt: new Date().toISOString(),
  });
  await old.persist();
  await old.close();
  const terminal: KernelState = {
    status: "stopped",
    systemControl: false,
    operationId: "stop-1",
  };
  const core = new ServiceCore(
    new StateStore(dir, 2),
    {
      status: async () => terminal,
      apply: async () => terminal,
      stop: async () => terminal,
    },
    async () => {},
    "test",
  );
  try {
    await core.start();
    assert.equal(core.store.operations[0].state, "succeeded");
  } finally {
    await core.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
