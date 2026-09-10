import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSubscriptionDocument } from "../packages/extensions/src/subscriptions/index";
import { parseSubscription } from "../packages/extensions/src/parser";
import {
  splitFields,
  assignment,
} from "../packages/extensions/src/subscriptions/tokenizer";
import { SubscriptionWorkers } from "../packages/extensions/src/subscriptions/worker-host";
import {
  subscriptionMetadata,
  fetchSubscription,
} from "../packages/extensions/src/subscriptions/fetch";
import {
  SubscriptionService,
  preserveNodeIdentity,
} from "../packages/service/src/subscriptions";
import { SubscriptionRefresh } from "../packages/service/src/subscription-refresh";
import { StateStore } from "../packages/service/src/store";
import { validateRelease } from "../packages/release/src/loader";
import {
  initialConfiguration,
  compileConfiguration,
  validateConfiguration,
} from "../packages/domain/src/configuration";
import type {
  Configuration,
  NodeConfig,
  Subscription,
} from "../packages/contracts/src/index";
import type {
  SubscriptionDocument,
  SubscriptionParseOptions,
} from "../packages/contracts/src/subscriptions";

const uuid = "23456789-abcd-4123-8123-123456789abc";
const encoded = (value: unknown) =>
  Buffer.from(
    typeof value === "string" ? value : JSON.stringify(value),
  ).toString("base64");
const vmess = (name = "test", extra: Record<string, unknown> = {}) =>
  "vmess://" +
  encoded({
    v: "2",
    ps: name,
    add: "proxy.example",
    port: 443,
    id: uuid,
    aid: 0,
    net: "tcp",
    type: "none",
    ...extra,
  });
const http = (name = "test", extra = {}) =>
  JSON.stringify([
    {
      type: "http",
      tag: name,
      server: "proxy.example",
      server_port: 8080,
      ...extra,
    },
  ]);
const parse = (text: string, options?: SubscriptionParseOptions) =>
  parseSubscriptionDocument(text, options);
const extension = async (method: string, payload: any) => {
  assert.equal(method, "subscription.parse");
  return parse(payload.text, payload.options);
};

test("registry detects all supported source families and preserves the VMess handshake contract", () => {
  const fixtures = [
    [
      "sing-box",
      JSON.stringify({
        outbounds: [
          {
            type: "vmess",
            tag: "A",
            server: "proxy.example",
            server_port: 443,
            uuid,
            security: "auto",
            alter_id: 0,
          },
        ],
      }),
      0,
    ],
    [
      "clash",
      `proxies:\n  - {name: A, type: vmess, server: proxy.example, port: 443, uuid: ${uuid}, cipher: auto, alterId: 0}`,
      0,
    ],
    ["uri", encoded(vmess()), 0],
    [
      "quantumult-x",
      `vmess=proxy.example:443, method=auto, password=${uuid}, tag=A, aead=true`,
      0,
    ],
    ["loon", `[Proxy]\nA=vmess,proxy.example,443,auto,"${uuid}",alterId=0`, 0],
    ["surge", `[Proxy]\nA=vmess,proxy.example,443,username=${uuid}`, 1],
    [
      "shadowrocket",
      `[Proxy]\nA=vmess,proxy.example,443,password=${uuid},method=auto,alterId=0`,
      0,
    ],
  ] as const;
  for (const [format, input, alterId] of fixtures) {
    const result = parse(input);
    assert.equal(result.format, format);
    assert.equal(result.nodes.length, 1);
    assert.equal(result.rejected, 0);
    assert.equal(result.nodes[0].options.alter_id, alterId);
  }
  const surge = fixtures[5][1];
  assert.ok(
    parse(surge).diagnostics.some((d) => d.code === "AEAD_SOURCE_DEFAULT"),
  );
  const override = parse(surge, { vmessAead: "enabled" });
  assert.equal(override.nodes[0].options.alter_id, 0);
  assert.ok(
    !override.diagnostics.some((d) => d.code === "AEAD_SOURCE_DEFAULT"),
  );
  const sip008 = parse(
    JSON.stringify({
      version: 1,
      servers: [
        {
          id: "x",
          remarks: "SS",
          server: "proxy.example",
          server_port: 443,
          method: "aes-128-gcm",
          password: "test",
        },
      ],
    }),
  );
  assert.equal(sip008.format, "sip008");
  assert.equal(sip008.nodes[0].type, "shadowsocks");
});

