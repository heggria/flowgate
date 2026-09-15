import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServiceCore } from "../packages/service/src/core";
import { StateStore } from "../packages/service/src/store";
import type { KernelState } from "../packages/contracts/src/index";

test("failed and uncertain operation replays never resolve as successful writes or change methods", async () => {
  const dir = await mkdtemp(join(tmpdir(), "flowgate-replay-"));
  let writes = 0;
  const core = new ServiceCore(
    new StateStore(dir, 1),
    {
      status: async () => ({ status: "stopped", systemControl: false }),
      apply: async () => {
        writes++;
        throw Error("fixture refused");
      },
      stop: async () => ({ status: "stopped", systemControl: false }),
    },
    async () => {},
    "test",
  );
  try {
    await core.start();
    await assert.rejects(
      core.request("proxy.connect", {}, "same"),
      /fixture refused/,
    );
    await assert.rejects(
      core.request("proxy.connect", {}, "same"),
      /fixture refused/,
    );
    await assert.rejects(
      core.request("proxy.disconnect", {}, "same"),
      /标识.*其他操作/,
    );
    assert.equal(writes, 1);
    core.store.operations[0].state = "unknown";
    await assert.rejects(core.request("proxy.connect", {}, "same"), {
      outcome: "unknown",
    });
  } finally {
    core.store.operations = [];
    await core.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("explicit confirmed recovery disconnect clears the native uncertainty fence without claiming connect succeeded", async () => {
  const dir = await mkdtemp(join(tmpdir(), "flowgate-explicit-recovery-"));
  let state: KernelState = { status: "stopped", systemControl: false };
  let writes = 0;
  const core = new ServiceCore(
    new StateStore(dir, 1),
    {
      status: async () => state,
      apply: async (_config, revision, operationId) => {
        writes++;
        if (writes === 1)
          throw Object.assign(Error("reply lost"), { outcome: "unknown" });
        return (state = {
          status: "running",
          systemControl: false,
          operationId,
          appliedRevision: revision,
        });
      },
      stop: async () => state,
    },
    async () => {},
    "test",
  );
  try {
    await core.start();
    await assert.rejects(core.request("proxy.connect", {}, "uncertain"));
    await assert.rejects(core.request("proxy.connect", {}, "blocked"));
    state = {
      status: "stopped",
      systemControl: false,
      operationId: "recovery-disconnect",
    };
    const resolved: any = await core.request("operation.get", {
      id: "uncertain",
    });
    assert.equal(resolved.state, "failed");
    await core.request("proxy.connect", {}, "after-explicit-recovery");
    assert.equal(writes, 2);
  } finally {
    core.store.operations = [];
    await core.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a manual fallback cannot confirm recovery of an uncertain privileged operation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "flowgate-recovery-authority-"));
  let state: KernelState = { status: "stopped", systemControl: true };
  const core = new ServiceCore(
    new StateStore(dir, 1),
    {
      status: async () => state,
      apply: async () => {
        throw Object.assign(Error("reply lost"), { outcome: "unknown" });
      },
      stop: async () => state,
    },
    async (method) =>
      method === "network.inspect"
        ? {
            interfaces: [],
            routes: [],
            warnings: [],
            plugins: [],
            proxyEnabled: false,
          }
        : undefined,
    "test",
  );
  try {
    await core.start();
    core.store.configuration.settings.mode = "system";
    await assert.rejects(core.request("proxy.connect", {}, "privileged"));
    core.store.configuration.settings.mode = "manual";
    core.store.configuration.revision++;
    state = {
      status: "stopped",
      systemControl: false,
      operationId: "recovery-disconnect",
    };
    let result: any = await core.request("operation.get", { id: "privileged" });
    assert.equal(result.state, "unknown");
    state = { ...state, systemControl: true };
    result = await core.request("operation.get", { id: "privileged" });
    assert.equal(result.state, "failed");
  } finally {
    core.store.operations = [];
    await core.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
