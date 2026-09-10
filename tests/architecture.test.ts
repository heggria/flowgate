import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  initialConfiguration,
  compileConfiguration,
} from "../packages/domain/src/configuration";
import { StateStore } from "../packages/service/src/store";
import { ServiceCore } from "../packages/service/src/core";
import { ModuleRuntime } from "../packages/runtime/src/lifecycle";
import {
  verifyDirectory,
  validateRelease,
} from "../packages/release/src/loader";
import type { ReleaseSet } from "../packages/contracts/src/index";
import { parseSubscription } from "../packages/extensions/src/parser";
import {
  MockGateway,
  UsageLedger,
  CredentialScope,
} from "../packages/gateway-test/src/gateway";
test("configuration compiler routes block using reject and refuses unknown outbound", () => {
  const c = initialConfiguration();
  c.rules.push({
    id: "r",
    kind: "domain",
    value: "example.com",
    outbound: "block",
  });
  assert.equal(compileConfiguration(c).route.rules.at(-1)?.action, "reject");
  c.settings.selectedNode = "missing";
  assert.throws(() => compileConfiguration(c));
});
test("single writer, durable data and serialized transactions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "flowgate-"));
  try {
    const a = new StateStore(dir, 1);
    await a.start();
    const b = new StateStore(dir, 2);
    await assert.rejects(() => b.start());
    await Promise.all(
      Array.from({ length: 10 }, () =>
        a.transact(async () => {
          a.configuration.revision++;
          await a.persist();
        }),
      ),
    );
    await a.close();
    await b.start();
    assert.equal(b.configuration.revision, 10);
    await b.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("idempotency prevents duplicate native apply and drain waits for active transaction", async () => {
  const dir = await mkdtemp(join(tmpdir(), "flowgate-"));
  let count = 0;
  let unlock!: () => void;
  const gate = new Promise<void>((r) => (unlock = r));
  const core = new ServiceCore(
    new StateStore(dir, 1),
    {
      status: async () => ({ status: "stopped", systemControl: false }),
      apply: async () => {
        count++;
        await gate;
        return { status: "running", systemControl: false };
      },
      stop: async () => ({ status: "stopped", systemControl: false }),
    },
    async () => {},
    "test",
  );
  try {
    await core.start();
    const first = core.request("proxy.connect", {}, "op");
    await new Promise((r) => setTimeout(r, 20));
    let drained = false;
    const drain = core.drain().then(() => (drained = true));
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(drained, false);
    unlock();
    await first;
    await drain;
    assert.equal(count, 1);
    await assert.rejects(() => core.request("proxy.connect", {}, "op2"));
    await core.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("module activation is atomic and disposes failed contributions", async () => {
  const runtime = new ModuleRuntime();
  let disposed = 0;
  const manifest = {
    id: "a",
    version: "1",
    api: 1 as const,
    dependencies: [],
    capabilities: [],
  };
  await assert.rejects(() =>
    runtime.activate([
      {
        manifest,
        async activate(ctx) {
          ctx.contribute({ id: "x", kind: "route", value: 1 });
          ctx.defer(() => {
            disposed++;
          });
          throw new Error("fail");
        },
      },
    ]),
  );
  assert.equal(runtime.entries.length, 0);
  assert.equal(disposed, 1);
  await assert.rejects(() =>
    runtime.activate([
      { manifest: { ...manifest, dependencies: ["a"] }, async activate() {} },
    ]),
  );
});
test("release rejects tampering, missing/extra files, traversal, links and incompatible API", async () => {
  const dir = await mkdtemp(join(tmpdir(), "flowgate-release-"));
  const bytes = "export {}";
  const m: ReleaseSet = {
    id: "v1",
    version: 1,
    channel: "stable",
    shellApi: { min: 2, max: 2 },
    protocol: 1,
    schema: { min: 2, max: 2 },
    ui: "ui.js",
    service: "ui.js",
    extension: "ui.js",
    builtins: [],
    files: {
      "ui.js": {
        size: Buffer.byteLength(bytes),
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    },
  };
  try {
    await writeFile(join(dir, "ui.js"), bytes);
    await verifyDirectory(dir, m);
    await writeFile(join(dir, "extra.js"), "");
    await assert.rejects(() => verifyDirectory(dir, m));
    await rm(join(dir, "extra.js"));
    await writeFile(join(dir, "ui.js"), "tampered");
    await assert.rejects(() => verifyDirectory(dir, m));
    await rm(join(dir, "ui.js"));
    await symlink("/etc/hosts", join(dir, "ui.js"));
    await assert.rejects(() => verifyDirectory(dir, m));
    assert.throws(() =>
      validateRelease({ ...m, shellApi: { min: 3, max: 3 } }),
    );
    assert.throws(() =>
      validateRelease({ ...m, files: { "../bad.js": m.files["ui.js"] } }),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("subscription import supports JSON and rejects unsafe types", () => {
  assert.equal(
    parseSubscription(
      '{"outbounds":[{"type":"socks","tag":"local","server":"127.0.0.1","server_port":1080}]}',
    )[0].port,
    1080,
  );
  assert.throws(() =>
    parseSubscription('[{"type":"exec","server":"x","port":80}]'),
  );
});
test("gateway holds unknown usage budget and enforces credential scope", () => {
  const ledger = new UsageLedger(10);
  ledger.reserve("a", 8);
  assert.throws(() => ledger.reserve("b", 3));
  ledger.settle("a");
  assert.equal(ledger.snapshot()[0].state, "unknown");
  assert.throws(() => ledger.reserve("c", 3));
  const vault = new CredentialScope(new Set(["provider.a"]));
  vault.put("provider.a", "secret");
  assert.throws(() => vault.use("provider.b", () => {}));
  assert.equal(
    vault.use("provider.a", (v) => v.length),
    6,
  );
});
test("gateway authenticates, preserves tool deltas and drains streams without replay", async () => {
  const g = new MockGateway("model-token", {
    id: "explicit",
    resolve: async () => ({ id: "explicit" }),
  });
  await g.prepare(new AbortController().signal);
  await g.start();
  try {
    const url = `http://127.0.0.1:${g.port}/v1/mock`;
    assert.equal((await fetch(url, { method: "POST" })).status, 401);
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization: "Bearer model-token" },
    });
    assert.equal(response.headers.get("x-config-revision"), "1");
    const draining = g.drain(Date.now() + 1000);
    const body = await response.text();
    await draining;
    assert.match(body, /tool.delta/);
    assert.match(body, /mock_upstream_error/);
    assert.equal(g.ledger.snapshot()[0].state, "unknown");
    assert.ok(g.maxBuffered < 65536);
    assert.equal(
      (
        await fetch(url, {
          method: "POST",
          headers: { authorization: "Bearer model-token" },
        })
      ).status,
      503,
    );
  } finally {
    await g.stop();
  }
});

test("gateway propagates client cancellation and releases active stream", async () => {
  const g = new MockGateway("cancel-token", {
    id: "explicit",
    resolve: async () => ({ id: "explicit" }),
  });
  await g.start();
  try {
    const response = await fetch(`http://127.0.0.1:${g.port}/v1/mock`, {
      method: "POST",
      headers: { authorization: "Bearer cancel-token" },
    });
    await response.body!.cancel();
    await new Promise((r) => setTimeout(r, 35));
    await g.drain(Date.now() + 500);
    assert.equal(g.cancelled, 1);
    assert.equal(g.ledger.snapshot()[0].state, "unknown");
  } finally {
    await g.stop();
  }
});

test("slow gateway client reaches backpressure without unbounded buffers", async () => {
  const { connect } = await import("node:net");
  const g = new MockGateway(
    "slow-token",
    { id: "explicit", resolve: async () => ({ id: "explicit" }) },
    1,
    8192,
  );
  await g.start();
  const socket = connect(g.port, "127.0.0.1");
  try {
    await new Promise<void>((r) => socket.once("connect", r));
    socket.write(
      "POST /v1/mock HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer slow-token\r\nContent-Length: 0\r\n\r\n",
    );
    socket.pause();
    const deadline = Date.now() + 3000;
    while (!g.backpressureWaits && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 20));
    assert.ok(g.backpressureWaits > 0);
    assert.ok(g.maxBuffered < 131072);
    socket.destroy();
    await g.drain(Date.now() + 1000);
    assert.equal(g.cancelled, 1);
  } finally {
    socket.destroy();
    await g.stop();
  }
});
