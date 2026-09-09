import { useEffect, useState } from "react";
import type { FeatureProps } from "../modules";
export function GatewaySettings({ run, busy }: FeatureProps) {
  const [status, setStatus] = useState<{
    available: boolean;
    lifecycle: string;
    port?: number;
  } | null>(null);
  const refresh = async () =>
    setStatus((await window.shell.request("gateway.status")) as any);
  useEffect(() => {
    void refresh().catch(() => {});
  }, []);
  if (!status?.available) return null;
  return (
    <section className="panel">
      <h2>内部流式服务验收</h2>
      <p>用于验证宿主、连接排空和更新，不提供真实模型服务。</p>
      <p>
        {status.lifecycle === "ready"
          ? `运行中 · 127.0.0.1:${status.port}`
          : "已停止"}
      </p>
      <button
        disabled={busy}
        className="secondary"
        onClick={() =>
          run(async () => {
            await window.shell.request(
              status.lifecycle === "ready" ? "gateway.stop" : "gateway.start",
            );
            await refresh();
          })
        }
      >
        {status.lifecycle === "ready" ? "停止测试服务" : "启动测试服务"}
      </button>
    </section>
  );
}
