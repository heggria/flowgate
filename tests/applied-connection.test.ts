import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServiceCore } from "../packages/service/src/core";
import { StateStore } from "../packages/service/src/store";
import {
  initialConfiguration,
  explainRoute,
} from "../packages/domain/src/configuration";
import type { KernelState, NativePort } from "../packages/contracts/src/index";

test("applied identity survives saved outlet changes and service restart, and is fenced by kernel operation identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "flowgate-applied-"));
  let state: KernelState = { status: "stopped", systemControl: false };
  let fail = false;
  const native: NativePort = {
    status: async () => state,
    apply: async (_config, revision, operationId) => {
      if (fail) throw new Error("apply rejected");
      return (state = {
        status: "running",
        systemControl: false,
        appliedRevision: revision,
        operationId,
      });
    },
    stop: async (operationId) =>
      (state = { status: "stopped", systemControl: false, operationId }),
  };
  let core = new ServiceCore(
    new StateStore(directory, 1),
    native,
    async () => {},
    "test",
  );
  try {
    await core.start();
    core.store.configuration.nodes = [
      {
        id: "node-a",
        name: "线路 A",
        type: "socks",
        server: "127.0.0.1",
        port: 1080,
        options: { password: "must-not-be-exposed" },
      },
      {
        id: "node-b",
        name: "线路 B",
        type: "socks",
        server: "127.0.0.1",
        port: 1081,
        options: {},
      },
    ];
    core.store.configuration.settings.selectedNode = "node-a";
    await core.request("proxy.connect", {}, "connect-a");
    const applied = (await core.snapshot()).appliedConnection;
    assert.equal(applied?.selectedNode, "node-a");
    assert.equal(applied?.outletName, "线路 A");
    assert.ok(!JSON.stringify(applied).includes("must-not-be-exposed"));
    const config = structuredClone(core.store.configuration);
    config.settings.selectedNode = "node-b";
    await core.request("configuration.save", config, "save-b");
    assert.equal(
      (await core.snapshot()).appliedConnection?.selectedNode,
      "node-a",
    );
    await core.stop();
    core = new ServiceCore(
      new StateStore(directory, 2),
      native,
      async () => {},
      "test",
    );
    await core.start();
    assert.equal(core.store.configuration.settings.selectedNode, "node-b");
    assert.deepEqual((await core.snapshot()).appliedConnection, applied);
    fail = true;
    await assert.rejects(core.request("proxy.connect", {}, "connect-b-fail"));
    assert.equal(
      (await core.snapshot()).appliedConnection?.selectedNode,
      "node-a",
    );
    fail = false;
    await core.request("proxy.connect", {}, "connect-b");
    assert.equal(
      (await core.snapshot()).appliedConnection?.selectedNode,
      "node-b",
    );
    state = { ...state, operationId: "unrelated-operation" };
    assert.equal((await core.snapshot()).appliedConnection, undefined);
    await core.request("proxy.disconnect", {}, "disconnect");
    assert.equal((await core.snapshot()).appliedConnection, undefined);
  } finally {
    await core.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("route preview normalizes domain names and rejects URLs rather than misleadingly matching the default", () => {
  const c = initialConfiguration();
  c.rules = [
    {
      id: "one",
      kind: "domain_suffix",
      value: "example.com",
      outbound: "select",
    },
  ];
  assert.equal(explainRoute(c, "  WWW.EXAMPLE.COM.  ").rule?.id, "one");
  assert.equal(explainRoute(c, "evil-example.com").rule, null);
  for (const invalid of [
    "",
    "https://example.com",
    "example.com/path",
    "a b.example",
    "example.com:443",
  ])
    assert.throws(() => explainRoute(c, invalid));
});

test("a delayed measurement cannot repopulate a disconnected outlet or clear a newer measurement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "flowgate-measure-fence-"));
  let state: KernelState = { status: "stopped", systemControl: false };
  const core = new ServiceCore(
    new StateStore(directory, 1),
    {
      status: async () => state,
      apply: async (_config, revision, operationId) =>
        (state = {
          status: "running",
          systemControl: false,
          appliedRevision: revision,
          operationId,
        }),
      stop: async (operationId) =>
        (state = { status: "stopped", systemControl: false, operationId }),
    },
    async () => {},
    "test",
  );
  const pending: Array<(value: null) => void> = [];
  core.native.control = () => new Promise((resolve) => pending.push(resolve));
  try {
    await core.start();
    core.store.configuration.nodes = [
      {
        id: "node-a",
        name: "A",
        type: "socks",
        server: "127.0.0.1",
        port: 1080,
        options: {},
      },
    ];
    await core.request("proxy.connect", {}, "first-connect");
    const old = assert.rejects(core.request("node.measure", { id: "node-a" }));
    while (pending.length < 1)
      await new Promise((resolve) => setImmediate(resolve));
    await core.request("proxy.disconnect", {}, "disconnect");
    assert.deepEqual((await core.snapshot()).nodeMeasurements, []);
    await core.request("proxy.connect", {}, "second-connect");
    const next = assert.rejects(core.request("node.measure", { id: "node-a" }));
    while (pending.length < 2)
      await new Promise((resolve) => setImmediate(resolve));
    pending[0](null);
    await old;
    assert.equal(
      (await core.snapshot()).nodeMeasurements?.[0]?.state,
      "running",
    );
    await assert.rejects(
      core.request("node.measure", { id: "node-a" }),
      /已有检测正在进行/,
    );
    pending[1](null);
    await next;
    assert.equal(
      (await core.snapshot()).nodeMeasurements?.[0]?.state,
      "failed",
    );
    await core.request("proxy.connect", {}, "third-connect");
    assert.deepEqual((await core.snapshot()).nodeMeasurements, []);
  } finally {
    for (const resolve of pending) resolve(null);
    await core.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
