import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deepLinkRoute } from "../packages/shell/src/deep-link";
import { TraceBuffer } from "../packages/runtime/src/lifecycle";
import { DiagnosticTrace } from "../packages/shell/src/diagnostic-trace";
import { parseSystemProxies } from "../src/platform/macos";
test("deep links only navigate static pages; system proxy observation keeps PAC separate", () => {
  assert.equal(deepLinkRoute("flowgate://open/nodes"), "nodes");
  for (const value of [
    "flowgate://open/nodes?import=secret",
    "flowgate://open/../nodes",
    "flowgate://open/proxy.connect",
    "https://open/nodes",
    "flowgate://user@open/nodes",
  ])
    assert.equal(deepLinkRoute(value), undefined);
  assert.deepEqual(
    parseSystemProxies(
      "HTTPEnable : 1\nHTTPProxy : 127.0.0.1\nHTTPPort : 7890\nSOCKSEnable : 0\nSOCKSProxy : localhost\nSOCKSPort : 1080\nProxyAutoConfigEnable : 1",
    ),
    [{ kind: "http", host: "127.0.0.1", port: 7890 }],
  );
});
test("diagnostic trace preserves immutable bounded contexts across restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "flowgate-trace-"));
  try {
    const trace = new TraceBuffer(2),
      store = new DiagnosticTrace(dir, trace);
    await store.init();
    const context = { traceId: "first", configRevision: 1 };
    trace.emit("Service", "starting", context);
    context.configRevision = 2;
    trace.emit("Service", "ready", context);
    assert.equal(trace.snapshot()[0].context.configRevision, 1);
    trace.emit("Service", "stopped", context);
    await store.flush();
    const restored = new TraceBuffer(2);
    await new DiagnosticTrace(dir, restored).init();
    assert.deepEqual(
      restored.snapshot().map((event) => event.status),
      ["ready", "stopped"],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
