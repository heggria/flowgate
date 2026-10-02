import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import { createServer } from "node:http";
import { createServer as tcpServer } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { NativeSession } from "../packages/shell/src/native-session";
import {
  compileConfiguration,
  initialConfiguration,
} from "../packages/domain/src/configuration";
const exec = promisify(execFile),
  directory = await mkdtemp(resolve("work/dns-resolver-"));
async function fixture(host: "127.0.0.1" | "::1", expected: string) {
  const socket = createSocket(host === "::1" ? "udp6" : "udp4"),
    questions: string[] = [];
  socket.on("message", (query, remote) => {
    const labels = [];
    let end = 12;
    while (query[end]) {
      labels.push(query.subarray(end + 1, end + 1 + query[end]).toString());
      end += query[end] + 1;
    }
    end += 5;
    const name = labels.join(".");
    questions.push(name);
    const kind = query.readUInt16BE(end - 4);
    const address =
      name === expected && kind === 1 ? Buffer.from([127, 0, 0, 1]) : null;
    const header = Buffer.from(query.subarray(0, 12));
    header.writeUInt16BE(name === expected ? 0x8180 : 0x8183, 2);
    header.writeUInt16BE(address ? 1 : 0, 6);
    header.writeUInt16BE(0, 8);
    header.writeUInt16BE(0, 10);
    const rr = Buffer.alloc(12);
    rr.writeUInt16BE(0xc00c, 0);
    rr.writeUInt16BE(kind, 2);
    rr.writeUInt16BE(1, 4);
    rr.writeUInt32BE(0, 6);
    rr.writeUInt16BE(address?.length ?? 0, 10);
    socket.send(
      Buffer.concat([
        header,
        query.subarray(12, end),
        ...(address ? [rr, address] : []),
      ]),
      remote.port,
      remote.address,
    );
  });
  await new Promise<void>((r) => socket.bind(0, host, r));
  return { socket, questions, port: socket.address().port };
}
const bootstrap = await fixture("127.0.0.1", "resolver.fixture"),
  resolver = await fixture("127.0.0.1", "destination.fixture"),
  resolver6 = await fixture("::1", "destination.fixture");
const origin = createServer((_req, res) =>
  res.end("configured-resolver-forwarding"),
);
await new Promise<void>((r) => origin.listen(0, "127.0.0.1", r));
const checks = [];
try {
  for (const [name, url, queries] of [
    ["hostname", `udp://resolver.fixture:${resolver.port}`, resolver.questions],
    ["ipv6-literal", `udp://[::1]:${resolver6.port}`, resolver6.questions],
  ] as const) {
    const reservation = tcpServer();
    await new Promise<void>((r) => reservation.listen(0, "127.0.0.1", r));
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>((r) => reservation.close(() => r()));
    const config = initialConfiguration();
    config.settings.listenPort = port;
    config.settings.dnsServer = url;
    const compiled = compileConfiguration(config);
    Object.assign(compiled.dns.servers[0], {
      server: "127.0.0.1",
      server_port: bootstrap.port,
    });
    const native = new NativeSession(
      resolve("dist/flowgate-bridge"),
      resolve("dist/sing-box"),
      join(directory, name),
    );
    try {
      await native.start();
      await native.apply(compiled, 1, "dns-" + name);
      const response = await exec("/usr/bin/curl", [
        "--silent",
        "--show-error",
        "--fail",
        "--max-time",
        "8",
        "--noproxy",
        "",
        "--proxy",
        `http://127.0.0.1:${port}`,
        `http://destination.fixture:${(origin.address() as { port: number }).port}/`,
      ]);
      assert.equal(response.stdout, "configured-resolver-forwarding");
      assert.ok(queries.includes("destination.fixture"));
      if (name === "hostname")
        assert.ok(bootstrap.questions.includes("resolver.fixture"));
      checks.push(name + " DNS resolver used by actual proxy forwarding");
    } finally {
      await native.close();
    }
  }
  const c = initialConfiguration();
  c.settings.dnsServer = "https://dns.example.com/dns-query?profile=fixture";
  c.externalNetworks = [
    {
      id: "fixture-net",
      name: "Fixture",
      interface: "lo0",
      dnsServer: "https://private.example.com/dns-query?profile=other",
    },
  ];
  const compiled = compileConfiguration(c);
  assert.equal(
    (compiled.dns.servers[1] as { path: string }).path,
    "/dns-query?profile=fixture",
  );
  assert.equal(
    (compiled.dns.servers[2] as { path: string }).path,
    "/dns-query?profile=other",
  );
  await writeFile(join(directory, "doh.json"), JSON.stringify(compiled));
  await exec(resolve("dist/sing-box"), [
    "check",
    "-c",
    join(directory, "doh.json"),
  ]);
  checks.push(
    "hostname DoH and external-network resolver accepted by actual kernel; query retained",
  );
  console.log("PASS DNS:", checks);
} finally {
  bootstrap.socket.close();
  resolver.socket.close();
  resolver6.socket.close();
  await new Promise<void>((r) => origin.close(() => r()));
}
