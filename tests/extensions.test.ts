import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExtensionManager } from "../packages/extensions/src/manager";
import {
  builtinExtensions,
  extensionPreferences,
  type ExtensionDescriptor,
} from "../packages/contracts/src/extensions";
import type { RuntimeModule } from "../packages/runtime/src/lifecycle";
import { StateStore } from "../packages/service/src/store";
import { ServiceCore } from "../packages/service/src/core";
import { validateRelease } from "../packages/release/src/loader";
import type { ReleaseSet } from "../packages/contracts/src/index";

const descriptor = (
  id: string,
  required = false,
  dependencies: string[] = [],
): ExtensionDescriptor => ({
  id,
  name: id,
  description: id,
  version: "1",
  required,
  defaultEnabled: true,
  dependencies,
  capabilities: [],
  permissions: [],
  contributions: ["command"],
  methods: [id],
});
function moduleFor(
  d: ExtensionDescriptor,
  activate: RuntimeModule["activate"],
): RuntimeModule {
  return {
    manifest: {
      id: d.id,
      version: d.version,
      api: 1,
      dependencies: d.dependencies,
      capabilities: d.capabilities,
    },
    activate,
  };
}
const identity = { epoch: 1, releaseSet: "test", version: "1" };

test("optional package drains its own calls and removes contributions without stopping core; dependency and core policies enforced", async () => {
  const core = descriptor("core", true),
    optional = descriptor("optional", false, ["core"]);
  let released = false,
    started!: () => void;
  const admitted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const manager = new ExtensionManager(
    [core, optional],
    [
      moduleFor(core, async (c) => {
        c.contribute({ id: "core", kind: "command", value: () => "alive" });
      }),
      moduleFor(optional, async (c) => {
        c.defer(() => {
          released = true;
        });
        c.contribute({
          id: "optional",
          kind: "command",
          value: (_: unknown, signal: AbortSignal) =>
            new Promise((resolve) => {
              started();
              signal.addEventListener("abort", () => resolve("canceled"), {
                once: true,
              });
            }),
        });
      }),
    ],
    identity,
  );
  await manager.configure({});
  const pending = manager.call("optional");
  await admitted;
  const stopping = manager.configure({ optional: false });
  assert.equal(await manager.call("core"), "alive");
  await stopping;
  assert.equal(await pending, "canceled");
  assert.equal(released, true);
  await assert.rejects(manager.call("optional"), /未启用/);
  await assert.rejects(manager.configure({ core: false }), /核心/);
  await assert.rejects(manager.configure({ unknown: true }), /未知/);
  await manager.configure({});
  assert.match(
    manager.snapshot().find((entry) => entry.id === "optional")!.instance!,
    /:2$/,
  );
  const events = manager.trace
    .snapshot()
    .filter((event) => event.name === "optional");
  assert.ok(
    events.some(
      (event) =>
        event.status === "stopped" &&
        event.context.releaseSet === "test" &&
        event.context.pluginInstance?.endsWith(":1"),
    ),
  );
  await manager.stop();
});

test("failed optional activation rolls back admission, keeps core usable and allows a clean retry", async () => {
  const core = descriptor("core", true),
    optional = descriptor("optional");
  let fail = true;
  const manager = new ExtensionManager(
    [core, optional],
    [
      moduleFor(core, async (c) => {
        c.contribute({ id: "core", kind: "command", value: () => true });
      }),
      moduleFor(optional, async (c) => {
        if (fail) throw new Error("fixture");
        c.contribute({ id: "optional", kind: "command", value: () => true });
      }),
    ],
    identity,
  );
  await manager.configure({}, true);
  await assert.rejects(manager.configure({}), /fixture/);
  assert.equal(await manager.call("core"), true);
  assert.equal(
    manager.snapshot().find((entry) => entry.id === "optional")!.status,
    "failed",
  );
  fail = false;
  await manager.configure({});
  assert.equal(await manager.call("optional"), true);
  await manager.stop();
});

test("extension dependency removal and undeclared or colliding contributions are rejected", async () => {
  const a = descriptor("a"),
    b = descriptor("b", false, ["a"]);
  const modules = [a, b].map((d) =>
    moduleFor(d, async (c) => {
      c.contribute({ id: d.id, kind: "command", value: () => true });
    }),
  );
  const manager = new ExtensionManager([a, b], modules, identity);
  await manager.configure({});
  await assert.rejects(manager.configure({ a: false }), /依赖/);
  assert.equal(await manager.call("a"), true);
  await manager.stop();
  const invalid = new ExtensionManager(
    [a],
    [
      moduleFor(a, async (c) =>
        c.contribute({ id: "undeclared", kind: "command", value: () => true }),
      ),
    ],
    identity,
  );
  await assert.rejects(invalid.configure({}), /清单/);
  await assert.rejects(invalid.call("undeclared"));
  await invalid.stop();
});