test("URI adapters preserve TLS, Reality, ALPN, transport, plugins and TUIC credentials", () => {
  const reality = parse(
    `vless://${uuid}@proxy.example:443?security=reality&pbk=test-public-key&sid=ab12&fp=chrome&sni=front.example&type=grpc&serviceName=rpc#VLESS`,
  ).nodes[0];
  assert.deepEqual(reality.options.tls, {
    enabled: true,
    server_name: "front.example",
    utls: { enabled: true, fingerprint: "chrome" },
    reality: { enabled: true, public_key: "test-public-key", short_id: "ab12" },
  });
  assert.deepEqual(reality.options.transport, {
    type: "grpc",
    service_name: "rpc",
  });
  const trojan = parse(
    "trojan://test@proxy.example:443?sni=front.example&allowInsecure=1&alpn=h2%2Chttp%2F1.1&type=ws&path=%2Fsocket&host=ws.example#trojan",
  );
  assert.deepEqual(trojan.nodes[0].options.transport, {
    type: "ws",
    path: "/socket",
    headers: { Host: "ws.example" },
  });
  assert.equal((trojan.nodes[0].options.tls as any).insecure, true);
  assert.deepEqual((trojan.nodes[0].options.tls as any).alpn, [
    "h2",
    "http/1.1",
  ]);
  assert.ok(trojan.diagnostics.some((d) => d.code === "TLS_INSECURE"));
  const ss = parse(
    `ss://${encoded("aes-128-gcm:test")}@proxy.example:443?plugin=obfs-local%3Bobfs%3Dhttp%3Bobfs-host%3Dfront.example#SS`,
  ).nodes[0];
  assert.equal(ss.options.plugin, "obfs-local");
  assert.equal(ss.options.plugin_opts, "obfs=http;obfs-host=front.example");
  assert.equal(
    parse(`ss://${encoded("aes-128-gcm:test@proxy.example:443")}#legacy`)
      .nodes[0].options.password,
    "test",
  );
  const tuic = parse(
    `tuic://${uuid}:secret@proxy.example:443?congestion_control=bbr&udp_relay_mode=native&alpn=h3`,
  ).nodes[0];
  assert.equal(tuic.options.uuid, uuid);
  assert.equal(tuic.options.password, "secret");
  assert.equal(tuic.options.congestion_control, "bbr");
  const hy2 = parse(
    "hy2://test@proxy.example:443?obfs=salamander&obfs-password=obfs-secret&upmbps=100",
  ).nodes[0];
  assert.equal(hy2.type, "hysteria2");
  assert.deepEqual(hy2.options.obfs, {
    type: "salamander",
    password: "obfs-secret",
  });
});

test("Clash conversion retains TLS and protocol options rather than forwarding foreign fields", () => {
  const input = `proxies:\n- name: TLS\n  type: vmess\n  server: proxy.example\n  port: 443\n  uuid: ${uuid}\n  cipher: auto\n  alterId: 0\n  tls: true\n  skip-cert-verify: true\n  servername: front.example\n  alpn: [h2]\n  network: ws\n  ws-opts:\n    path: /stream\n    headers: {Host: front.example}\n    max-early-data: 2048\n`;
  const document = parse(input);
  const options = document.nodes[0].options;
  assert.equal((options.tls as any).insecure, true);
  assert.equal((options.tls as any).server_name, "front.example");
  assert.equal((options.transport as any).max_early_data, 2048);
  assert.equal(options.alter_id, 0);
  assert.equal(options.cipher, undefined);
  const configuration = initialConfiguration();
  configuration.nodes = document.nodes;
  const compiled = compileConfiguration(configuration).outbounds.find(
    (o) => o.tag === document.nodes[0].id,
  ) as any;
  assert.equal(compiled.tls.insecure, true);
  assert.equal(compiled.transport.max_early_data, 2048);
});

