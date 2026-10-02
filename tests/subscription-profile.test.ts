import test from "node:test";
import assert from "node:assert/strict";
import { initialConfiguration } from "../packages/domain/src/configuration";
import { parseSubscriptionDocument } from "../packages/extensions/src/subscriptions/index";
import { SubscriptionService } from "../packages/service/src/subscriptions";

const source = (nameserver: string) =>
  JSON.stringify({
    proxies: [{ name: "A", type: "http", server: "proxy.example", port: 8080 }],
    "proxy-groups": [
      { name: "Pick", type: "select", proxies: ["A", "DIRECT"] },
    ],
    rules: ["MATCH,Pick"],
    dns: { enable: true, nameserver: [nameserver] },
  });
const service = () => {
  const configuration = initialConfiguration();
  return new SubscriptionService(
    () => configuration,
    async (method, payload: any) => {
      assert.equal(method, "subscription.parse");
      return parseSubscriptionDocument(payload.text, payload.options);
    },
  );
};

test("full Clash migration explicitly rejects DNS routing and extra fragment options", async () => {
  for (const address of [
    "https://1.1.1.1/dns-query#Pick",
    "tls://1.1.1.1#RULES",
    "1.1.1.1#fixture-interface",
    "https://1.1.1.1/dns-query#h3=true",
    "https://1.1.1.1/dns-query#skip-cert-verify=true",
    "https://1.1.1.1/dns-query#Pick&ecs=192.0.2.0/24&ecs-override=true",
  ]) {
    const subscriptions = service();
    const preview = await subscriptions.preview({
      text: source(address),
      options: { format: "clash" },
      migration: "profile",
    });
    assert.equal(preview.profile.supported, false, address);
    assert.equal(preview.canCommit, false, address);
    assert.equal(preview.profile.dnsServer, undefined);
    assert.match(preview.profile.blockers.join(" "), /路由|附加参数/);
    assert.doesNotMatch(
      preview.profile.blockers.join(" "),
      /192\.0\.2|fixture-interface/,
    );
    assert.throws(
      () => subscriptions.commit(preview.id, false, undefined, true),
      /未解决/,
    );
    const nodesOnly = await subscriptions.preview({
      text: source(address),
      options: { format: "clash" },
      migration: "nodes",
    });
    assert.equal(nodesOnly.canCommit, true);
    assert.equal(nodesOnly.profile.supported, false);
    const next = subscriptions.commit(nodesOnly.id, false, undefined, true);
    assert.equal(next.nodes.length, 1);
    assert.equal(
      next.settings.dnsServer,
      initialConfiguration().settings.dnsServer,
    );
  }
});

test("ordinary DoH query parameters and encoded hash content remain supported", async () => {
  const address = "https://dns.example/dns-query?fixture=value%23content";
  const subscriptions = service();
  const preview = await subscriptions.preview({
    text: source(address),
    options: { format: "clash" },
    migration: "profile",
  });
  assert.equal(preview.profile.supported, true);
  assert.equal(preview.canCommit, true);
  assert.equal(
    subscriptions.commit(preview.id, false, undefined, true).settings.dnsServer,
    address,
  );
});

test("full migration rejects unrepresented UDP and TLS DNS paths or query parameters", async () => {
  for (const address of [
    "udp://1.1.1.1/fixture-path",
    "udp://1.1.1.1?fixture=value",
    "tls://dns.example/fixture-path",
    "tls://dns.example?fixture=value",
    "udp://[::1]:5353/fixture-path?fixture=value",
  ]) {
    const subscriptions = service();
    const preview = await subscriptions.preview({
      text: source(address),
      options: { format: "clash" },
      migration: "profile",
    });
    assert.equal(preview.profile.supported, false, address);
    assert.equal(preview.canCommit, false, address);
    assert.equal(preview.profile.dnsServer, undefined);
    assert.match(preview.profile.blockers.join(" "), /路径|查询参数/);
    assert.doesNotMatch(
      preview.profile.blockers.join(" "),
      /fixture-path|fixture=value/,
    );
  }
});
