import test from "node:test";
import assert from "node:assert/strict";
import {
  initialConfiguration,
  validateConfiguration,
} from "../packages/domain/src/configuration";
import { networkConflicts } from "../packages/domain/src/network-conflicts";
import type { NetworkState } from "../packages/contracts/src/index";

test("canonical local aliases cannot point an outbound back to our listener", () => {
  for (const server of [
    "LOCALHOST",
    "localhost.",
    "127.1",
    "2130706433",
    "0x7f000001",
    "[0:0:0:0:0:0:0:1]",
    "::ffff:127.0.0.1",
  ]) {
    const config = initialConfiguration();
    config.nodes.push({
      id: "loop",
      name: "loop",
      type: "socks",
      server,
      port: config.settings.listenPort,
      options: {},
    });
    assert.throws(() => validateConfiguration(config), /循环/, server);
    config.nodes[0].port++;
    assert.doesNotThrow(() => validateConfiguration(config));
  }
});

test("helper availability cannot hide another application's system proxy ownership", () => {
  const config = initialConfiguration();
  config.settings.mode = "system";
  const observed: NetworkState = {
    interfaces: [],
    proxyEnabled: true,
    capturedAt: new Date().toISOString(),
    defaultInterface: null,
    defaultGateway: null,
    dns: [],
    routes: [],
    warnings: [],
    plugins: [],
  };
  assert.ok(
    networkConflicts(config, observed, {
      status: "stopped",
      systemControl: true,
    }).some((x) => x.id === "existing-proxy"),
  );
  assert.ok(
    !networkConflicts(config, observed, {
      status: "running",
      systemControl: true,
      systemProxyOwned: true,
    }).some((x) => x.id === "existing-proxy"),
  );
});

import { cidrOverlap } from "../packages/domain/src/ip-range";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServiceCore } from "../packages/service/src/core";
import { StateStore } from "../packages/service/src/store";
import type { KernelState } from "../packages/contracts/src/index";

test("TUN rejects overlapping IPv4 and differently-spelled IPv6 interface networks before native mutation", () => {
  assert.equal(cidrOverlap("172.29.0.1/30", "172.16.22.5/12"), true);
  assert.equal(
    cidrOverlap("fdfe:dcba:9876::1/126", "fdfe:dcba:9876:0:ffff::1/64"),
    true,
  );
  assert.equal(cidrOverlap("172.29.0.1/30", "172.29.0.4/30"), false);
  assert.equal(
    cidrOverlap("::ffff:127.0.0.1/128", "0:0:0:0:0:ffff:7f00:1/128"),
    true,
  );
  assert.equal(cidrOverlap("172.29.0.1/30", "garbage/0"), false);
  const config = initialConfiguration();
  config.settings.mode = "tun";
  const observed: NetworkState = {
    interfaces: [
      { name: "utun9", addresses: ["172.16.22.5"], cidrs: ["172.16.22.5/12"] },
    ],
    capturedAt: "",
    defaultInterface: "en0",
    defaultGateway: "",
    proxyEnabled: false,
    dns: [],
    routes: [],
    warnings: [],
    plugins: [],
  };
  assert.ok(
    networkConflicts(config, observed, {
      status: "stopped",
      systemControl: true,
    }).some((c) => c.id === "tun-address:utun9"),
  );
  assert.ok(
    !networkConflicts(config, observed, {
      status: "running",
      systemControl: true,
      tunInterface: "utun9",
    }).some((c) => c.id.startsWith("tun-address:")),
  );
  observed.interfaces.push({
    name: "utun10",
    addresses: ["172.29.0.2"],
    cidrs: ["172.29.0.2/30"],
  });
  assert.ok(
    networkConflicts(config, observed, {
      status: "running",
      systemControl: true,
      tunInterface: "utun9",
    }).some((c) => c.id === "tun-address:utun10"),
  );
});

