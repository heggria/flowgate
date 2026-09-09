import {
  credentials,
  loadPackageDefinition,
  Metadata,
  type Client,
} from "@grpc/grpc-js";
import { loadSync } from "@grpc/proto-loader";
import { join } from "node:path";
export interface NodeMeasurement {
  id: string;
  state: "running" | "succeeded" | "failed";
  delayMs?: number;
  measuredAt?: string;
  message?: string;
}
export async function measureOutbound(
  control: { endpoint: string; secret: string },
  id: string,
  signal: AbortSignal,
  schemaPath = join(__dirname, "telemetry.proto"),
): Promise<NodeMeasurement> {
  const definition = loadPackageDefinition(
    loadSync(schemaPath, { longs: String, defaults: true }),
  );
  const Service = (definition.daemon as any).StartedService;
  const client = new Service(
    control.endpoint,
    credentials.createInsecure(),
  ) as Client;
  const metadata = new Metadata();
  metadata.set("authorization", "Bearer " + control.secret);
  let started = Math.floor(Date.now() / 1000);
  return new Promise((resolve, reject) => {
    const stream = (client as any).subscribeOutbounds({}, metadata);
    let armed = false,
      dispatched = false,
      finished = false,
      previousTime = 0;
    let triggerTimer: ReturnType<typeof setTimeout> | undefined;
    const complete = (error?: Error, result?: NodeMeasurement) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(triggerTimer);
      signal.removeEventListener("abort", abort);
      stream.cancel();
      client.close();
      if (error) reject(error);
      else resolve(result!);
    };
    const abort = () => complete(new Error("延迟检测已取消"));
    const timer = setTimeout(
      () => complete(new Error("检测超时，未获得新的延迟结果")),
      12000,
    );
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    stream.on("data", (data: any) => {
      const outbound = data.outbounds?.find((item: any) => item.tag === id);
      if (!outbound) {
        complete(new Error("节点未载入当前内核，请先应用配置"));
        return;
      }
      if (!armed) {
        armed = true;
        previousTime = Number(outbound.urlTestTime);
        const dispatch = () => {
          if (finished) return;
          started = Math.floor(Date.now() / 1000);
          dispatched = true;
          (client as any).urlTest(
            { outboundTag: id },
            metadata,
            { deadline: Date.now() + 3000 },
            (error: Error | null) => {
              if (error) complete(new Error("内核拒绝延迟检测"));
            },
          );
        };
        if (previousTime >= started)
          triggerTimer = setTimeout(dispatch, 1010 - (Date.now() % 1000));
        else dispatch();
        return;
      }
      if (
        dispatched &&
        Number(outbound.urlTestTime) >= started &&
        Number(outbound.urlTestTime) > previousTime
      )
        complete(undefined, {
          id,
          state: "succeeded",
          delayMs: Number(outbound.urlTestDelay),
          measuredAt: new Date(
            Number(outbound.urlTestTime) * 1000,
          ).toISOString(),
        });
    });
    stream.on("error", () => complete(new Error("内核连接中断，检测未完成")));
    stream.on("end", () => complete(new Error("内核结束延迟检测")));
  });
}
