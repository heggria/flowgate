import type { CapabilityHost } from "../../runtime/src/capabilities";
import { createServer, type Server, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import type {
  CapabilityManifest,
  ServiceLifecycle,
} from "../../contracts/src/index";
export const manifest: CapabilityManifest = {
  id: "internal.gateway-test",
  version: "1.0.0",
  api: 1,
  dependencies: [],
  capabilities: [
    "services",
    "endpoints",
    "streams",
    "egress",
    "credentials",
    "storage",
    "jobs",
    "uiContributions",
    "observability",
    "releaseLifecycle",
  ],
};
export class UsageLedger {
  private entries = new Map<
    string,
    {
      reserved: number;
      state: "reserved" | "settled" | "unknown";
      actual?: number;
    }
  >();
  constructor(readonly budget: number) {}
  reserve(id: string, amount: number) {
    if (this.entries.has(id) || !Number.isFinite(amount) || amount < 0)
      throw new Error("Invalid reservation");
    const held = [...this.entries.values()].reduce(
      (sum, e) => sum + (e.state === "settled" ? e.actual! : e.reserved),
      0,
    );
    if (held + amount > this.budget) throw new Error("Budget exceeded");
    this.entries.set(id, { reserved: amount, state: "reserved" });
  }
  settle(id: string, actual?: number) {
    const e = this.entries.get(id);
    if (!e || e.state !== "reserved") throw new Error("Reservation missing");
    if (actual !== undefined && (!Number.isFinite(actual) || actual < 0))
      throw new Error("Invalid usage");
    Object.assign(e, {
      state: actual === undefined ? "unknown" : "settled",
      actual,
    });
  }
  snapshot() {
    return [...this.entries.entries()].map(([id, e]) => ({ id, ...e }));
  }
}
export class CredentialScope {
  private values = new Map<string, string>();
  constructor(readonly allowed: Set<string>) {}
  put(ref: string, value: string) {
    if (!this.allowed.has(ref)) throw new Error("Credential scope denied");
    this.values.set(ref, value);
  }
  use<T>(ref: string, action: (value: string) => T): T {
    if (!this.allowed.has(ref) || !this.values.has(ref))
      throw new Error("Credential scope denied");
    return action(this.values.get(ref)!);
  }
  clear() {
    this.values.clear();
  }
}
async function write(
  response: ServerResponse,
  value: string,
  signal: AbortSignal,
  observe: (buffered: number, waiting: boolean) => void = () => {},
) {
  if (signal.aborted) throw signal.reason;
  const accepted = response.write(value);
  observe(response.writableLength, !accepted);
  if (!accepted) {
    await once(response, "drain", { signal });
  }
}
export class MockGateway implements ServiceLifecycle {
  private server?: Server;
  private accepting = false;
  private active = new Map<string, AbortController>();
  readonly ledger = new UsageLedger(100);
  cancelled = 0;
  maxBuffered = 0;
  backpressureWaits = 0;
  port = 0;
  constructor(
    readonly token: string,
    readonly egress: { id: string; resolve: () => Promise<{ id: string }> },
    readonly configurationRevision = 1,
    readonly stressChunks = 0,
    readonly host?: CapabilityHost,
  ) {}
  async prepare(signal: AbortSignal) {
    signal.throwIfAborted();
    const route = await this.egress.resolve();
    if (route.id !== this.egress.id)
      throw new Error("Explicit egress mismatch");
  }
  async start() {
    this.accepting = true;
    this.server = createServer(async (req, res) => {
      const presented = Buffer.from(req.headers.authorization ?? ""),
        expected = Buffer.from("Bearer " + this.token);
      if (
        presented.length !== expected.length ||
        !timingSafeEqual(presented, expected)
      ) {
        res.writeHead(401).end();
        return;
      }
      if (req.method !== "POST" || req.url !== "/v1/mock") {
        res.writeHead(404).end();
        return;
      }
      if (!this.accepting) {
        res.writeHead(503).end();
        return;
      }
      const id = randomUUID(),
        controller = new AbortController();
      let stream: ReturnType<CapabilityHost["stream"]> | undefined;
      try {
        stream = this.host?.stream(id, controller);
      } catch {
        res.writeHead(503).end();
        return;
      }
      this.active.set(id, controller);
      let completed = false;
      res.on("close", () => {
        if (!completed) {
          this.cancelled++;
          controller.abort(new Error("Client disconnected"));
        }
      });
      try {
        this.ledger.reserve(id, 10);
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "x-config-revision": String(this.configurationRevision),
        });
        const events = [
          { type: "tool.delta", arguments: '{"city":' },
          { type: "tool.delta", arguments: '"Shanghai"}' },
          { type: "unknown.event", preserved: true },
          { type: "error", code: "mock_upstream_error" },
        ];
        for (
          let index = 0;
          index < (this.stressChunks || events.length);
          index++
        ) {
          const event = this.stressChunks
            ? { type: "test.delta", data: "x".repeat(8192) }
            : events[index];
          await write(
            res,
            "data: " + JSON.stringify(event) + "\n\n",
            controller.signal,
            (buffered, waiting) => {
              this.maxBuffered = Math.max(this.maxBuffered, buffered);
              if (waiting) this.backpressureWaits++;
            },
          );
          this.maxBuffered = Math.max(this.maxBuffered, res.writableLength);
          await new Promise<void>((resolve, reject) => {
            const abort = () => {
              clearTimeout(timer);
              reject(controller.signal.reason);
            };
            const timer = setTimeout(
              () => {
                controller.signal.removeEventListener("abort", abort);
                resolve();
              },
              this.stressChunks ? 0 : 15,
            );
            controller.signal.addEventListener("abort", abort, { once: true });
          });
        }
        completed = true;
        res.end();
      } catch {
        if (!res.headersSent) res.writeHead(429);
        res.end();
      } finally {
        if (
          this.ledger
            .snapshot()
            .some((e) => e.id === id && e.state === "reserved")
        )
          this.ledger.settle(id);
        this.active.delete(id);
        stream?.release();
      }
    });
    if (this.host)
      this.port = await this.host.endpoint("model-api", this.server);
    else {
      await new Promise<void>((resolve, reject) => {
        this.server!.once("error", reject);
        this.server!.listen(0, "127.0.0.1", resolve);
      });
      this.port = (this.server.address() as any).port;
    }
  }
  async health() {
    return this.server?.listening ?? false;
  }
  async drain(deadline: number) {
    this.accepting = false;
    while (this.active.size) {
      if (Date.now() >= deadline)
        throw new Error("Active streams must finish before update");
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  async stop() {
    await this.drain(Date.now() + 1000);
    if (this.server)
      await new Promise<void>((resolve, reject) =>
        this.server!.close((e) => (e ? reject(e) : resolve())),
      );
  }
}