test("quoted separators, IPv6, duplicate options and malformed data have deterministic safe outcomes", () => {
  assert.deepEqual(splitFields('one,"two,three",[::1],four'), [
    "one",
    '"two,three"',
    "[::1]",
    "four",
  ]);
  assert.deepEqual(assignment('key="value=other"'), ["key", '"value=other"']);
  const node = parse(
    `vmess=[2001:db8::1]:443,method=auto,password=${uuid},tag="A, B"`,
  ).nodes[0];
  assert.equal(node.server, "2001:db8::1");
  assert.equal(node.name, "A, B");
  const invalid = [
    "<html>secret-token</html>",
    "%%%secret-token%%%",
    `vmess://not-base64-secret-token`,
    `proxies:\n- {name: A, name: B}`,
    `[Proxy]\nA=vmess,proxy.example,443,username=${uuid},username=secret-token`,
  ];
  for (const input of invalid)
    assert.throws(
      () => parse(input),
      (error) =>
        error instanceof Error && !error.message.includes("secret-token"),
    );
  const partial = parse(
    vmess("valid") +
      "\n" +
      vmess("unsupported", { net: "kcp", path: "secret-token" }),
  );
  assert.equal(partial.nodes.length, 1);
  assert.equal(partial.rejected, 1);
  assert.ok(!JSON.stringify(partial.diagnostics).includes("secret-token"));
  assert.throws(
    () =>
      parseSubscription(vmess() + "\n" + vmess("unsupported", { net: "kcp" })),
    /预览/,
  );
});

test("information entries are explicit and large single-line base64 subscriptions remain bounded by decoded lines", () => {
  const rows = [
    vmess("剩余流量：5GB"),
    vmess("usable", {
      remark: "usable",
      alterId: 0,
      headerType: "none",
      service_name: "",
      verify_cert: true,
      class: 1,
      group: "test",
      ratio: 1,
      is_soga: true,
      soga_node_id: 1,
    }),
  ];
  assert.equal(parse(rows.join("\n")).nodes.length, 2);
  const filtered = parse(rows.join("\n"), { excludeInformation: true });
  assert.equal(filtered.nodes.length, 1);
  assert.equal(filtered.informationEntries, 1);
  assert.ok(filtered.diagnostics.some((d) => d.code === "INFORMATION_ENTRY"));
  const large = encoded(
    Array.from({ length: 400 }, (_, i) => vmess("node-" + i)).join("\n"),
  );
  assert.ok(large.length > 65536);
  assert.equal(parse(large).nodes.length, 400);
  assert.throws(() => parse("x".repeat(4 * 1024 * 1024 + 1)), /4 MB/);
});

test("preview is read-only, strips credentials and commits exactly the reviewed version once", async () => {
  let configuration = initialConfiguration();
  const service = new SubscriptionService(() => configuration, extension);
  const preview = await service.preview({
    text: http("test", { username: "alice", password: "private-password" }),
  });
  assert.equal(configuration.nodes.length, 0);
  assert.ok(!JSON.stringify(preview).includes("private-password"));
  configuration = service.commit(preview.id, false);
  configuration.revision++;
  assert.equal(configuration.nodes[0].options.password, "private-password");
  assert.equal(configuration.subscriptions[0].refreshHours, 0);
  assert.throws(() => service.commit(preview.id, false), /过期/);
  const stale = await service.preview({ text: http("other") });
  configuration.revision++;
  assert.throws(() => service.commit(stale.id, false), /配置已变化/);
});

test("preview detects concurrent edits during fetching and cancels pending conversion on pause", async () => {
  const configuration = initialConfiguration();
  let release!: (result: unknown) => void;
  const service = new SubscriptionService(
    () => configuration,
    async (method, payload: any, signal) => {
      if (method === "subscription.fetch")
        return new Promise((resolve, reject) => {
          release = resolve;
          signal?.addEventListener(
            "abort",
            () => reject(new Error("cancelled")),
            { once: true },
          );
        });
      return extension(method, payload);
    },
  );
  const pending = service.preview({ url: "https://example.com/sub" });
  configuration.revision++;
  release({ version: 2, status: "ok", text: http(), metadata: {} });
  await assert.rejects(pending, /配置已变化/);
  const canceled = service.preview({ url: "https://example.com/sub" });
  service.pause();
  await assert.rejects(canceled, /cancelled/);
  service.resume();
  const preview = await service.preview({ text: http() });
  assert.equal(preview.nodes.length, 1);
});

