import { test } from "node:test";
import assert from "node:assert/strict";
import { PluginRegistry } from "../src/core/registry";
import { preview } from "../src/core/policy";
import { parseDns } from "../src/platform/macos";
test("内部域名只按完整标签边界匹配，且永不应用", () => {
  const decision = preview({
    target: "Git.Corp.Example.",
    corporateSuffix: "corp.example",
  });
  assert.equal(decision.category, "内部域名（用户指定）");
  assert.equal(decision.applied, false);
  assert.equal(
    preview({ target: "evilcorp.example", corporateSuffix: "corp.example" })
      .category,
    "其他流量",
  );
});
test("私有和共享地址不猜测公司/Tailscale归属", () => {
  for (const target of ["192.168.1.1", "10.2.3.4", "100.74.1.1"])
    assert.equal(
      preview({ target, corporateSuffix: "" }).context,
      "需要确认网络归属",
    );
});
test("拒绝非域名输入和无效 IPC 参数", () => {
  for (const target of ["https://example.com/a", "a;echo hi", "999.999.1.1/32"])
    assert.throws(() => preview({ target, corporateSuffix: "" }));
  assert.throws(() => preview(null as never));
});
test("插件异常不阻断其他诊断，注销后不再运行", async () => {
  const registry = new PluginRegistry();
  registry.register({
    id: "bad",
    name: "bad",
    apiVersion: 1,
    inspect: async () => {
      throw Error("secret");
    },
  });
  const plugin = {
    id: "good",
    name: "good",
    apiVersion: 1 as const,
    inspect: async () => ({
      id: "good",
      name: "good",
      installed: true,
      running: true,
      detail: "ok",
    }),
  };
  const dispose = registry.register(plugin);
  assert.throws(() => registry.register(plugin));
  const reports = await registry.inspect();
  assert.equal(reports.length, 2);
  assert.equal(reports[1].running, true);
  assert.ok(reports[0].error);
  assert.ok(!JSON.stringify(reports).includes("secret"));
  dispose();
  assert.equal((await registry.inspect()).length, 1);
});
test("DNS 保留企业域名与对应解析器", () => {
  const dns = parseDns(
    "resolver #1\n domain : corp.example\n nameserver[0] : 10.0.0.53\nresolver #2\n nameserver[0] : 1.1.1.1",
  );
  assert.deepEqual(dns[0], { domain: "corp.example", servers: ["10.0.0.53"] });
  assert.equal(dns.length, 2);
});
