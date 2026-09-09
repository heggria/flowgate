import { test } from "node:test";
import assert from "node:assert/strict";
import { RequestScope } from "../packages/runtime/src/request-scope";
import { ExtensionRuntime } from "../packages/extensions/src/runtime";
test("request scope cancels one request without canceling its sibling", async () => {
  const scope = new RequestScope();
  const action = (signal: AbortSignal) => new Promise<boolean>((resolve) => signal.addEventListener("abort", () => resolve(signal.aborted), { once: true }));
  const a = scope.run("a", action), b = scope.run("b", action);
  assert.equal(scope.cancel("a"), true); assert.equal(await a, true);
  assert.equal(scope.cancel("a"), false); assert.equal(scope.cancel("b"), true); await b;
});
test("extension runtime propagates per-request cancellation without draining module", async () => {
  const runtime = new ExtensionRuntime();
  await runtime.start([{ manifest: { id: "test", version: "1", api: 1, capabilities: [], dependencies: [] }, async activate(context) { context.contribute({ id: "wait", kind: "command", value: (_: unknown, signal: AbortSignal) => new Promise((resolve) => { if (signal.aborted) resolve(true); else signal.addEventListener("abort", () => resolve(true), { once: true }); }) }); } }]);
  const controller = new AbortController(); const request = runtime.call("wait", {}, controller.signal); controller.abort();
  assert.equal(await request, true); assert.equal(runtime.modules.status, "ready"); await runtime.stop();
});
