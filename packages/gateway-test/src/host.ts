import { MockGateway, manifest } from "./gateway";
import { CapabilityHost } from "../../runtime/src/capabilities";
const token = process.env.FLOWGATE_MODEL_TOKEN;
if (!token) throw new Error("Missing model API token");
const capabilities = new CapabilityHost(
  manifest,
  new Set(["test.explicit"]),
  new Set(["provider.mock"]),
  async () => "internal-fixture-only",
);
const gateway = new MockGateway(
  token,
  {
    id: "test.explicit",
    resolve: async () => ({ id: "test.explicit" }),
  },
  1,
  0,
  capabilities,
);
await capabilities.service("gateway", gateway);
process.send?.({ type: "ready", port: gateway.port });
process.on("message", async (message: any) => {
  try {
    if (message.method === "drain") {
      await capabilities.drain(Date.now() + 5000);
      process.send?.({ id: message.id, result: "drained" });
    } else if (message.method === "stop") {
      await capabilities.stop();
      process.send?.({ id: message.id, result: "stopped" });
      process.disconnect?.();
    } else if (message.method === "status")
      process.send?.({
        id: message.id,
        result: {
          ledger: gateway.ledger.snapshot(),
          cancelled: gateway.cancelled,
        },
      });
  } catch (error) {
    process.send?.({ id: message.id, error: String(error) });
  }
});
process.on("disconnect", () => {
  void capabilities.stop();
});
