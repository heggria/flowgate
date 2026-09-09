import { beforeDeadline } from "../packages/runtime/src/deadline";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Server,
  ServerCredentials,
  loadPackageDefinition,
} from "@grpc/grpc-js";
import { loadSync } from "@grpc/proto-loader";
import { resolve } from "node:path";
import { measureOutbound } from "../packages/service/src/kernel/measurement";
test("measurement waits for fresh authenticated kernel result and releases subscription", async () => {
  const schema = resolve("packages/service/src/kernel/telemetry.proto");
  const definition = loadPackageDefinition(
    loadSync(schema, { longs: String, defaults: true }),
  );
  const server = new Server();
  let cancelObserved!: () => void;
  const cancellation = new Promise<void>((resolve) => {
    cancelObserved = resolve;
  });
  let subscription: any,
    closed = false,
    tests = 0;
  server.addService((definition.daemon as any).StartedService.service, {
    subscribeOutbounds(call: any) {
      assert.deepEqual(call.metadata.get("authorization"), [
        "Bearer test-token",
      ]);
      subscription = call;
      call.on("cancelled", () => {
        closed = true;
        cancelObserved();
      });
      call.write({
        outbounds: [{ tag: "node", urlTestTime: "1", urlTestDelay: 7 }],
      });
    },
    urlTest(call: any, callback: any) {
      tests++;
      assert.equal(call.request.outboundTag, "node");
      callback(null, {});
      subscription.write({
        outbounds: [{ tag: "node", urlTestTime: "1", urlTestDelay: 7 }],
      });
      setTimeout(
        () =>
          subscription.write({
            outbounds: [
              {
                tag: "node",
                urlTestTime: String(Math.floor(Date.now() / 1000)),
                urlTestDelay: 42,
              },
            ],
          }),
        30,
      );
    },
  });
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync(
      "127.0.0.1:0",
      ServerCredentials.createInsecure(),
      (error, port) => (error ? reject(error) : resolve(port)),
    ),
  );
  try {
    const result = await measureOutbound(
      { endpoint: `127.0.0.1:${port}`, secret: "test-token" },
      "node",
      new AbortController().signal,
      schema,
    );
    assert.equal(result.delayMs, 42);
    assert.equal(tests, 1);
    await beforeDeadline(
      cancellation,
      Date.now() + 2000,
      "server cancellation acknowledgement",
    );
    assert.equal(closed, true);
  } finally {
    server.forceShutdown();
  }
});
