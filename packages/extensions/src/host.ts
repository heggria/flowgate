import { requestTrace } from "../../runtime/src/trace-context";
import { RequestScope } from "../../runtime/src/request-scope";
import { parseRuleSet } from "./ruleset";
import { inspectSystem } from "../../../src/platform/macos";
import { diagnosticPlugins } from "../../../src/plugins/builtins";
import {
  builtinExtensions,
  extensionPreferences,
} from "../../contracts/src/extensions";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { parseSubscriptionDocument } from "./subscriptions/index";
import { SubscriptionWorkers } from "./subscriptions/worker-host";
import { fetchSubscription } from "./subscriptions/fetch";
import { assertRequest } from "../../contracts/src/index";
import { ExtensionManager } from "./manager";
import type { RuntimeModule } from "../../runtime/src/lifecycle";
if (!isMainThread) {
  try {
    if (workerData?.kind !== "subscription-parser")
      throw new Error("Invalid worker role");
    parentPort!.postMessage({
      result: parseSubscriptionDocument(workerData.text, workerData.options),
    });
  } catch {
    parentPort!.postMessage({ error: true });
  } finally {
    parentPort!.close();
  }
} else startHost();

function startHost() {
  const port = (process as any).parentPort;
  const session = process.env.FLOWGATE_SESSION;
  const epoch = Number(process.env.FLOWGATE_EPOCH);
  if (process.env.FLOWGATE_EXPECTED_EXTENSIONS) {
    const expected = JSON.parse(process.env.FLOWGATE_EXPECTED_EXTENSIONS) as {
      id: string;
      version: string;
      permissions?: string[];
      capabilities?: string[];
      contributions?: string[];
    }[];
    if (
      builtinExtensions.some((entry) => {
        const declared = expected.find((item) => item.id === entry.id);
        return (
          declared?.version !== entry.version ||
          ["permissions", "capabilities", "contributions"].some(
            (key) =>
              JSON.stringify(
                [...(declared?.[key as "permissions"] ?? [])].sort(),
              ) !== JSON.stringify([...entry[key as "permissions"]].sort()),
          )
        );
      })
    )
      throw new Error("运行扩展版本与受信清单不一致");
  }
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
        context.contribute({
          id: "network.inspect",
          kind: "command",
          value: (_: unknown, signal: AbortSignal) => inspectSystem(signal),
        });
      },
    },
    {
      manifest: {
        id: "builtin.subscription",
        version: "2.0.0",
        api: 1,
        dependencies: [],
        capabilities: [],
      },
      async activate(context) {
        const workers = new SubscriptionWorkers(__filename);
        context.defer(() => workers.dispose());
        context.contribute({
          id: "subscription.parse",
          kind: "command",
          value: async (payload: any, signal: AbortSignal) => {
            const result = await workers.parse(
              payload.text,
              payload.options ?? {},
              signal,
            );
            if (payload.version === 2) return result;
            if (result.rejected)
              throw new Error("部分节点不能无损转换，请使用订阅预览检查");
            return result.nodes.map((node) => ({
              ...node,
              sourceId: payload.sourceId,
            }));
          },
        });
        context.contribute({
          id: "subscription.fetch",
          kind: "command",
          value: fetchSubscription,
        });
      },
    },
  ];

  for (const plugin of diagnosticPlugins()) {
    const descriptor = builtinExtensions.find(
      (entry) => entry.id === plugin.id,
    )!;
    builtins.push({
      manifest: {
        id: descriptor.id,
        version: descriptor.version,
        api: 1,
        dependencies: descriptor.dependencies,
        capabilities: descriptor.capabilities,
      },
      async activate(context) {
        context.contribute({
          id: descriptor.methods[0],
          kind: "command",
          value: (_: unknown, signal: AbortSignal) => plugin.inspect(signal),
        });
      },
    });
  }
  const runtime = new ExtensionManager(builtinExtensions, builtins, {
    epoch,
    releaseSet: process.env.FLOWGATE_RELEASE ?? "bundled",
    version: process.env.FLOWGATE_HOST_VERSION ?? "unknown",
  });
  runtime.trace.onChange = () =>
    port.postMessage({
      type: "trace",
      epoch,
      session,
      event: runtime.trace.snapshot().at(-1),
    });
  // Optional packages are not admitted until Service supplies the durable preferences.
  const ready = runtime.configure({}, true);
  ready.catch(() => {});
  const requests = new RequestScope();
  port.on("message", async ({ data }: any) => {
    if (data?.type === "power") return; // This host owns no capability-response deadline.

    if (data?.type === "cancel") {
      if (
        data.protocol === 1 &&
        data.session === session &&
        data.epoch === epoch
      )
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
          lifecycle: "ready",
          modules: runtime.snapshot().map((entry) => ({
            id: entry.id,
            version: entry.version,
            status: entry.status,
          })),
          extensions: runtime.snapshot(),
        };
      else if (data.method === "extensions.configure")
        result = await requestTrace.run(data.context!, () =>
          runtime.configure(
            extensionPreferences(
              (data.payload as { preferences?: unknown })?.preferences,
            ),
          ),
        );
      else if (data.method === "drain") {
        await runtime.drain(Date.now() + 5000);
        result = { drained: true };
      } else if (data.method === "stop") {
        await runtime.stop();
        result = { stopped: true };
      } else
        result = await requestTrace.run(data.context!, () =>
          requests.run(data.id, (signal) =>
            data.method === "network.inspect"
              ? runtime.inspectNetwork(signal)
              : runtime.call(data.method, data.payload, signal),
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
}
