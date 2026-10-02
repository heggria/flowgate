import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServiceCore } from "../packages/service/src/core";
import { StateStore } from "../packages/service/src/store";
import { validateConfiguration } from "../packages/domain/src/configuration";
test("node removal maintains group membership and refuses last-member or rule-source damage", async () => {
  const dir = await mkdtemp(join(tmpdir(), "flowgate-node-removal-"));
  const stopped = { status: "stopped" as const, systemControl: false };
  const core = new ServiceCore(
    new StateStore(dir, 1),
    {
      status: async () => stopped,
      apply: async () => stopped,
      stop: async () => stopped,
    },
    async () => {},
    "test",
  );
  try {
    await core.start();
    const c = core.store.configuration;
    c.nodes = ["first", "second"].map((id) => ({
      id,
      name: id,
      type: "http" as const,
      server: "127.0.0.1",
      port: 23456,
      options: {},
    }));
    c.groups = [
      {
        id: "group",
        name: "Group",
        type: "selector",
        sourceId: "local",
        members: ["first", "second"],
        selected: "first",
      },
    ];
    c.settings.selectedNode = "group";
    validateConfiguration(c);
    await core.store.persist();
    await core.request("node.remove", { id: "first" }, "remove-first");
    const after = core.store.configuration;
    assert.deepEqual(after.groups?.[0].members, ["second"]);
    assert.equal(after.groups?.[0].selected, "second");
    assert.equal(after.settings.selectedNode, "group");
    validateConfiguration(after);
    await assert.rejects(
      core.request("node.remove", { id: "second" }, "remove-last"),
      /最后一个成员/,
    );
    assert.equal(core.store.configuration.nodes.length, 1);
    after.groups[0].members.push("direct");
    after.ruleSources = [
      {
        id: "rules",
        name: "Rules",
        url: "https://example.com/rules",
        format: "domain-list",
        outbound: "second",
        count: 0,
      },
    ];
    await assert.rejects(
      core.request("node.remove", { id: "second" }, "remove-source-target"),
      /规则集.*仍使用/,
    );
    validateConfiguration(core.store.configuration);
  } finally {
    await core.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