test("Service persists extension preferences independently of network revision and restores them into a replacement host", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fg-extensions-"));
  const system = {
    interfaces: [],
    routes: [],
    dns: [],
    warnings: [],
    plugins: [],
    defaultInterface: null,
    defaultGateway: null,
    proxyEnabled: false,
    capturedAt: new Date().toISOString(),
  };
  const create = () =>
    new ExtensionManager(
      builtinExtensions,
      builtinExtensions.map((d) =>
        moduleFor(d, async (c) => {
          for (const method of d.methods)
            c.contribute({
              id: method,
              kind: "command",
              value: () =>
                method === "network.inspect"
                  ? system
                  : {
                      id: d.id,
                      name: d.name,
                      installed: false,
                      running: false,
                      detail: "fixture",
                    },
            });
        }),
      ),
      identity,
    );
  let manager = create();
  await manager.configure({}, true);
  const extension = async (method: string, payload?: any) => {
    if (method === "health")
      return { extensions: manager.snapshot(), modules: [] };
    if (method === "extensions.configure")
      return manager.configure(payload.preferences);
    if (method === "network.inspect") return manager.inspectNetwork();
    return manager.call(method, payload);
  };
  const native: any = {
    status: async () => ({ status: "stopped", systemControl: false }),
    apply: async () => {},
    stop: async () => {},
  };
  let service = new ServiceCore(
    new StateStore(directory, 1),
    native,
    extension,
    "test",
  );
  await service.start();
  await service.request(
    "extensions.setEnabled",
    { id: "builtin.tailscale", enabled: false, revision: 0 },
    "disable",
  );
  assert.equal(service.store.configuration.revision, 0);
  assert.equal(service.store.extensionRevision, 1);
  await assert.rejects(
    service.request(
      "extensions.setEnabled",
      { id: "builtin.rules", enabled: false, revision: 1 },
      "core",
    ),
    /核心/,
  );
  await assert.rejects(
    service.request(
      "extensions.setEnabled",
      { id: "builtin.singbox", enabled: false, revision: 0 },
      "stale",
    ),
    /已变化/,
  );
  await service.stop();
  await manager.stop();
  manager = create();
  await manager.configure({}, true);
  service = new ServiceCore(
    new StateStore(directory, 2),
    native,
    extension,
    "test",
  );
  await service.start();
  const state = (await service.snapshot()).extensions!.find(
    (entry) => entry.id === "builtin.tailscale",
  )!;
  assert.equal(state.status, "stopped");
  assert.equal(state.desiredEnabled, false);
  assert.equal(
    ((await manager.inspectNetwork()) as any).plugins.some(
      (plugin: any) => plugin.id === "builtin.tailscale",
    ),
    false,
  );
  await service.stop();
  await manager.stop();
});

test("catalog permissions cannot escalate through a dynamic release and new catalog must enumerate installed packages", () => {
  assert.throws(
    () => extensionPreferences({ "builtin.network": false }),
    /核心/,
  );
  assert.throws(() => extensionPreferences({ unknown: true }), /未知/);
  const m: ReleaseSet = {
    id: "catalog",
    version: 1,
    channel: "stable",
    shellApi: { min: 1, max: 1 },
    protocol: 1,
    schema: { min: 1, max: 1 },
    ui: "ui.js",
    service: "service.js",
    extension: "ext.js",
    builtins: [],
    files: Object.fromEntries(
      ["ui.js", "service.js", "ext.js"].map((name) => [
        name,
        { size: 1, sha256: "a".repeat(64) },
      ]),
    ),
  };
  m.builtins = [
    { id: "builtin.tailscale", version: "1", permissions: ["credentials.all"] },
  ];
  assert.throws(() => validateRelease(m), /权限/);
  m.builtins = [];
  m.catalogVersion = 1;
  assert.throws(() => validateRelease(m), /不完整/);
  m.builtins = builtinExtensions.map(
    ({ id, version, permissions, capabilities, contributions }) => ({
      id,
      version,
      permissions,
      capabilities,
      contributions,
    }),
  );
  validateRelease(m);
});

test("failed disposal is reported and cannot silently admit a second instance", async () => {
  const d = descriptor("leaky");
  let starts = 0;
  const manager = new ExtensionManager(
    [d],
    [
      moduleFor(d, async (c) => {
        starts++;
        c.contribute({ id: d.id, kind: "command", value: () => true });
        c.defer(() => {
          throw new Error("cleanup failed");
        });
      }),
    ],
    identity,
  );
  await manager.configure({});
  await assert.rejects(manager.configure({ leaky: false }), /release failed/);
  assert.equal(manager.snapshot()[0].status, "failed");
  await assert.rejects(manager.configure({ leaky: true }), /重启/);
  await assert.rejects(manager.configure({ leaky: false }), /重启/);
  assert.equal(starts, 1);
  await assert.rejects(manager.stop(), /重启/);
});
