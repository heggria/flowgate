// Deliberately delayed local listeners test the native startup contract only.
// Real sing-box forwarding remains covered by native/protocol integration tests.
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createServer, connect } from "node:net";
import { once } from "node:events";
import { NativeSession } from "../packages/shell/src/native-session";
import {
  compileConfiguration,
  initialConfiguration,
} from "../packages/domain/src/configuration";
const directory = await mkdtemp(resolve("work/native-readiness-"));
const probe = createServer();
await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
const port = (probe.address() as { port: number }).port;
await new Promise<void>((r) => probe.close(() => r()));
const config = initialConfiguration();
config.settings.listenPort = port;
const results = [];
for (const neverReady of [false, true]) {
  const path = join(directory, neverReady ? "never-ready.cjs" : "delayed.cjs");
  await writeFile(
    path,
    `#!${process.execPath}
const fs = require("node:fs"), net = require("node:net");
if (process.argv[2] === "check") process.exit(0);
const config = JSON.parse(fs.readFileSync(process.argv[4], "utf8"));
setInterval(() => {}, 1000);
setTimeout(() => net.createServer(socket => socket.end()).listen(config.services[0].listen_port, "127.0.0.1"), 100);
${neverReady ? "" : 'setTimeout(() => net.createServer(socket => socket.end()).listen(config.inbounds[0].listen_port, "127.0.0.1"), 900);'}
`,
  );
  await chmod(path, 0o700);
  const native = new NativeSession(
    resolve("dist/flowgate-bridge"),
    path,
    join(directory, neverReady ? "never-state" : "delayed-state"),
  );
  try {
    await native.start();
    const started = performance.now();
    const applying = native.apply(
      compileConfiguration(config),
      1,
      "readiness-fixture",
    );
    if (neverReady) {
      await assert.rejects(applying, /本地监听尚未就绪/);
      assert.notEqual((await native.status()).status, "running");
      assert.ok(
        performance.now() - started < 8000,
        "startup rejection is bounded",
      );
      results.push(
        "control listener alone cannot report successful startup; unready kernel is stopped",
      );
    } else {
      const state = await applying;
      assert.equal(state.status, "running");
      assert.ok(
        performance.now() - started >= 850,
        "apply waits beyond the old fixed delay",
      );
      const socket = connect(port, "127.0.0.1");
      try {
        await once(socket, "connect");
      } finally {
        socket.destroy();
      }
      results.push(
        "apply waits for both control and inbound listeners before returning",
      );
    }
  } finally {
    await native.close();
  }
}
await writeFile(
  "work/native-readiness-result.json",
  JSON.stringify(
    { passed: true, results, scope: "local startup fixture only" },
    null,
    2,
  ),
);
console.log("PASS: bounded native listener readiness");