test("refresh keeps source identity through endpoint rotation and fences missing active references", async () => {
  let configuration = initialConfiguration(),
    body = http("stable"),
    calls: any[] = [];
  const service = new SubscriptionService(
    () => configuration,
    async (method, payload: any) => {
      calls.push(payload);
      return method === "subscription.fetch"
        ? {
            version: 2,
            status: "ok",
            text: body,
            metadata: { total: 100 },
            etag: '"v1"',
          }
        : extension(method, payload);
    },
  );
  const first = await service.preview({ url: "https://example.com/sub" });
  configuration = service.commit(first.id, false);
  configuration.revision++;
  const id = configuration.nodes[0].id,
    sourceId = configuration.subscriptions[0].id;
  configuration.settings.selectedNode = id;
  configuration.rules.push({
    id: "rule",
    kind: "domain",
    value: "example.com",
    outbound: id,
  });
  body = http("stable", {
    server: "rotated.example",
    password: "new-password",
  });
  const update = await service.preview({ id: sourceId });
  assert.equal(update.nodes[0].id, id);
  assert.equal(update.changes.updated, 1);
  configuration = service.commit(update.id, true, sourceId);
  configuration.revision++;
  body = http("replacement");
  const missing = await service.preview({ id: sourceId });
  assert.equal(missing.canCommit, false);
  assert.equal(configuration.nodes[0].server, "rotated.example");
  assert.throws(
    () => service.commit(missing.id, true, sourceId, true),
    /未解决/,
  );
  assert.ok(calls.some((payload) => payload.etag === '"v1"'));
});

test("conditional refresh retains last-good nodes and metadata; changing parse options bypasses validators", async () => {
  let configuration = initialConfiguration(),
    notModified = false,
    seen: any;
  const service = new SubscriptionService(
    () => configuration,
    async (method, payload: any) => {
      if (method === "subscription.parse") return extension(method, payload);
      seen = payload;
      return notModified
        ? { version: 2, status: "not-modified", metadata: { download: 50 } }
        : {
            version: 2,
            status: "ok",
            text: http(),
            metadata: { total: 100 },
            etag: '"v1"',
          };
    },
  );
  const first = await service.preview({ url: "https://example.com/sub" });
  configuration = service.commit(first.id, false);
  configuration.revision++;
  notModified = true;
  const unchanged = await service.preview({
    id: configuration.subscriptions[0].id,
  });
  assert.equal(unchanged.unchanged, true);
  assert.equal(unchanged.metadata.total, 100);
  assert.equal(unchanged.metadata.download, 50);
  assert.equal(unchanged.changes.unchanged, 1);
  const concurrent = await service.preview({
    id: configuration.subscriptions[0].id,
  });
  assert.equal(service.metadataOnly(unchanged.id), true);
  const revision = configuration.revision;
  configuration = service.commit(
    unchanged.id,
    true,
    configuration.subscriptions[0].id,
  );
  assert.equal(configuration.revision, revision);
  assert.throws(
    () =>
      service.commit(concurrent.id, true, configuration.subscriptions[0].id),
    /配置已变化/,
  );
  notModified = false;
  await service.preview({
    id: configuration.subscriptions[0].id,
    options: { vmessAead: "enabled" },
  });
  assert.equal(seen.etag, undefined);
  configuration.subscriptions[0].conversion!.parserVersion = "1.0.0";
  notModified = true;
  await assert.rejects(
    service.preview({ id: configuration.subscriptions[0].id }),
    /缓存缺失/,
  );
  assert.equal(seen.etag, undefined);
});

test("partial nodes require explicit selection and review; unsupported full profiles cannot partially overwrite routing", async () => {
  const configuration = initialConfiguration();
  const service = new SubscriptionService(() => configuration, extension);
  const input = vmess() + "\n" + vmess("unsupported", { net: "kcp" });
  const blocked = await service.preview({ text: input });
  assert.equal(blocked.canCommit, false);
  const partial = await service.preview({ text: input, acceptRejected: true });
  assert.equal(partial.canCommit, true);
  assert.throws(() => service.commit(partial.id, false), /查看转换提示/);
  assert.equal(
    service.commit(partial.id, false, undefined, true).nodes.length,
    1,
  );
  const source = `proxies:\n- {name: A, type: http, server: proxy.example, port: 8080}\nrules:\n- GEOIP,CN,DIRECT\n- MATCH,A\n`;
  const nodesOnly = await service.preview({ text: source });
  assert.equal(nodesOnly.canCommit, true);
  assert.equal(nodesOnly.profile.supported, false);
  const full = await service.preview({ text: source, migration: "profile" });
  assert.equal(full.canCommit, false);
  assert.equal(configuration.rules.length, 0);
});

