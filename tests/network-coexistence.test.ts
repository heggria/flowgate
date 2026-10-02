import test from "node:test";
import assert from "node:assert/strict";
import {
  initialConfiguration,
  compileConfiguration,
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
test("a saved unapplied mode change cannot prevent yielding an applied system proxy", async () => {
  const directory = await mkdtemp(join(tmpdir(), "flowgate-network-draft-"));
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
  const store = new StateStore(directory, 1);
  store.configuration.settings.mode = "system";
  const core = new ServiceCore(
    store,
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
    await core.request("proxy.connect", {}, "applied-system");
    const appliedRevision = store.configuration.revision;
    await core.request(
      "configuration.save",
      {
        revision: appliedRevision,
        settings: { mode: "manual" },
        rules: store.configuration.rules,
      },
      "save-without-applying",
    );
    assert.equal(kernel.appliedRevision, appliedRevision);
    assert.notEqual(store.configuration.revision, appliedRevision);
    // An ordinary path change must not apply the pending settings.
    observed.defaultGateway = "192.168.1.254";
    await core.request("network.refresh", {});
    assert.equal(applies, 1);
    assert.equal(stops, 0);
    // The active connection is still system mode despite the saved manual mode.
    observed.proxyEnabled = true;
    observed.systemProxies = [{ kind: "http", host: "127.0.0.1", port: 12345 }];
    kernel.systemProxyOwned = false;
    await core.request("network.refresh", {});
    assert.equal(
      stops,
      1,
      "Ownership loss must stop the applied system connection",
    );
    assert.equal(applies, 1, "Pending configuration must remain unapplied");
    assert.equal(store.configuration.settings.mode, "manual");
    assert.equal(
      [...store.operations].reverse().find((o) => o.kind === "proxy.disconnect")
        ?.nativeMode,
      "system",
    );
  } finally {
    await core.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
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

test("manual and system proxy preserve OS routing while TUN keeps loop protection", () => {
  const config = initialConfiguration();
  for (const mode of ["manual", "system", "tun"] as const) {
    config.settings.mode = mode;
    const compiled = compileConfiguration(config);
    assert.equal(compiled.route.auto_detect_interface, mode === "tun");
    assert.equal(compiled.inbounds[0].type, mode === "tun" ? "tun" : "mixed");
  }
});

for (const foreign of [false, true]) {
  test(`wake coordinates a changed path before consuming it (${foreign ? "foreign proxy" : "gateway"})`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "flowgate-wake-path-"));
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
      core.store.configuration.settings.mode = foreign ? "system" : "manual";
      await core.request("proxy.connect", {}, "before-sleep");
      core.suspend();
      observed.defaultGateway = "192.168.1.254";
      if (foreign) {
        observed.proxyEnabled = true;
        observed.systemProxies = [
          { kind: "http", host: "127.0.0.1", port: 7890 },
        ];
        kernel.systemProxyOwned = false;
      }
      await core.resume();
      await core.request("network.refresh", {});
      await core.request("network.refresh", {});
      assert.equal(applies, foreign ? 1 : 2);
      assert.equal(stops, foreign ? 1 : 0);
    } finally {
      await core.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("a committed unknown connect retains its original applied descriptor across restart and a different draft", async () => {
  const directory = await mkdtemp(join(tmpdir(), "flowgate-unknown-summary-"));
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
  let stops = 0;
  const port = {
    status: async () => kernel,
    apply: async (_config: unknown, revision: number, operationId: string) => {
      kernel = {
        status: "running",
        systemControl: true,
        appliedRevision: revision,
        operationId,
        systemProxyOwned: true,
      };
      throw Object.assign(Error("committed reply lost"), {
        outcome: "unknown",
      });
    },
    stop: async (operationId: string) => {
      stops++;
      return (kernel = {
        status: "stopped" as const,
        systemControl: true,
        operationId,
      });
    },
  };
  const extension = async (method: string) =>
    method === "network.inspect" ? structuredClone(observed) : {};
  let core = new ServiceCore(
    new StateStore(directory, 1),
    port,
    extension,
    "test",
  );
  try {
    await core.start();
    await core.request("network.refresh", {});
    core.store.configuration.settings.mode = "system";
    const originalPort = core.store.configuration.settings.listenPort;
    await assert.rejects(core.request("proxy.connect", {}, "lost-reply"), {
      outcome: "unknown",
    });
    // Model host loss before its drain can reconcile the committed reply.
    // Release fixture timers/lock/bindings directly; the native plane survives.
    core.suspend();
    await core.store.close();
    await core.native.dispose();
    core = new ServiceCore(
      new StateStore(directory, 2),
      port,
      extension,
      "test",
    );
    await core.start();
    assert.equal(
      core.store.operations.find((o) => o.id === "lost-reply")?.state,
      "succeeded",
    );
    assert.equal(core.store.appliedConnection?.mode, "system");
    assert.equal(core.store.appliedConnection?.listenPort, originalPort);
    await core.request(
      "configuration.save",
      {
        revision: 0,
        settings: { mode: "manual", listenPort: originalPort + 1 },
        rules: core.store.configuration.rules,
      },
      "new-draft",
    );
    assert.equal(core.store.appliedConnection?.mode, "system");
    assert.equal(core.store.appliedConnection?.revision, 0);
    assert.equal(core.store.appliedConnection?.listenPort, originalPort);
    observed.proxyEnabled = true;
    observed.systemProxies = [{ kind: "http", host: "127.0.0.1", port: 7890 }];
    kernel.systemProxyOwned = false;
    await core.request("network.refresh", {});
    assert.equal(stops, 1);
  } finally {
    core.store.operations = [];
    await core.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy reconciled system operations yield without reconstructing a summary from the draft", async () => {
  const directory = await mkdtemp(join(tmpdir(), "flowgate-legacy-summary-"));
  let observed: NetworkState = {
    interfaces: [],
    capturedAt: "",
    defaultInterface: null,
    defaultGateway: null,
    proxyEnabled: false,
    dns: [],
    routes: [],
    warnings: [],
    plugins: [],
  };
  let kernel: KernelState = { status: "stopped", systemControl: true };
  let stops = 0;
  const core = new ServiceCore(
    new StateStore(directory, 1),
    {
      status: async () => kernel,
      apply: async (_c, revision, operationId) =>
        (kernel = {
          status: "running",
          systemControl: true,
          appliedRevision: revision,
          operationId,
          systemProxyOwned: true,
        }),
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
    core.store.configuration.settings.mode = "system";
    await core.request("proxy.connect", {}, "legacy");
    // Model a pre-upgrade record: no exact descriptor was ever recorded.
    delete core.store.appliedConnection;
    delete core.store.operations[0].plannedConnection;
    await core.request(
      "configuration.save",
      {
        revision: 0,
        settings: { mode: "manual" },
        rules: core.store.configuration.rules,
      },
      "draft",
    );
    observed.proxyEnabled = true;
    kernel.systemProxyOwned = false;
    await core.request("network.refresh", {});
    assert.equal(stops, 1);
    assert.equal(core.store.appliedConnection, undefined);
    assert.equal(core.store.operations.at(-1)?.nativeMode, "system");
  } finally {
    await core.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

for (const legacy of [true, false]) {
  test(`manual emergency stop cannot attest a privileged/unknown disconnect (${legacy ? "legacy stale summary" : "unmatched source"})`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "flowgate-stop-authority-"));
    let kernel: KernelState = { status: "stopped", systemControl: true };
    const observed: NetworkState = {
      interfaces: [],
      capturedAt: "",
      defaultInterface: null,
      defaultGateway: null,
      proxyEnabled: false,
      dns: [],
      routes: [],
      warnings: [],
      plugins: [],
    };
    const port = {
      status: async () => kernel,
      apply: async (_c: unknown, revision: number, operationId: string) => {
        kernel = {
          status: "running",
          systemControl: true,
          operationId,
          appliedRevision: revision,
          systemProxyOwned: operationId === "legacy-system",
        };
        if (operationId === "legacy-system")
          throw Object.assign(Error("committed reply lost"), {
            outcome: "unknown",
          });
        return kernel;
      },
      stop: async () => {
        throw Object.assign(Error("stop unconfirmed"), { outcome: "unknown" });
      },
    };
    const extension = async (method: string) =>
      method === "network.inspect" ? structuredClone(observed) : {};
    let core = new ServiceCore(
      new StateStore(directory, 1),
      port,
      extension,
      "test",
    );
    try {
      await core.start();
      await core.request("proxy.connect", {}, "prior-manual");
      if (legacy) {
        await core.request(
          "configuration.save",
          { revision: 0, settings: { mode: "system" }, rules: [] },
          "system-draft",
        );
        await assert.rejects(
          core.request("proxy.connect", {}, "legacy-system"),
          { outcome: "unknown" },
        );
        delete core.store.operations.find((o) => o.id === "legacy-system")!
          .plannedConnection;
        await core.store.persist();
        core.suspend();
        await core.store.close();
        await core.native.dispose();
        core = new ServiceCore(
          new StateStore(directory, 2),
          port,
          extension,
          "test",
        );
        await core.start();
        assert.equal(
          core.store.operations.find((o) => o.id === "legacy-system")?.state,
          "succeeded",
        );
        assert.equal(core.store.appliedConnection?.operationId, "prior-manual");
      } else {
        // Native identity has no matching persisted source; current draft is manual.
        kernel = {
          status: "running",
          systemControl: true,
          operationId: "unrecorded-system",
          appliedRevision: 7,
        };
      }
      await assert.rejects(
        core.request("proxy.disconnect", {}, "stop-unknown"),
        { outcome: "unknown" },
      );
      const stop = core.store.operations.find((o) => o.id === "stop-unknown")!;
      assert.equal(stop.nativeMode, legacy ? "system" : undefined);
      // Even an exact stop ID on a manual fallback cannot attest unknown authority.
      kernel = {
        status: "stopped",
        systemControl: false,
        operationId: "stop-unknown",
      };
      await core.request("operation.get", { id: stop.id });
      assert.equal(stop.state, "unknown");
      kernel = {
        status: "stopped",
        systemControl: false,
        operationId: "recovery-disconnect",
      };
      await core.request("operation.get", { id: stop.id });
      assert.equal(stop.state, "unknown");
      assert.equal(stop.recoveredBy, undefined);
      kernel = { ...kernel, systemControl: true };
      await core.request("operation.get", { id: stop.id });
      assert.equal(stop.state, "succeeded");
      assert.equal(stop.recoveredBy, "recovery-disconnect");
    } finally {
      core.store.operations = [];
      await core.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

for (const mode of ["manual", "bound", "tun"] as const) {
  test(`peer privacy rotation does not restart an unrelated ${mode} connection and real dependencies still coordinate`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "flowgate-peer-churn-"));
    let observed: NetworkState & { platform: string } = {
      platform: "darwin",
      interfaces: [
        { name: "en0", addresses: ["192.0.2.2"], cidrs: ["192.0.2.2/24"] },
        { name: "awdl0", addresses: ["fe80::1111"], cidrs: ["fe80::1111/64"] },
        { name: "llw0", addresses: ["fe80::1111"], cidrs: ["fe80::1111/64"] },
        { name: "utun8", addresses: ["198.18.0.1"], cidrs: ["198.18.0.1/30"] },
      ],
      capturedAt: "",
      defaultInterface: "en0",
      defaultGateway: "192.0.2.1",
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
        apply: async (_c, revision, operationId) => {
          applies++;
          return (kernel = {
            status: "running",
            systemControl: true,
            appliedRevision: revision,
            operationId,
            ...(mode === "tun" ? { tunInterface: "utun100" } : {}),
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
      if (mode === "bound")
        core.store.configuration.externalNetworks = [
          {
            id: "peer",
            name: "peer",
            interface: "awdl0",
            dnsServer: "udp://192.0.2.53",
          },
        ];
      if (mode === "tun") core.store.configuration.settings.mode = "tun";
      await core.request("proxy.connect", {}, "stream-start");
      const originalOperation = kernel.operationId;
      for (const i of observed.interfaces.filter((i) =>
        /^(awdl|llw)/.test(i.name),
      )) {
        i.addresses = ["fe80::2222"];
        i.cidrs = ["fe80::2222/64"];
      }
      await core.request("network.refresh", {});
      await core.request("network.refresh", {});
      assert.equal(applies, mode === "bound" ? 2 : 1);
      assert.equal(stops, 0);
      if (mode !== "bound") assert.equal(kernel.operationId, originalOperation);
      if (mode === "tun") {
        observed.interfaces[3].addresses = ["172.29.0.2"];
        observed.interfaces[3].cidrs = ["172.29.0.2/30"];
        await core.request("network.refresh", {});
        assert.equal(stops, 1, "new TUN overlap must yield the connection");
      } else {
        observed.defaultGateway = "192.0.2.254";
        await core.request("network.refresh", {});
        assert.equal(
          applies,
          mode === "bound" ? 3 : 2,
          "real default path change must still reconnect",
        );
      }
    } finally {
      await core.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
