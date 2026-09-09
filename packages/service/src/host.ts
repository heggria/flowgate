import serviceCatalog from "../../contracts/src/service-catalog.json";
import { requestTrace } from "../../runtime/src/trace-context";
import { RequestScope } from "../../runtime/src/request-scope";
import { randomUUID } from "node:crypto";
import { StateStore } from "./store";
import { ServiceCore } from "./core";
import { KernelTelemetry } from "./kernel/telemetry";
import { assertRequest, type KernelState } from "../../contracts/src/index";
const port = (process as any).parentPort;
const epoch = Number(process.env.FLOWGATE_EPOCH),
  session = process.env.FLOWGATE_SESSION!;
const pending = new Map<
  string,
  {
    resolve: (v: any) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
    cleanup: () => void;
  }
>();
function capability(
  method: string,
  payload?: unknown,
  signal?: AbortSignal,
): Promise<any> {
  if (signal?.aborted) return Promise.reject(new Error("请求已取消"));
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => {
      pending.delete(id);
      cleanup();
      reject(
        Object.assign(new Error("原生/扩展操作结果未知"), {
          outcome: "unknown",
        }),
      );
    }, 25000);
    const abort = () => {
      if (!pending.has(id)) return;
      pending.delete(id);
      clearTimeout(timer);
      cleanup();
      port.postMessage({
        type: "capability.cancel",
        protocol: 1,
        id,
        epoch,
        session,
      });
      reject(new Error("扩展请求已取消"));
    };
    const cleanup = () => signal?.removeEventListener("abort", abort);
    signal?.addEventListener("abort", abort, { once: true });
    pending.set(id, { resolve, reject, timer, cleanup });
    port.postMessage({
      type: "capability",
      protocol: 1,
      id,
      epoch,
      session,
      method,
      payload,
      context: requestTrace.getStore(),
    });
  });
}
if (process.env.FLOWGATE_EXPECTED_SERVICE_MODULES) {
  const expected = JSON.parse(process.env.FLOWGATE_EXPECTED_SERVICE_MODULES);
  if (
    serviceCatalog.some((entry) => {
      const declared = expected.find(
        (item: { id: string }) => item.id === entry.id,
      );
      return (
        declared?.version !== entry.version ||
        ["permissions", "capabilities", "contributions"].some(
          (key) =>
            JSON.stringify([...(declared?.[key] ?? [])].sort()) !==
            JSON.stringify([...entry[key as "permissions"]].sort()),
        )
      );
    })
  )
    throw new Error("运行 Service 模块与受信清单不一致");
}
const core = new ServiceCore(
  new StateStore(process.env.FLOWGATE_DATA!, epoch),
  {
    status: () => capability("native.status"),
    control: () => capability("native.control"),
    apply: (config, revision, operationId, mode) =>
      capability("native.apply", { config, revision, operationId, mode }),
    stop: (operationId) => capability("native.stop", { operationId }),
  },
  (method, payload, signal) =>
    capability("extension.call", { method, payload }, signal),
  process.env.FLOWGATE_RELEASE!,
  new KernelTelemetry(),
  process.env.FLOWGATE_HOST_VERSION,
);
core.native.modules.trace.onChange = () =>
  port.postMessage({
    type: "trace",
    epoch,
    session,
    event: core.native.modules.trace.snapshot().at(-1),
  });
const ready =
  process.env.FLOWGATE_PREFLIGHT === "1" ? core.preflight() : core.start();
ready.catch(() => {});
const requests = new RequestScope();
port.on("message", async ({ data }: any) => {
  if (data?.type === "cancel") {
    if (data.protocol === 1 && data.session === session && data.epoch === epoch)
      requests.cancel(data.id);
    return;
  }
  if (data?.type === "capability.result") {
    const p = pending.get(data.id);
    if (!p) return;
    clearTimeout(p.timer);
    p.cleanup();
    pending.delete(data.id);
    if (data.error)
      p.reject(
        Object.assign(new Error(data.error.message), {
          outcome: data.error.outcome,
        }),
      );
    else p.resolve(data.result);
    return;
  }
  try {
    assertRequest(data);
    if (data.epoch !== epoch || data.session !== session) return;
    await ready;
    let result;
    if (data.method === "egress.resolve") {
      const target = (data.payload as { target?: unknown })?.target;
      if (typeof target !== "string") throw new Error("Missing egress target");
      result = await core.resolveEgress(target);
    } else if (data.method === "power.suspend") {
      core.suspend();
      result = { suspended: true };
    } else if (data.method === "power.resume") {
      await core.resume();
      result = { resumed: true };
    } else if (data.method === "drain") {
      await core.drain();
      result = { drained: true };
    } else if (data.method === "stop") {
      await core.stop();
      result = { stopped: true };
    } else {
      if (
        process.env.FLOWGATE_PREFLIGHT === "1" &&
        !["health", "snapshot"].includes(data.method)
      )
        throw new Error("只读预检拒绝写入");
      result = await requestTrace.run(data.context!, () =>
        requests.run(data.id, (signal) =>
          core.request(data.method, data.payload, data.operationId, signal),
        ),
      );
    }
    port.postMessage({ protocol: 1, id: data.id, epoch, result });
  } catch (error) {
    port.postMessage({
      protocol: 1,
      id: data?.id,
      epoch,
      error: {
        code: "SERVICE_FAILED",
        message: error instanceof Error ? error.message : "业务操作失败",
        outcome: (error as any).outcome ?? "failed",
      },
    });
  }
});

let publishing = false;
setInterval(() => {
  if (publishing || core.lifecycle !== "ready") return;
  publishing = true;
  void ready
    .then(() => core.snapshot())
    .then((snapshot) =>
      port.postMessage({ type: "snapshot", epoch, session, snapshot }),
    )
    .catch(() => {})
    .finally(() => (publishing = false));
}, 1500).unref();
