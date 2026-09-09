import {
  PausableTimers,
  type TimerTicket,
} from "../../runtime/src/pausable-timers";
import { randomUUID, createHash } from "node:crypto";
import { MockGateway, manifest } from "./gateway";
import { CapabilityHost } from "../../runtime/src/capabilities";
import { assertRequest } from "../../contracts/src/index";
const port = (process as any).parentPort;
const epoch = Number(process.env.FLOWGATE_EPOCH),
  session = process.env.FLOWGATE_SESSION;
const token = process.env.FLOWGATE_MODEL_TOKEN;
if (!token) throw new Error("Missing model token");
const capabilityTimers = new PausableTimers();
const pending = new Map<
  string,
  {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
    timer: TimerTicket;
  }
>();
function hostRequest(method: string, payload: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = capabilityTimers.timeout(() => {
      pending.delete(id);
      reject(new Error("Host capability timeout"));
    }, 5000);
    pending.set(id, { resolve, reject, timer });
    port.postMessage({
      type: "capability",
      protocol: 1,
      id,
      epoch,
      session,
      method,
      payload,
    });
  });
}
const upstream = process.env.FLOWGATE_INTERNAL_UPSTREAM;
const egressId = upstream ? "flowgate.policy" : "test.explicit";
const host = new CapabilityHost(
  manifest,
  new Set([egressId]),
  new Set(["provider.mock"]),
  (reference) => hostRequest("credential.resolve", { reference }),
  upstream ? (id) => hostRequest("egress.resolve", { id }) : undefined,
);
const gateway = new MockGateway(
  token,
  { id: egressId, resolve: async () => ({ id: egressId }) },
  1,
  Number(process.env.FLOWGATE_STRESS_CHUNKS ?? 0),
  host,
  upstream,
);
const ready = host.service("gateway", gateway);
ready.catch(() => {});
port.on("message", async ({ data }: any) => {
  if (data?.type === "power") {
    if (
      data.protocol === 1 &&
      data.epoch === epoch &&
      data.session === session
    ) {
      if (data.suspended === true) capabilityTimers.pause();
      else if (data.suspended === false) capabilityTimers.resume();
    }
    return;
  }
  if (data?.type === "capability.result") {
    const request = pending.get(data.id);
    if (!request) return;
    request.timer.cancel();
    pending.delete(data.id);
    if (data.error)
      request.reject(
        new Error(data.error.message ?? "Host capability unavailable"),
      );
    else request.resolve(data.result);
    return;
  }
  try {
    assertRequest(data);
    if (data.epoch !== epoch || data.session !== session) return;
    await ready;
    let result: unknown;
    if (data.method === "health" || data.method === "status")
      result = {
        protocol: 1,
        lifecycle: (await gateway.health()) ? "ready" : "stopped",
        port: gateway.port,
        version: manifest.version,
        releaseSet: process.env.FLOWGATE_RELEASE,
        resources: host.resources(),
        ledger: gateway.ledger.snapshot(),
        lastFailure: gateway.lastFailure,
      };
    else if (data.method === "credential.probe")
      result = await host.credential("provider.mock", async (secret) => ({
        digest: createHash("sha256").update(secret).digest("hex"),
      }));
    else if (data.method === "drain") {
      await host.drain(Date.now() + 5000);
      result = { drained: true };
    } else if (data.method === "stop") {
      await host.stop();
      result = { stopped: true };
    } else throw new Error("Unknown gateway method");
    port.postMessage({ protocol: 1, id: data.id, epoch, result });
  } catch (error) {
    port.postMessage({
      protocol: 1,
      id: data?.id,
      epoch,
      error: {
        code: "GATEWAY_FAILED",
        message: error instanceof Error ? error.message : "Gateway failed",
        outcome: (error as any).outcome ?? "failed",
      },
    });
  }
});
