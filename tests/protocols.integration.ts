import { parseSubscriptionDocument } from "../packages/extensions/src/subscriptions/index";
import { requestHttpEgress } from "../packages/runtime/src/egress";
import { createServer as createHTTPS } from "node:https";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createServer as tcpServer, connect } from "node:net";
import { createSocket } from "node:dgram";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { NativeSession } from "../packages/shell/src/native-session";
import {
  initialConfiguration,
  compileConfiguration,
} from "../packages/domain/src/configuration";
import type { NodeConfig } from "../packages/contracts/src/index";
const exec = promisify(execFile);
const directory = await mkdtemp(resolve("work/protocols-"));
let originRequests = 0;
const origin = createServer((_req, response) => {
  originRequests++;
  response.end("protocol-fixture-ok");
});
await new Promise<void>((r) => origin.listen(0, "::", r));
const originPort = (origin.address() as any).port;
const echo = createSocket("udp4");
echo.on("message", (message, remote) =>
  echo.send(message, remote.port, remote.address),
);
await new Promise<void>((r) => echo.bind(0, "127.0.0.1", r));
const dns = createSocket("udp4");
let dnsQueries = 0;
dns.on("message", (query, remote) => {
  dnsQueries++;
  let end = 12;
  while (query[end]) end += query[end] + 1;
  end += 5;
  const kind = query.readUInt16BE(end - 4),
    address =
      kind === 1
        ? Buffer.from([127, 0, 0, 1])
        : kind === 28
          ? Buffer.from("00000000000000000000000000000001", "hex")
          : null;
  const header = Buffer.from(query.subarray(0, 12));
  header.writeUInt16BE(0x8180, 2);
  header.writeUInt16BE(address ? 1 : 0, 6);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(0, 10);
  const rr = Buffer.alloc(12);
  rr.writeUInt16BE(0xc00c, 0);
  rr.writeUInt16BE(kind, 2);
  rr.writeUInt16BE(1, 4);
  rr.writeUInt32BE(0, 6);
  rr.writeUInt16BE(address?.length ?? 0, 10);
  dns.send(
    Buffer.concat([
      header,
      query.subarray(12, end),
      ...(address ? [rr, address] : []),
    ]),
    remote.port,
    remote.address,
  );
});
await new Promise<void>((r) => dns.bind(0, "127.0.0.1", r));
async function availablePort() {
  const server = tcpServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}
const certPath = join(directory, "cert.pem"),
  keyPath = join(directory, "key.pem");
await writeFile(
  join(directory, "openssl.cnf"),
  "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n",
);
await exec("/usr/bin/openssl", [
  "req",
  "-x509",
  "-newkey",
  "rsa:2048",
  "-nodes",
  "-keyout",
  keyPath,
  "-out",
  certPath,
  "-days",
  "1",
  "-config",
  join(directory, "openssl.cnf"),
]);
const certificate = await readFile(certPath, "utf8"),
  key = await readFile(keyPath, "utf8");
let tlsRequests = 0;
const tlsOrigin = createHTTPS(
  { cert: certificate, key },
  (_request, response) => {
    tlsRequests++;
    response.end("tls-egress-ok");
  },
);
await new Promise<void>((r) => tlsOrigin.listen(0, "127.0.0.1", r));
const tlsTarget = `https://localhost:${(tlsOrigin.address() as any).port}`;
const uuid = "059032a9-7d40-4a96-9bb1-36823d848068",
  password = "protocol-fixture-password";
