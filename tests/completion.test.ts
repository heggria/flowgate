import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CapabilityHost,
  NamespacedStorage,
} from "../packages/runtime/src/capabilities";
import { DraftStore } from "../packages/shell/src/drafts";
import { StateStore } from "../packages/service/src/store";
import { ServiceCore } from "../packages/service/src/core";
test("uncooperative job cannot hang drain or admit new work", async () => {
  const host = new CapabilityHost(
    {
      id: "test",
      version: "1",
      api: 1,
      dependencies: [],
      capabilities: ["jobs"],
    },
    new Set(),
    new Set(),
    async () => "",
  );
  let finish!: () => void;
  host.job("stuck", () => new Promise<void>((r) => (finish = r)));
  await assert.rejects(host.drain(Date.now() + 25), /排空超时/);
  assert.throws(() => host.job("new", async () => {}), /denied/);
  finish();
  await host.stop();
});
test("namespace rejects parent paths and symlink namespace", async () => {
  const root = await mkdtemp(join(tmpdir(), "fg-storage-"));
  try {
    assert.throws(() => new NamespacedStorage(root, ".."));
    await symlink(tmpdir(), join(root, "linked"));
    await assert.rejects(new NamespacedStorage(root, "linked").put("value", 1));
    const s = new NamespacedStorage(root, "ok");
    await Promise.all([s.put("a", 1), s.put("b", 2)]);
    assert.equal(await s.get("a"), 1);
    assert.equal(await s.get("b"), 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("draft namespaces survive replacement and oversized write preserves accepted data", () => {
  const d = new DraftStore();
  d.set("rules", { value: "example.com" });
  d.set("settings", { port: 18000 });
  assert.throws(() => d.set("rules", "x".repeat(5 * 1024 * 1024)));
  assert.throws(() => d.assertReloadable(), /草稿/);
  d.set("rules", { value: "example.com" });
  d.assertReloadable();
  assert.deepEqual(d.get("rules"), { value: "example.com" });
  d.set("settings", null);
  assert.equal(d.get("settings"), null);
  assert.deepEqual(d.get("rules"), { value: "example.com" });
});
test("subscription removal preserves nodes and rules; stale edits and failed refresh preserve config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fg-management-"));
  const core = new ServiceCore(
    new StateStore(dir, 1),
    {
      status: async () => ({ status: "stopped", systemControl: false }),
      apply: async () => ({ status: "running", systemControl: false }),
      stop: async () => ({ status: "stopped", systemControl: false }),
    },
    async () => {
      throw new Error("offline");
    },
    "test",
  );
  try {
    await core.start();
    const c = core.store.configuration;
    c.nodes = [
      {
        id: "n",
        name: "Node",
        type: "socks",
        server: "localhost",
        port: 19999,
        options: { password: "test-secret" },
        sourceId: "s",
      },
    ];
    c.subscriptions = [
      { id: "s", name: "Source", url: "https://example.invalid", count: 1 },
    ];
    c.rules = [
      { id: "r", kind: "domain", value: "example.com", outbound: "n" },
    ];
    c.settings.selectedNode = "n";
    await core.store.persist();
    await assert.rejects(
      core.request("subscription.refresh", { id: "s" }, "refresh"),
    );
    assert.equal(core.store.configuration.nodes.length, 1);
    assert(core.store.configuration.subscriptions[0].error);
    await core.request(
      "subscription.rename",
      { id: "s", name: "New name" },
      "rename",
    );
    assert.equal(core.store.configuration.subscriptions[0].name, "New name");
    await assert.rejects(
      core.request(
        "node.update",
        { id: "n", revision: 0, name: "stale" },
        "stale",
      ),
    );
    assert.equal(core.store.configuration.nodes[0].name, "Node");
    await core.request(
      "node.update",
      { id: "n", revision: 1, name: "Edited", port: 20001 },
      "edit",
    );
    assert.equal(
      core.store.configuration.nodes[0].options.password,
      "test-secret",
    );
    assert.deepEqual(
      (await core.snapshot()).configuration.nodes[0].options,
      {},
    );
    await core.request("subscription.remove", { id: "s" }, "remove");
    assert.equal(core.store.configuration.subscriptions.length, 0);
    assert.equal(core.store.configuration.nodes[0].sourceId, undefined);
    assert.equal(core.store.configuration.rules[0].outbound, "n");
  } finally {
    await core.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("drain cancels preparing services and reserves their IDs", async () => {
  const host = new CapabilityHost(
    {
      id: "race",
      version: "1",
      api: 1,
      dependencies: [],
      capabilities: ["services"],
    },
    new Set(),
    new Set(),
    async () => "",
  );
  let release!: () => void;
  let starts = 0,
    stops = 0;
  const service = {
    prepare: async () =>
      new Promise<void>((r) => {
        release = r;
      }),
    start: async () => {
      starts++;
    },
    health: async () => true,
    drain: async () => {},
    stop: async () => {
      stops++;
    },
  };
  const startup = host.service("s", service);
  await Promise.resolve();
  await assert.rejects(host.service("s", service), /Duplicate/);
  const draining = host.drain(Date.now() + 1000);
  release();
  await assert.rejects(startup, /canceled/);
  await draining;
  assert.equal(starts, 0);
  assert.equal(stops, 1);
  await host.stop();
});

import { NetworkObserver } from "../packages/service/src/network-observer";
test("network observations coalesce requests and ignore late completion after stop", async () => {
  let release!: (value: any) => void;
  let inspections = 0,
    publications = 0;
  const observer = new NetworkObserver(
    () => {
      inspections++;
      return new Promise((r) => {
        release = r;
      });
    },
    () => {
      publications++;
    },
    () => {},
  );
  const first = observer.refresh();
  const second = observer.refresh();
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(inspections, 1);
  observer.stop();
  release({});
  await first;
  assert.equal(publications, 0);
  await assert.rejects(observer.refresh(), /stopped/);
});

import { networkConflicts } from "../packages/domain/src/network-conflicts";
import { initialConfiguration } from "../packages/domain/src/configuration";
test("network conflicts distinguish owned proxy and missing explicit interface", () => {
  const config = initialConfiguration();
  config.settings.mode = "system";
  config.externalNetworks = [
    {
      id: "vpn",
      name: "Work",
      interface: "utun9",
      dnsServer: "udp://10.0.0.1",
    },
  ];
  const observed = {
    capturedAt: new Date().toISOString(),
    defaultInterface: "en0",
    defaultGateway: null,
    proxyEnabled: true,
    interfaces: [{ name: "en0", addresses: [] }],
    dns: [],
    routes: [],
    warnings: [],
    plugins: [],
  };
  assert.deepEqual(
    networkConflicts(config, observed, {
      status: "running",
      systemControl: true,
      systemProxyOwned: true,
    }).map((x) => x.id),
    ["interface:vpn"],
  );
  assert.deepEqual(
    networkConflicts(config, observed, {
      status: "stopped",
      systemControl: false,
    }).map((x) => x.id),
    ["interface:vpn", "existing-proxy"],
  );
  assert.equal(
    networkConflicts(config, null, { status: "unknown", systemControl: false })
      .length,
    0,
  );
});

import { ExtensionRuntime } from "../packages/extensions/src/runtime";
test("extension handlers activate atomically, cancel and release on drain", async () => {
  const runtime = new ExtensionRuntime();
  let disposed = false;
  await runtime.start([
    {
      manifest: {
        id: "one",
        version: "1",
        api: 1,
        capabilities: [],
        dependencies: [],
      },
      async activate(ctx) {
        ctx.defer(() => {
          disposed = true;
        });
        ctx.contribute({
          id: "wait",
          kind: "command",
          value: (_: unknown, signal: AbortSignal) =>
            new Promise((resolve) => {
              if (signal.aborted) resolve("canceled");
              else
                signal.addEventListener("abort", () => resolve("canceled"), {
                  once: true,
                });
            }),
        });
      },
    },
  ]);
  const result = runtime.call("wait");
  await Promise.resolve();
  await runtime.drain(Date.now() + 1000);
  assert.equal(await result, "canceled");
  await assert.rejects(runtime.call("wait"), /退出/);
  await runtime.stop();
  assert.equal(disposed, true);
});

import { DurableJobs } from "../packages/runtime/src/jobs";
test("durable jobs preserve checkpoint through pause and restart without auto replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "fg-jobs-"));
  try {
    const storage = new NamespacedStorage(root, "test.jobs");
    let checkpointed!: () => void;
    const checkpoint = new Promise<void>((r) => {
      checkpointed = r;
    });
    const definitions = new Map([
      [
        "download",
        {
          resumable: true,
          async run(ctx: any) {
            await ctx.save({ offset: 5 });
            checkpointed();
            await new Promise<void>((r) => {
              if (ctx.signal.aborted) r();
              else
                ctx.signal.addEventListener("abort", () => r(), { once: true });
            });
          },
        },
      ],
    ]);
    const jobs = new DurableJobs(storage, definitions);
    await jobs.restore();
    const id = await jobs.create("download");
    await jobs.resume(id);
    await checkpoint;
    await jobs.interrupt(id, "pause");
    const restored = new DurableJobs(storage, definitions);
    await restored.restore();
    assert.equal(restored.snapshot()[0].state, "paused");
    assert.deepEqual(restored.snapshot()[0].checkpoint, { offset: 5 });
    await restored.interrupt(id, "cancel");
    await assert.rejects(restored.resume(id), /cannot resume/);
    await storage.put("jobs", {
      schema: 1,
      records: [
        { id: "unsafe", kind: "payment", state: "running", checkpoint: null },
        {
          id: "safe",
          kind: "download",
          state: "running",
          checkpoint: { offset: 5 },
        },
      ],
    });
    const crash = new DurableJobs(storage, definitions);
    await crash.restore();
    assert.deepEqual(
      crash.snapshot().map((r) => r.state),
      ["unknown", "paused"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import { createServer } from "node:http";
test("capability endpoints are loopback-owned and released with streams", async () => {
  const host = new CapabilityHost(
    {
      id: "endpoints",
      version: "1",
      api: 1,
      capabilities: ["endpoints", "streams"],
      dependencies: [],
    },
    new Set(),
    new Set(),
    async () => "",
  );
  const server = createServer((_req, res) => res.end("ok"));
  const port = await host.endpoint("api", server);
  assert.equal((server.address() as any).address, "127.0.0.1");
  assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), "ok");
  await assert.rejects(
    host.endpoint("api", createServer()),
    /already registered/,
  );
  const stream = host.stream("one");
  assert.deepEqual(host.resources(), { endpoints: ["api"], streams: 1 });
  await host.stop();
  assert.equal(stream.signal.aborted, true);
  assert.equal(server.listening, false);
  assert.deepEqual(host.resources(), { endpoints: [], streams: 0 });
});

test("egress reaches real upstream through selected proxy and never falls back", async () => {
  const { request } = await import("node:http");
  const { once } = await import("node:events");
  const upstream = createServer((_req, res) => res.end("upstream"));
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const target = `http://127.0.0.1:${(upstream.address() as any).port}`;
  let forwarded = 0;
  const proxy = createServer((req, res) => {
    forwarded++;
    const outgoing = request(req.url!, (incoming) => incoming.pipe(res));
    outgoing.on("error", () => res.destroy());
    outgoing.end();
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const proxyUrl = `http://127.0.0.1:${(proxy.address() as any).port}`;
  const host = new CapabilityHost(
    {
      id: "egress",
      version: "1",
      api: 1,
      dependencies: [],
      capabilities: ["egress"],
    },
    new Set(["selected"]),
    new Set(),
    async () => "",
    async () => ({
      id: "selected",
      proxyUrl,
      configurationRevision: 4,
      allowedOrigins: [target],
    }),
  );
  try {
    const response = await host.requestEgress(
      "selected",
      target,
      new AbortController().signal,
    );
    let body = "";
    for await (const chunk of response) body += chunk;
    assert.equal(body, "upstream");
    assert.equal(forwarded, 1);
    await assert.rejects(
      host.requestEgress("other", target, new AbortController().signal),
      /denied/,
    );
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await assert.rejects(
      host.requestEgress("selected", target, new AbortController().signal),
    );
    assert.equal(forwarded, 1);
  } finally {
    proxy.closeAllConnections();
    proxy.close();
    upstream.closeAllConnections();
    upstream.close();
    await host.stop();
  }
});

test("storage serializes same-namespace transactions and commits migrations atomically", async () => {
  const root = await mkdtemp(join(tmpdir(), "fg-migrate-"));
  try {
    const a = new NamespacedStorage(root, "module"),
      b = new NamespacedStorage(root, "module");
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        (i % 2 ? a : b).update<number>(
          "counter",
          async (value) => (value ?? 0) + 1,
        ),
      ),
    );
    assert.equal(await a.get("counter"), 20);
    const steps = new Map<number, (value: unknown) => unknown>([
      [1, () => ({ count: 1 })],
      [
        2,
        () => {
          throw new Error("migration failed");
        },
      ],
    ]);
    await assert.rejects(a.migrate("state", 2, steps), /migration failed/);
    assert.equal(await a.get("state"), null);
    steps.set(2, (value) => ({ ...(value as object), active: true }));
    assert.deepEqual(await a.migrate("state", 2, steps), {
      count: 1,
      active: true,
    });
    await assert.rejects(a.migrate("state", 1, steps), /incompatible/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import { readHandoff, writeHandoff } from "../packages/service/src/handoff";
test("versioned service handoff rejects revision loss and preserves operation identities", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fg-handoff-"));
  try {
    await writeHandoff(directory, {
      version: 1,
      protocol: 1,
      schema: 1,
      releaseSet: "old",
      epoch: 2,
      revision: 4,
      pendingOperationIds: ["uncertain-apply"],
      at: new Date().toISOString(),
    });
    assert.deepEqual((await readHandoff(directory, 5))?.pendingOperationIds, [
      "uncertain-apply",
    ]);
    await assert.rejects(readHandoff(directory, 3), /修订丢失/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