test("supported full profiles compile strategy references, domain keyword rules and DNS atomically", async () => {
  const configuration = initialConfiguration();
  const service = new SubscriptionService(() => configuration, extension);
  const input = `proxies:\n- {name: A, type: http, server: proxy.example, port: 8080}\nproxy-groups:\n- {name: Pick, type: select, proxies: [A, DIRECT]}\n- {name: Probe, type: url-test, proxies: [A], url: 'https://example.com/check', interval: 300}\nrules:\n- DOMAIN-KEYWORD,example,Pick\n- MATCH,Probe\ndns:\n  enable: true\n  nameserver: ['https://1.1.1.1/dns-query']\n`;
  const preview = await service.preview({ text: input, migration: "profile" });
  assert.equal(preview.profile.supported, true);
  assert.equal(preview.canCommit, true);
  const next = service.commit(preview.id, false, undefined, true);
  assert.equal(next.groups?.length, 2);
  assert.equal(next.rules[0].kind, "domain_keyword");
  const compiled = compileConfiguration(next);
  assert.equal(compiled.route.final, next.groups![1].id);
  assert.equal(
    (compiled.outbounds.find((o) => o.tag === next.groups![1].id) as any)
      .interval,
    "300s",
  );
  assert.equal(next.settings.mode, "manual");
  next.groups![0].members = [next.groups![1].id];
  next.groups![1].members = [next.groups![0].id];
  assert.throws(() => validateConfiguration(next), /循环/);
});

test("duplicate node identities consume previous IDs only once", () => {
  const old: NodeConfig[] = [1, 2].map((port) => ({
    id: "old-" + port,
    name: "same",
    type: "http",
    server: "proxy.example",
    port,
    options: {},
  }));
  const next = preserveNodeIdentity(
    [...old, { ...old[0], port: 3 }],
    old,
    "source",
  );
  assert.equal(next[0].id, old[0].id);
  assert.equal(next[1].id, old[1].id);
  assert.equal(new Set(next.map((n) => n.id)).size, 3);
});