const serverTls = { enabled: true, certificate: [certificate], key: [key] };
const tls = {
  enabled: true,
  server_name: "localhost",
  certificate: [certificate],
};
const definitions: {
  type: NodeConfig["type"];
  server: object;
  options: Record<string, unknown>;
}[] = [
  {
    type: "socks",
    server: { users: [{ username: "fixture", password }] },
    options: { username: "fixture", password },
  },
  {
    type: "shadowsocks",
    server: { method: "aes-128-gcm", password },
    options: { method: "aes-128-gcm", password },
  },
  {
    type: "vmess",
    server: { users: [{ uuid }] },
    options: { uuid, security: "auto" },
  },
  { type: "vless", server: { users: [{ uuid }] }, options: { uuid } },
  {
    type: "trojan",
    server: { users: [{ password }], tls: serverTls },
    options: { password, tls },
  },
  {
    type: "hysteria2",
    server: { users: [{ password }], tls: serverTls },
    options: { password, tls },
  },
  {
    type: "tuic",
    server: { users: [{ uuid, password }], tls: serverTls },
    options: { uuid, password, tls, congestion_control: "cubic" },
  },
];
const ports = await Promise.all(definitions.map(() => availablePort()));
const serverPath = join(directory, "server.json");
const resolver = {
  type: "udp",
  tag: "local",
  server: "127.0.0.1",
  server_port: dns.address().port,
};
await writeFile(
  serverPath,
  JSON.stringify({
    log: { level: "error" },
    dns: { servers: [resolver], final: "local", strategy: "prefer_ipv4" },
    inbounds: definitions.map((d, index) => ({
      type: d.type,
      tag: d.type,
      listen: "127.0.0.1",
      listen_port: ports[index],
      ...d.server,
    })),
    outbounds: [{ type: "direct", tag: "direct" }],
    route: { default_domain_resolver: "local", final: "direct" },
  }),
);
await exec(resolve("dist/sing-box"), ["check", "-c", serverPath]);
let server = spawn(resolve("dist/sing-box"), ["run", "-c", serverPath], {
  stdio: ["ignore", "ignore", "pipe"],
});
let stderr = "";
server.stderr.on("data", (value) => (stderr = (stderr + value).slice(-4000)));
const native = new NativeSession(
  resolve("dist/flowgate-bridge"),
  resolve("dist/sing-box"),
  join(directory, "native"),
);
const port = await availablePort();
const checks: string[] = [];
async function request(target: string) {
  return (
    await exec("/usr/bin/curl", [
      "--silent",
      "--show-error",
      "--fail",
      "--max-time",
      "8",
      "--noproxy",
      "",
      "--socks5-hostname",
      `127.0.0.1:${port}`,
      target,
    ])
  ).stdout;
}
async function udp() {
  const socket = connect(port, "127.0.0.1");
  await once(socket, "connect");
  const outgoing = createSocket("udp4");
  await new Promise<void>((r) => outgoing.bind(0, "127.0.0.1", r));
  try {
    let answer = once(socket, "data");
    socket.write(Buffer.from([5, 1, 0]));
    assert.deepEqual((await answer)[0], Buffer.from([5, 0]));
    answer = once(socket, "data");
    const associate = Buffer.from([5, 3, 0, 1, 127, 0, 0, 1, 0, 0]);
    associate.writeUInt16BE(outgoing.address().port, 8);
    socket.write(associate);
    const reply = (await answer)[0] as Buffer;
    assert.equal(reply[1], 0);
    assert.equal(reply[3], 1);
    const targetPort = reply.readUInt16BE(8),
      targetAddress = [...reply.subarray(4, 8)].join(".");
    const packet = Buffer.from([0, 0, 0, 1, 127, 0, 0, 1, 0, 0]);
    packet.writeUInt16BE(echo.address().port, 8);
    const response = once(outgoing, "message", {
      signal: AbortSignal.timeout(8000),
    });
    outgoing.send(
      Buffer.concat([packet, Buffer.from("udp-echo-ok")]),
      targetPort,
      targetAddress,
    );
    assert.equal(
      ((await response)[0] as Buffer).subarray(10).toString(),
      "udp-echo-ok",
    );
  } finally {
    outgoing.close();
    socket.destroy();
  }
}
try {
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(server.exitCode, null, stderr);
  await native.start();
  const config = initialConfiguration();
  config.settings.listenPort = port;
  config.settings.dnsServer = `udp://127.0.0.1:${dns.address().port}`;
  config.nodes = parseSubscriptionDocument(
    JSON.stringify({
      outbounds: definitions.map((d, index) => ({
        tag: d.type,
        type: d.type,
        server: "127.0.0.1",
        server_port: ports[index],
        ...d.options,
      })),
    }),
  ).nodes.map((node) => ({ ...node, id: node.type }));
  for (const definition of definitions) {
    config.settings.selectedNode = definition.type;
    config.revision++;
    await native.apply(
      compileConfiguration(config),
      config.revision,
      "protocol-" + definition.type,
    );
    assert.equal(
      await request(`http://127.0.0.1:${originPort}/`),
      "protocol-fixture-ok",
      definition.type,
    );
    assert.equal(
      await request(`http://[::1]:${originPort}/`),
      "protocol-fixture-ok",
      definition.type + " IPv6",
    );
    assert.equal(
      await request(`http://${definition.type}.flowgate.test:${originPort}/`),
      "protocol-fixture-ok",
      definition.type + " DNS",
    );
    await udp();
    checks.push(
      definition.type + ": TCP, IPv6 destination, DNS, SOCKS UDP forwarding",
    );
    console.log("PASS protocol " + definition.type);
  }
  const vmessPort = ports[definitions.findIndex((d) => d.type === "vmess")];
  const sourceFormats = [
    `proxies:\n- {name: converted, type: vmess, server: 127.0.0.1, port: ${vmessPort}, uuid: ${uuid}, cipher: auto, alterId: 0}`,
    `vmess=127.0.0.1:${vmessPort},method=auto,password=${uuid},aead=true,tag=converted`,
    `[Proxy]\nconverted=vmess,127.0.0.1,${vmessPort},auto,"${uuid}",alterId=0`,
    `[Proxy]\nconverted=vmess,127.0.0.1,${vmessPort},username=${uuid},vmess-aead=true`,
    `[Proxy]\nconverted=vmess,127.0.0.1,${vmessPort},password=${uuid},method=auto,alterId=0`,
    "vmess://" +
      Buffer.from(
        JSON.stringify({
          v: "2",
          ps: "converted",
          add: "127.0.0.1",
          port: vmessPort,
          id: uuid,
          aid: 0,
          net: "tcp",
          type: "none",
        }),
      ).toString("base64"),
  ];
  for (const source of sourceFormats) {
    const document = parseSubscriptionDocument(source);
    const node = { ...document.nodes[0], id: "converted" };
    config.nodes = config.nodes
      .filter((n) => n.id !== "converted")
      .concat(node);
    config.settings.selectedNode = node.id;
    config.revision++;
    await native.apply(
      compileConfiguration(config),
      config.revision,
      "converted-" + document.format,
    );
    assert.equal(
      await request(`http://127.0.0.1:${originPort}/`),
      "protocol-fixture-ok",
    );
    await udp();
    checks.push(
      document.format + ": converted VMess TCP and UDP reach local origin",
    );
  }
  assert.ok(dnsQueries > 0);
  config.settings.selectedNode = "socks";
  config.revision++;
  await native.apply(
    compileConfiguration(config),
    config.revision,
    "external-reconnect",
  );
  assert.equal(
    await request(`http://127.0.0.1:${originPort}/`),
    "protocol-fixture-ok",
  );
  const beforeDisconnect = originRequests;
  server.kill();
  await once(server, "exit");
  await assert.rejects(() => request(`http://127.0.0.1:${originPort}/`));
  assert.equal(
    originRequests,
    beforeDisconnect,
    "external disconnect must not fall back to direct",
  );
  server = spawn(resolve("dist/sing-box"), ["run", "-c", serverPath], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  server.stderr.on("data", (value) => (stderr = (stderr + value).slice(-4000)));
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(
    await request(`http://127.0.0.1:${originPort}/`),
    "protocol-fixture-ok",
  );
  checks.push(
    "external SOCKS stops without fallback and reconnects without configuration replacement",
  );
  config.externalNetworks = [
    {
      id: "loopback-path",
      name: "isolated interface fixture",
      interface: "lo0",
      dnsServer: `udp://127.0.0.1:${dns.address().port}`,
    },
  ];
  config.rules.push({
    id: "interface-rule",
    kind: "domain",
    value: "interface.flowgate.test",
    outbound: "loopback-path",
  });
  config.revision++;
  await native.apply(
    compileConfiguration(config),
    config.revision,
    "interface-route",
  );
  assert.equal(
    await request(`http://interface.flowgate.test:${originPort}/`),
    "protocol-fixture-ok",
  );
  checks.push(
    "domain rule and independent DNS resolver traverse explicit lo0 interface (not a VPN acceptance test)",
  );

  config.settings.selectedNode = "direct";
  config.revision++;
  await native.apply(
    compileConfiguration(config),
    config.revision,
    "configured-direct-dns",
  );
  assert.equal(
    await request(`http://direct.flowgate.test:${originPort}/`),
    "protocol-fixture-ok",
  );
  checks.push(
    "direct outbound honors configured DNS instead of bootstrap resolver",
  );
  for (const protocol of ["http", "socks5h"]) {
    const route = {
      id: "selected",
      proxyUrl: `${protocol}://127.0.0.1:${port}`,
      allowedOrigins: [tlsTarget],
      configurationRevision: config.revision,
      trustedCa: certificate,
    };
    const response = await requestHttpEgress(
      route,
      tlsTarget,
      AbortSignal.timeout(8000),
    );
    let text = "";
    for await (const chunk of response) text += chunk;
    assert.equal(text, "tls-egress-ok");
    await assert.rejects(() =>
      requestHttpEgress(
        { ...route, trustedCa: undefined },
        tlsTarget,
        AbortSignal.timeout(8000),
      ),
    );
    await assert.rejects(() =>
      requestHttpEgress(
        { ...route, allowedOrigins: [] },
        tlsTarget,
        AbortSignal.timeout(8000),
      ),
    );
    checks.push(
      protocol +
        " explicit egress: HTTPS certificate verification and scope enforcement",
    );
  }
  await native.stop("egress-stop");
  const before = tlsRequests;
  await assert.rejects(() =>
    requestHttpEgress(
      {
        id: "stopped",
        proxyUrl: `http://127.0.0.1:${port}`,
        allowedOrigins: [tlsTarget],
        configurationRevision: config.revision,
        trustedCa: certificate,
      },
      tlsTarget,
      AbortSignal.timeout(8000),
    ),
  );
  assert.equal(
    tlsRequests,
    before,
    "no direct fallback after selected proxy stops",
  );
  checks.push("proxy offline does not fall back to direct TLS");
  await writeFile(
    "work/protocols-result.json",
    JSON.stringify(
      {
        passed: true,
        at: new Date().toISOString(),
        checks,
        dnsQueries,
        scope:
          "isolated loopback protocol servers; no system DNS/routes/proxy writes",
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(stderr);
  throw error;
} finally {
  await native.close();
  server.kill();
  if (server.exitCode === null) await once(server, "exit").catch(() => {});
  await new Promise<void>((r) => tlsOrigin.close(() => r()));
  dns.close();
  echo.close();
  await new Promise<void>((r) => origin.close(() => r()));
}
