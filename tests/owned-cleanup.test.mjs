import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cleanupStages, stopOwnedChild } from "./fixtures/owned-cleanup.mjs";
import { within } from "./fixtures/soak-cleanup.mjs";

test("cleanup continues every stage and retains each failure", async () => {
  const visited = [];
  await assert.rejects(
    cleanupStages([
      () => {
        visited.push("native");
        throw Error("native failure");
      },
      () => {
        visited.push("peer");
        throw Error("peer failure");
      },
      () => {
        visited.push("origin");
      },
    ]),
    (error) => error instanceof AggregateError && error.errors.length === 2,
  );
  assert.deepEqual(visited, ["native", "peer", "origin"]);
});

test("unresponsive owned child is SIGKILLed, awaited, and reported forced", async () => {
  const child = spawn(process.execPath, [
    "-e",
    "process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)",
  ]);
  const exit = once(child, "exit");
  try {
    await within(once(child.stdout, "data"), 5000);
    const cleanup = await stopOwnedChild(child, {
      timeout: 40,
      killTimeout: 1000,
    });
    assert.equal(cleanup.forced, true);
    assert.equal(cleanup.signalCode, "SIGKILL");
    assert.notEqual(
      child.signalCode,
      null,
      "original child exit must be observed",
    );
    assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await within(exit, 1000);
    }
  }
});

test("protocol UDP connect/bind setup failures still close owned resources", async () => {
  const { readFile } = await import("node:fs/promises");
  const { transform } = await import("esbuild");
  const { runInNewContext } = await import("node:vm");
  const { EventEmitter } = await import("node:events");
  const source = await readFile(
    new URL("./protocols.integration.ts", import.meta.url),
    "utf8",
  );
  const body = source.slice(
    source.indexOf("async function udp("),
    source.indexOf("async function stopPeer()"),
  );
  const compiled = (
    await transform(body + "\nglobalThis.probe = udp;", {
      loader: "ts",
      target: "node24",
    })
  ).code;
  for (const phase of ["connect", "bind"]) {
    const failure = new Error(phase + " setup failed");
    const socket = new EventEmitter();
    let tcpClosed = false,
      udpClosed = false,
      udpCreated = false;
    socket.destroy = () => {
      tcpClosed = true;
    };
    const context = {
      once,
      within,
      AbortSignal,
      assert,
      port: 1234,
      connect: () => {
        queueMicrotask(() =>
          phase === "connect"
            ? socket.emit("error", failure)
            : socket.emit("connect"),
        );
        return socket;
      },
      createSocket: () => {
        udpCreated = true;
        const datagram = new EventEmitter();
        datagram.bind = () =>
          queueMicrotask(() => datagram.emit("error", failure));
        datagram.close = () => {
          udpClosed = true;
          throw Object.assign(new Error("unbound socket"), {
            code: "ERR_SOCKET_DGRAM_NOT_RUNNING",
          });
        };
        return datagram;
      },
    };
    runInNewContext(compiled, context);
    await assert.rejects(context.probe(100), (error) => error === failure);
    assert.equal(tcpClosed, true, phase + " must destroy owned TCP socket");
    assert.equal(udpCreated, phase === "bind");
    assert.equal(
      udpClosed,
      phase === "bind",
      "unbound close must not prevent TCP cleanup or replace setup failure",
    );
  }
});