test("fetch metadata is bounded and HTTP failures never expose subscription credentials", async () => {
  assert.deepEqual(
    subscriptionMetadata(
      new Headers({
        "subscription-userinfo":
          "upload=1; download=2; total=100; expire=1800000000; ignored=secret",
        "profile-update-interval": "12",
      }),
    ),
    {
      upload: 1,
      download: 2,
      total: 100,
      expire: 1800000000,
      updateIntervalHours: 12,
    },
  );
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response(null, { status: 304, headers: { etag: '"v1"' } });
    const cached = await fetchSubscription(
      { url: "https://example.com/sub?token=secret", version: 2, etag: '"v1"' },
      new AbortController().signal,
    );
    assert.equal((cached as any).status, "not-modified");
    globalThis.fetch = async () => {
      throw new Error("https://example.com/sub?token=secret");
    };
    await assert.rejects(
      fetchSubscription(
        { url: "https://example.com/sub?token=secret", version: 2 },
        new AbortController().signal,
      ),
      (error) => error instanceof Error && !error.message.includes("secret"),
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("worker supervision enforces concurrency, cancellation, deadlines and disposal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "flowgate-parser-test-"));
  const filename = join(directory, "worker.cjs");
  await writeFile(filename, `while (true) {}`);
  const workers = new SubscriptionWorkers(filename, 100);
  try {
    const controller = new AbortController();
    const canceled = workers.parse("x", {}, controller.signal);
    const timedOut = workers.parse("x", {}, new AbortController().signal);
    await assert.rejects(
      workers.parse("x", {}, new AbortController().signal),
      /正在解析/,
    );
    controller.abort();
    await assert.rejects(canceled, /取消/);
    await assert.rejects(timedOut, /超时/);
    await workers.dispose();
    await assert.rejects(
      workers.parse("x", {}, new AbortController().signal),
      /取消/,
    );
  } finally {
    await workers.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("automatic refresh is opt-in, coalesces runs and stops before the next source on suspend", async () => {
  const sources: Subscription[] = ["a", "b", "disabled"].map((id) => ({
    id,
    name: id,
    url: "https://example.com/" + id,
    count: 1,
    refreshHours: id === "disabled" ? 0 : 1,
    updatedAt: new Date(0).toISOString(),
  }));
  let release!: () => void;
  const calls: string[] = [];
  const refresh = new SubscriptionRefresh(
    () => sources,
    async (id, signal) => {
      calls.push(id);
      await new Promise<void>((resolve) => {
        release = resolve;
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
    () => 7200000,
  );
  refresh.start();
  const first = refresh.tick();
  const second = refresh.tick();
  assert.equal(first, second);
  assert.deepEqual(calls, ["a"]);
  refresh.stop();
  release();
  await first;
  assert.deepEqual(calls, ["a"]);
  refresh.start();
  const next = refresh.tick();
  assert.deepEqual(calls, ["a", "b"]);
  release();
  await next;
  await refresh.drain();
});

test("schema migration backs up old state only for the writer and never enables old ignored options", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "flowgate-subscription-migrate-"),
  );
  const configuration = initialConfiguration();
  configuration.schema = 1;
  configuration.nodes.push({
    id: "old",
    name: "old",
    type: "shadowsocks",
    server: "proxy.example",
    port: 443,
    options: {
      method: "aes-128-gcm",
      password: "test",
      plugin: "obfs-local",
      plugin_opts: "obfs=http",
    },
  });
  const original = { configuration, operations: [] };
  await writeFile(join(directory, "state.json"), JSON.stringify(original), {
    mode: 0o600,
  });
  const preflight = new StateStore(directory, 1),
    writer = new StateStore(directory, 2);
  try {
    await preflight.start(true);
    assert.equal(preflight.configuration.schema, 2);
    assert.equal(
      JSON.parse(await readFile(join(directory, "state.json"), "utf8"))
        .configuration.schema,
      1,
    );
    await assert.rejects(stat(join(directory, "state-before-schema-2.json")), {
      code: "ENOENT",
    });
    await preflight.close();
    await writer.start();
    await writer.persist();
    assert.equal(
      JSON.parse(await readFile(join(directory, "state.json"), "utf8"))
        .configuration.schema,
      2,
    );
    assert.deepEqual(
      JSON.parse(
        await readFile(join(directory, "state-before-schema-2.json"), "utf8"),
      ),
      original,
    );
    assert.equal(
      (await stat(join(directory, "state-before-schema-2.json"))).mode & 0o777,
      0o600,
    );
    const outbound = compileConfiguration(writer.configuration).outbounds.find(
      (node) => node.tag === "old",
    ) as any;
    assert.equal(
      outbound.plugin,
      undefined,
      "a formerly ignored option stays inactive until reimported and validated",
    );
  } finally {
    await preflight.close();
    await writer.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("old release API/schema cannot be installed over the new configuration model", () => {
  const manifest: any = {
    id: "old",
    version: 1,
    channel: "stable",
    shellApi: { min: 1, max: 1 },
    protocol: 1,
    schema: { min: 1, max: 1 },
    ui: "entry.js",
    service: "entry.js",
    extension: "entry.js",
    builtins: [],
    files: { "entry.js": { size: 0, sha256: "0".repeat(64) } },
  };
  assert.throws(() => validateRelease(manifest), /版本不兼容/);
});

test("profile parse errors stay separate from nodes and executable plugin options are rejected", () => {
  const malformed = parse(
    "proxies:\n- {name: A, type: http, server: proxy.example, port: 8080}\nproxy-groups: invalid\n",
  );
  assert.equal(malformed.nodes.length, 1);
  assert.ok(malformed.diagnostics.some((d) => d.code === "INVALID_PROFILE"));
  const source = `proxies:\n- {name: A, type: vmess, server: proxy.example, port: 443, uuid: ${uuid}, udp: false, tfo: true}\n`;
  const converted = parse(source).nodes[0];
  assert.equal(converted.options.network, "tcp");
  assert.equal(converted.options.tcp_fast_open, true);
  assert.throws(() =>
    parse(
      `ss://${encoded("aes-128-gcm:test")}@proxy.example:443?plugin=v2ray-plugin%3Bcert%3D%2Fprivate%2Fsecret`,
    ),
  );
  assert.throws(() => parse(http("invalid", { uuid })));
  const surge = parse(
    `[Proxy]\nA=vmess,proxy.example,443,username=${uuid},vmess-aead=true,ws=true,ws-headers="Host:front.example"`,
  ).nodes[0];
  assert.deepEqual(
    { ...(surge.options.transport as any).headers },
    { Host: "front.example" },
  );
});
