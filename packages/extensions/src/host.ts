import { requestTrace } from "../../runtime/src/trace-context";
import { RequestScope } from "../../runtime/src/request-scope";
import { parseRuleSet } from "./ruleset";
import { inspectSystem } from "../../../src/platform/macos";
import { createRegistry } from "../../../src/plugins/builtins";
import { parseSubscription } from "./parser";
import { assertRequest } from "../../contracts/src/index";
import { ExtensionRuntime } from "./runtime";
import type { RuntimeModule } from "../../runtime/src/lifecycle";
const port = (process as any).parentPort;
const session = process.env.FLOWGATE_SESSION;
const epoch = Number(process.env.FLOWGATE_EPOCH);
const builtins: RuntimeModule[] = [
  {
    manifest: {
      id: "builtin.rules",
      version: "1.0.0",
      api: 1,
      dependencies: [],
      capabilities: [],
    },
    async activate(context) {
      context.contribute({
        id: "ruleset.parse",
        kind: "command",
        value: parseRuleSet,
      });
    },
  },
  {
    manifest: {
      id: "builtin.network",
      version: "1.0.0",
      api: 1,
      dependencies: [],
      capabilities: [],
    },
    async activate(context) {
      const registry = createRegistry();
      context.contribute({
        id: "network.inspect",
        kind: "command",
        value: async () => {
          const [system, plugins] = await Promise.all([
            inspectSystem(),
            registry.inspect(),
          ]);
          return { ...system, plugins };
        },
      });
    },
  },
  {
    manifest: {
      id: "builtin.subscription",
      version: "1.0.0",
      api: 1,
      dependencies: [],
      capabilities: [],
    },
    async activate(context) {
      context.contribute({
        id: "subscription.parse",
        kind: "command",
        value: (payload: any) =>
          parseSubscription(payload.text, payload.sourceId),
      });
      context.contribute({
        id: "subscription.fetch",
        kind: "command",
        value: async (payload: any, signal: AbortSignal) => {
          const u = new URL(payload.url);
          if (u.protocol !== "https:") throw new Error("仅支持 HTTPS 订阅");
          const response = await fetch(u, {
            signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
            redirect: "error",
          });
          if (!response.ok || !response.body) throw new Error("订阅请求失败");
          const reader = response.body.getReader();
          const chunks: Uint8Array[] = [];
          let size = 0;
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              size += value.length;
              if (size > 4 * 1024 * 1024) throw new Error("订阅超过大小限制");
              chunks.push(value);
            }
          } finally {
            await reader.cancel();
          }
          return Buffer.concat(chunks).toString("utf8");
        },
      });
    },
  },
];
const runtime = new ExtensionRuntime();
runtime.modules.trace.onChange = () =>
  port.postMessage({
    type: "trace",
    epoch,
    session,
    event: runtime.modules.trace.snapshot().at(-1),
  });
const ready = runtime.start(builtins);
ready.catch(() => {});
const requests = new RequestScope();
port.on("message", async ({ data }: any) => {
  if (data?.type === "cancel") {
    if (data.protocol === 1 && data.session === session && data.epoch === epoch)
      requests.cancel(data.id);
    return;
  }
  try {
    assertRequest(data);
    if (data.session !== session || data.epoch !== epoch) return;
    await ready;
    let result: unknown;
    if (data.method === "health")
      result = {
        protocol: 1,
        lifecycle: runtime.modules.status,
        modules: builtins.map(({ manifest }) => ({
          id: manifest.id,
          version: manifest.version,
          status: runtime.modules.status,
        })),
      };
    else if (data.method === "drain") {
      await runtime.drain(Date.now() + 5000);
      result = { drained: true };
    } else if (data.method === "stop") {
      await runtime.stop();
      result = { stopped: true };
    } else
      result = await requestTrace.run(data.context!, () =>
        requests.run(data.id, (signal) =>
          runtime.call(data.method, data.payload, signal),
        ),
      );
    port.postMessage({ protocol: 1, id: data.id, epoch, result });
  } catch (error) {
    port.postMessage({
      protocol: 1,
      id: data?.id,
      epoch,
      error: {
        code: "EXTENSION_FAILED",
        message: error instanceof Error ? error.message : "扩展失败",
        outcome: (error as any).outcome ?? "failed",
      },
    });
  }
});
