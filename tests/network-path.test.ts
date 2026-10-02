import test from "node:test";
import assert from "node:assert/strict";
import type { NetworkState } from "../packages/contracts/src/index";
import { networkPath } from "../packages/domain/src/network-path";

function peerState(): NetworkState & { platform: string } {
  return {
    platform: "darwin",
    capturedAt: "",
    defaultInterface: "en0",
    defaultGateway: "192.0.2.1",
    proxyEnabled: false,
    systemProxies: [],
    pacEnabled: false,
    interfaces: [
      {
        name: "en0",
        addresses: ["192.0.2.2", "fe80::1"],
        cidrs: ["192.0.2.2/24", "fe80::1/64"],
      },
      { name: "awdl0", addresses: ["fe80::1111"], cidrs: ["fe80::1111/64"] },
      { name: "llw0", addresses: ["fe80::1111"], cidrs: ["fe80::1111/64"] },
      { name: "utun8", addresses: ["198.18.0.1"], cidrs: ["198.18.0.1/30"] },
    ],
    routes: ["default 192.0.2.1 UGScg en0"],
    ipv6Routes: ["default fe80::1 UGc en0", "fe80::1111 link#10 UHLSI awdl0"],
    dns: [{ domain: "", servers: ["192.0.2.1"] }],
    warnings: [],
    plugins: [],
  };
}
function rotated() {
  const after = peerState();
  for (const i of after.interfaces.filter((i) => /^(awdl|llw)/.test(i.name))) {
    i.addresses = ["fe80::2222"];
    i.cidrs = ["fe80::2222/64"];
  }
  // The real observation also lost neighbour routes; those are already ignored.
  after.ipv6Routes = ["default fe80::1 UGc en0"];
  return after;
}

test("sanitized stream regression: Darwin peer link-local rotation is not an egress change", () => {
  assert.equal(networkPath(peerState()), networkPath(rotated()));
});
for (const name of ["awdl0", "llw0"]) {
  test(`${name} link-local remains significant as default or explicitly configured interface`, () => {
    const before = peerState(),
      after = rotated();
    before.defaultInterface = after.defaultInterface = name;
    assert.notEqual(networkPath(before), networkPath(after));
    before.defaultInterface = after.defaultInterface = "en0";
    assert.notEqual(
      networkPath(before, undefined, [name]),
      networkPath(after, undefined, [name]),
    );
  });
}
for (const [label, mutate] of [
  [
    "default gateway",
    (s: NetworkState) => {
      s.defaultGateway = "192.0.2.254";
    },
  ],
  [
    "default interface",
    (s: NetworkState) => {
      s.defaultInterface = "utun8";
    },
  ],
  [
    "en0 link-local",
    (s: NetworkState) => {
      s.interfaces[0].addresses[1] = "fe80::5";
    },
  ],
  [
    "utun address",
    (s: NetworkState) => {
      s.interfaces[3].addresses = ["172.29.0.2"];
      s.interfaces[3].cidrs = ["172.29.0.2/30"];
    },
  ],
  [
    "peer non-link-local",
    (s: NetworkState) => {
      s.interfaces[1].addresses.push("192.0.2.9");
    },
  ],
  [
    "peer wide CIDR conflict",
    (s: NetworkState) => {
      s.interfaces[1].cidrs = ["fe80::2222/0"];
    },
  ],
  [
    "peer presence",
    (s: NetworkState) => {
      s.interfaces = s.interfaces.filter((i) => i.name !== "awdl0");
    },
  ],
  [
    "actual IPv4 route",
    (s: NetworkState) => {
      s.routes.push("10/8 192.0.2.1 UGSc en0");
    },
  ],
  [
    "actual IPv6 route on peer",
    (s: NetworkState) => {
      s.ipv6Routes!.push("fd00::/64 fe80::1 UGS awdl0");
    },
  ],
  [
    "DNS",
    (s: NetworkState) => {
      s.dns[0].servers = ["192.0.2.53"];
    },
  ],
  [
    "proxy",
    (s: NetworkState) => {
      s.proxyEnabled = true;
      s.systemProxies = [{ kind: "http", host: "127.0.0.1", port: 7890 }];
    },
  ],
  [
    "PAC",
    (s: NetworkState) => {
      s.pacEnabled = true;
    },
  ],
] as const) {
  test(`real ${label} change is preserved despite simultaneous peer churn`, () => {
    const before = peerState(),
      after = rotated();
    mutate(after);
    assert.notEqual(networkPath(before), networkPath(after));
  });
}
test("unknown platform or non-Darwin interface names are never filtered", () => {
  const before = peerState(),
    after = rotated();
  before.platform = after.platform = "linux";
  assert.notEqual(networkPath(before), networkPath(after));
  delete (before as Partial<typeof before>).platform;
  delete (after as Partial<typeof after>).platform;
  assert.notEqual(networkPath(before), networkPath(after));
});
