import test from "node:test";
import assert from "node:assert/strict";
import {
  KernelRuntime,
  singBoxAdapter,
} from "../packages/service/src/kernel/adapter";
import { ModuleRuntime, TraceBuffer } from "../packages/runtime/src/lifecycle";
import { initialConfiguration } from "../packages/domain/src/configuration";
import type {
  KernelState,
  TraceContext,
} from "../packages/contracts/src/index";
const context: TraceContext = {
  operationId: "adapter-op",
  traceId: "adapter-trace",
  releaseSet: "release-2",
  serviceVersion: "0.2.0",
  epoch: 7,
  configRevision: 3,
  shellVersion: "0.2.0",
};
test("kernel adapter drain fences new native writes, awaits admitted work, and disposal preserves helper-owned kernel", async () => {
  let stopped = 0,
    finish!: (state: KernelState) => void;
  const pending = new Promise<KernelState>((resolve) => {
    finish = resolve;
  });
  const runtime = new KernelRuntime(
    singBoxAdapter({
      status: async () => ({ status: "running", systemControl: false }),
      apply: async () => pending,
      stop: async () => {
        stopped++;
        return { status: "stopped", systemControl: false };
      },
    }),
    () => context,
  );
  await runtime.start();
  const compiled: any = await runtime.compile(initialConfiguration());
  assert.equal(compiled.inbounds[0].type, "mixed");
  const applying = runtime.apply(compiled, 3, "adapter-op");
  await assert.rejects(runtime.drain(Date.now() + 10), { outcome: "unknown" });
  await assert.rejects(runtime.apply(compiled, 3, "duplicate"), /正在退出/);
  finish({
    status: "running",
    systemControl: false,
    appliedRevision: 3,
    operationId: "adapter-op",
  });
  await applying;
  await runtime.dispose();
  assert.equal(stopped, 0);
  await assert.rejects(runtime.status(), /正在退出/);
  const events = runtime.modules.trace.snapshot();
  const lifecycle = events.filter((e) =>
    ["starting", "ready", "timeout", "draining", "stopped"].includes(e.status),
  );
  assert.equal(new Set(lifecycle.map((e) => e.context.pluginInstance)).size, 1);
  for (const event of lifecycle) {
    assert.equal(event.context.releaseSet, "release-2");
    assert.equal(event.context.epoch, 7);
    assert.equal(event.context.configRevision, 3);
    assert.ok(event.context.pluginInstance);
  }
});
test("a trusted alternate adapter registers the same contract and failed resource disposal retains complete identity", async () => {
  let released = false;
  const runtime = new KernelRuntime(
    {
      manifest: {
        id: "test.adapter",
        version: "2",
        api: 1,
        dependencies: [],
        capabilities: [],
      },
      async activate(c) {
        for (const name of [
          "status",
          "control",
          "apply",
          "disconnect",
          "compile",
        ])
          c.contribute({
            id: "kernel." + name,
            kind: "command",
            value: () => (name === "compile" ? { format: "alternate" } : null),
          });
        c.defer(() => {
          released = true;
        });
      },
    },
    () => context,
  );
  await runtime.start();
  assert.deepEqual(await runtime.compile(initialConfiguration()), {
    format: "alternate",
  });
  await runtime.dispose();
  assert.equal(released, true);
  const modules = new ModuleRuntime(new TraceBuffer(), () => context);
  await modules.activate([
    {
      manifest: {
        id: "failing.dispose",
        version: "1",
        api: 1,
        dependencies: [],
        capabilities: [],
      },
      async activate(c) {
        c.defer(() => {
          throw new Error("release failed");
        });
      },
    },
  ]);
  await assert.rejects(modules.stop(), /release failed/i);
  const failure = modules.trace
    .snapshot()
    .find((e) => e.status === "release-failed")!;
  assert.equal(failure.context.releaseSet, "release-2");
  assert.equal(failure.context.epoch, 7);
  assert.ok(failure.context.pluginInstance?.startsWith("failing.dispose:"));
});