test("network changes reconnect the applied revision, ignore unchanged polls, and never steal a foreign proxy", async () => {
  const directory = await mkdtemp(join(tmpdir(), "flowgate-network-"));
  let observed: NetworkState = {
    interfaces: [{ name: "en0", addresses: ["192.168.1.2"] }],
    capturedAt: "",
    defaultInterface: "en0",
    defaultGateway: "192.168.1.1",
    proxyEnabled: false,
    dns: [],
    routes: [],
    warnings: [],
    plugins: [],
  };
  let kernel: KernelState = { status: "stopped", systemControl: true };
  let applies = 0,
    stops = 0;
  const core = new ServiceCore(
    new StateStore(directory, 1),
    {
      status: async () => kernel,
      apply: async (_config, revision, operationId) => {
        applies++;
        return (kernel = {
          status: "running",
          systemControl: true,
          appliedRevision: revision,
          operationId,
          systemProxyOwned: true,
        });
      },
      stop: async (operationId) => {
        stops++;
        return (kernel = {
          status: "stopped",
          systemControl: true,
          operationId,
        });
      },
    },
    async (method) =>
      method === "network.inspect" ? structuredClone(observed) : {},
    "test",
  );
  try {
    await core.start();
    await core.request("network.refresh", {});
    await core.request("proxy.connect", {}, "first");
    observed.defaultGateway = "192.168.1.254";
    await core.request("network.refresh", {});
    assert.equal(applies, 2);
    await core.request("network.refresh", {});
    assert.equal(applies, 2);
    core.store.configuration.settings.mode = "system";
    kernel.systemProxyOwned = false;
    observed.proxyEnabled = true;
    observed.pacEnabled = true;
    await core.request("network.refresh", {});
    assert.equal(stops, 1);
    assert.equal(applies, 2);
    await assert.rejects(
      core.request("proxy.connect", {}, "steal"),
      /其他代理或 PAC/,
    );
    assert.equal(applies, 2);
  } finally {
    await core.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

import { networkPath } from "../packages/domain/src/network-path";
test("network coordination ignores neighbour expiry, host clones and observation ordering", () => {
  const before: NetworkState = {
    capturedAt: "",
    defaultInterface: "en0",
    defaultGateway: "192.168.1.1",
    interfaces: [],
    proxyEnabled: false,
    dns: [],
    routes: [
      "default 192.168.1.1 UGScg en0",
      "192.168.1.7 aa:bb:cc UHLWI en0 1199",
    ],
    ipv6Routes: ["default fe80::1 UGc en0", "fe80::7 link#12 UHLWI en0 999"],
    warnings: [],
    plugins: [],
  };
  const after = structuredClone(before);
  after.routes = [
    "192.168.1.8 aa:bb:cc UHLWI en0 234",
    "default 192.168.1.1 UGScg en0",
  ];
  after.ipv6Routes = ["default fe80::1 UGc en0"];
  assert.equal(networkPath(before), networkPath(after));
  after.routes[1] = "default 192.168.1.254 UGScg en0";
  assert.notEqual(networkPath(before), networkPath(after));
});

test("TUN catches remote routed subnet overlap without treating a VPN default route as address ownership", () => {
  const config = initialConfiguration();
  config.settings.mode = "tun";
  const network: NetworkState = {
    capturedAt: "",
    defaultInterface: "utun5",
    defaultGateway: "",
    interfaces: [],
    proxyEnabled: false,
    dns: [],
    routes: [
      "default link#20 UCSg utun5",
      "0/1 link#20 UCSg utun5",
      "172.29/16 link#20 UCSg utun5",
    ],
    ipv6Routes: [
      "::/1 link#20 UCSg utun5",
      "fdfe:dcba:9876::/64 link#20 UCSg utun5",
    ],
    warnings: [],
    plugins: [],
  };
  const conflicts = networkConflicts(config, network, {
    status: "stopped",
    systemControl: true,
  });
  assert.equal(
    conflicts.filter((c) => c.id.startsWith("tun-route:")).length,
    2,
  );
  assert.ok(
    conflicts.some(
      (c) => c.id === "tunnel-default" && c.severity === "warning",
    ),
  );
});
