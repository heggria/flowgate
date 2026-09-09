import {
  credentials,
  loadPackageDefinition,
  Metadata,
  type Client,
  type ClientReadableStream,
} from "@grpc/grpc-js";
import { loadSync } from "@grpc/proto-loader";
import { join } from "node:path";
import type { TrafficSnapshot, FlowRecord } from "../../../contracts/src/index";
import { TrafficHistory } from "./traffic-history";
export class KernelTelemetry {
  private history = new TrafficHistory();
  private client?: Client;
  private streams: ClientReadableStream<any>[] = [];
  private identity = "";
  private generation = 0;
  private flows = new Map<string, FlowRecord>();
  private state: TrafficSnapshot = {
    available: false,
    upload: 0,
    download: 0,
    flows: [],
  };
  constructor(readonly schemaPath = join(__dirname, "telemetry.proto")) {}
  connect(control: { endpoint: string; secret: string } | null) {
    const identity = control ? control.endpoint + control.secret : "";
    if (this.identity === identity) return;
    this.close();
    if (!control) return;
    this.identity = identity;
    const generation = this.generation;
    const definition = loadPackageDefinition(
      loadSync(this.schemaPath, { longs: String, defaults: true }),
    );
    const Service = (definition.daemon as any).StartedService;
    const client = new Service(control.endpoint, credentials.createInsecure(), {
      "grpc.max_receive_message_length": 4 * 1024 * 1024,
    }) as Client;
    this.client = client;
    const metadata = new Metadata();
    metadata.set("authorization", "Bearer " + control.secret);
    const status = (client as any).subscribeStatus(
      { interval: "1000000000" },
      metadata,
    ) as ClientReadableStream<any>;
    status.on("data", (data) => {
      if (generation !== this.generation) return;
      this.state.available = data.trafficAvailable;
      this.state.upload = Number(data.uplinkTotal);
      this.state.download = Number(data.downlinkTotal);
      const point = this.history.sample(
        Date.now(),
        this.state.upload,
        this.state.download,
      );
      this.state.sampledAt = point.at;
      this.state.uploadRate = point.uploadRate;
      this.state.downloadRate = point.downloadRate;
      this.state.activeConnections = Number(data.connectionsIn);
    });
    const connections = (client as any).subscribeConnections(
      { interval: "1000000000" },
      metadata,
    ) as ClientReadableStream<any>;
    connections.on("data", (data) => {
      if (generation !== this.generation) return;
      if (data.reset) this.flows.clear();
      for (const event of data.events ?? []) {
        if (event.connection) {
          const c = event.connection;
          this.flows.set(c.id, {
            id: c.id,
            target: c.domain || c.destination,
            protocol: c.network,
            outbound: c.outbound,
            rule: c.rule,
            upload: Number(c.uplinkTotal),
            download: Number(c.downlinkTotal),
            state: Number(c.closedAt) > 0 ? "closed" : "active",
          });
        } else {
          const flow = this.flows.get(event.id);
          if (flow) {
            flow.upload += Number(event.uplinkDelta ?? 0);
            flow.download += Number(event.downlinkDelta ?? 0);
            if (event.type === 2) flow.state = "closed";
          }
        }
        while (this.flows.size > 200)
          this.flows.delete(this.flows.keys().next().value!);
      }
    });
    for (const stream of [status, connections]) {
      stream.on("error", () => {
        if (generation !== this.generation) return;
        this.state.available = false;
        this.identity = "";
      });
      stream.on("end", () => {
        if (generation !== this.generation) return;
        this.state.available = false;
        this.identity = "";
      });
    }
    this.streams = [status, connections];
  }
  snapshot(): TrafficSnapshot {
    return {
      ...this.state,
      available:
        this.state.available && Date.now() - (this.state.sampledAt ?? 0) < 5000,
      history: this.history.points.slice(),
      flows: [...this.flows.values()].reverse(),
    };
  }
  close() {
    this.generation++;
    for (const stream of this.streams) stream.cancel();
    this.streams = [];
    this.client?.close();
    this.client = undefined;
    this.identity = "";
    this.flows.clear();
    this.history.reset();
    this.state = { available: false, upload: 0, download: 0, flows: [] };
  }
}
