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
    interfaces: [], proxyEnabled: true, capturedAt: new Date().toISOString(),
    defaultInterface: null, defaultGateway: null, dns: [], routes: [], warnings: [], plugins: [],
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
