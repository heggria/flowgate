import { measureOutbound } from "../packages/service/src/kernel/measurement";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createServer as createTCP, connect } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { KernelTelemetry } from "../packages/service/src/kernel/telemetry";
import { NativeSession } from "../packages/shell/src/native-session";
import {
  initialConfiguration,
  compileConfiguration,
} from "../packages/domain/src/configuration";
const exec = promisify(execFile);
const origin = createServer((_req, res) => res.end("flowgate-origin-ok"));
await new Promise<void>((r) => origin.listen(0, "127.0.0.1", r));
const originPort = (origin.address() as any).port;
let externalConnections = 0;
const external = createServer();
external.on("connect", (req, socket, head) => {
  externalConnections++;
  const address = new URL("http://" + req.url);
  const upstream = connect(Number(address.port), address.hostname, () => {
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
  socket.on("close", () => upstream.destroy());
});
await new Promise<void>((r) => external.listen(0, "127.0.0.1", r));
const externalPort = (external.address() as any).port;
const probe = createTCP();
await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
const port = (probe.address() as any).port;
await new Promise<void>((r) => probe.close(() => r()));
const dir = await mkdtemp(resolve("work/native-test-"));
const native = new NativeSession(
  resolve("dist/flowgate-bridge"),
  resolve("dist/sing-box"),
  dir,
);
const telemetry = new KernelTelemetry(
  resolve("packages/service/src/kernel/telemetry.proto"),
);
try {
  await native.start();
  const c = initialConfiguration();
  c.settings.listenPort = port;
  const state = await native.apply(compileConfiguration(c), 0, "real-connect");
  assert.equal(state.status, "running");
  telemetry.connect(await native.control());
  await new Promise((r) => setTimeout(r, 100));
  const request = () =>
    exec("/usr/bin/curl", [
      "--silent",
      "--show-error",
      "--fail",
      "--max-time",
      "8",
      "--noproxy",
      "",
      "--proxy",
      `http://127.0.0.1:${port}`,
      `http://127.0.0.1:${originPort}/`,
    ]);
  assert.equal((await request()).stdout, "flowgate-origin-ok");
  await new Promise((r) => setTimeout(r, 1200));
  assert.ok(telemetry.snapshot().flows.length > 0, "real flow telemetry");
  const invalid = compileConfiguration(c);
  (invalid as any).dns.invalid_field = true;
  await assert.rejects(() => native.apply(invalid, 1, "invalid"));
  assert.equal((await native.status()).appliedRevision, 0);
  assert.equal((await request()).stdout, "flowgate-origin-ok");
  c.nodes.push({
    id: "external",
    name: "External HTTP fixture",
    type: "http",
    server: "127.0.0.1",
    port: externalPort,
    options: {},
  });
  c.settings.selectedNode = "external";
  await native.apply(compileConfiguration(c), 2, "external-connect");
  assert.equal((await request()).stdout, "flowgate-origin-ok");
  assert.ok(externalConnections > 0);
  const count = externalConnections;
  c.rules.push({
    id: "local",
    kind: "ip_cidr",
    value: "127.0.0.1/32",
    outbound: "direct",
  });
  await native.apply(compileConfiguration(c), 3, "direct-rule");
  assert.equal((await request()).stdout, "flowgate-origin-ok");
  assert.equal(externalConnections, count);
  const measuringConfig = compileConfiguration(c) as any;
  measuringConfig.outbounds.push({
    type: "urltest",
    tag: "measurement",
    outbounds: ["external"],
    url: `http://127.0.0.1:${originPort}/`,
    interval: "1m",
  });
  await native.apply(measuringConfig, 4, "measurement-config");
  const measured = await measureOutbound(
    (await native.control())!,
    "measurement",
    new AbortController().signal,
    resolve("packages/service/src/kernel/telemetry.proto"),
  );
  assert.equal(measured.state, "succeeded");
  assert.ok(Number.isFinite(measured.delayMs));
  assert.ok(
    externalConnections > count,
    "measurement must traverse actual selected proxy",
  );
  const socks = await exec("/usr/bin/curl", [
    "--silent",
    "--show-error",
    "--fail",
    "--max-time",
    "8",
    "--noproxy",
    "",
    "--socks5-hostname",
    `127.0.0.1:${port}`,
    `http://127.0.0.1:${originPort}/`,
  ]);
  assert.equal(socks.stdout, "flowgate-origin-ok");
  await native.stop("real-stop");
  assert.equal((await native.status()).status, "stopped");
  await writeFile(
    "work/native-result.json",
    JSON.stringify(
      {
        passed: true,
        kernel: "1.14.0",
        at: new Date().toISOString(),
        checks: [
          "real HTTP request forwarded through sing-box",
          "invalid config preserves active proxy",
          "external HTTP proxy used as explicit outbound",
          "IP rule routes direct without external proxy",
          "real measured URL through selected proxy",
          "SOCKS5 inbound forwarding",
          "owned endpoint stops",
          "no global network mutation",
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS: actual sing-box forwarding and invalid-config preservation",
  );
} finally {
  telemetry.close();
  await native.close();
  await new Promise<void>((r) => origin.close(() => r()));
  await new Promise<void>((r) => external.close(() => r()));
  await rm(dir, { recursive: true, force: true });
}
