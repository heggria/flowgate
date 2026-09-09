import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRuleSet } from "../packages/extensions/src/ruleset";
import { ServiceCore } from "../packages/service/src/core";
import { StateStore } from "../packages/service/src/store";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
test("rule sets reject compound semantics and retain deterministic identities", () => {
  const payload = {
    text: "# list\nexample.com\nexample.com\nopenai.com",
    format: "domain-list",
    sourceId: "source",
    outbound: "block",
  };
  const rules = parseRuleSet(payload);
  assert.equal(rules.length, 2);
  assert.equal(
    parseRuleSet({ ...payload, text: "openai.com\nexample.com" })[1].id,
    rules[0].id,
  );
  assert.throws(
    () =>
      parseRuleSet({
        ...payload,
        format: "sing-box-json",
        text: JSON.stringify({
          version: 1,
          rules: [{ domain: ["x.com"], process_name: ["App"] }],
        }),
      }),
    /组合/,
  );
});
test("rule-set refresh failure preserves snapshot and successful refresh replaces source rules", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fg-rules-"));
  let text = "example.com";
  const core = new ServiceCore(
    new StateStore(dir, 1),
    {
      status: async () => ({ status: "stopped", systemControl: false }),
      apply: async () => ({ status: "running", systemControl: false }),
      stop: async () => ({ status: "stopped", systemControl: false }),
    },
    async (method, payload: any) => {
      if (method === "subscription.fetch") return text;
      if (method === "ruleset.parse") return parseRuleSet(payload);
      throw new Error("No fixture");
    },
    "test",
  );
  try {
    await core.start();
    await core.request(
      "ruleset.import",
      {
        name: "Block list",
        url: "https://example.invalid/rules",
        format: "domain-list",
        outbound: "block",
      },
      "import",
    );
    const source = core.store.configuration.ruleSources![0];
    const ruleId = core.store.configuration.rules[0].id;
    text = "not a domain";
    await assert.rejects(
      core.request("ruleset.refresh", { id: source.id }, "fail"),
    );
    assert.equal(core.store.configuration.rules[0].id, ruleId);
    assert.ok(core.store.configuration.ruleSources![0].error);
    text = "example.com\nopenai.com";
    await core.request("ruleset.refresh", { id: source.id }, "refresh");
    assert.equal(core.store.configuration.rules.length, 2);
    assert.equal(core.store.configuration.rules[0].id, ruleId);
    assert.equal((await core.snapshot()).configuration.ruleSources![0].url, "");
    await core.request("ruleset.remove", { id: source.id }, "remove");
    assert.equal(core.store.configuration.rules.length, 0);
  } finally {
    await core.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
