import { Button, SettingRow, StatusBadge } from "../components";
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
    <section className="settingsgroup">
      <div className="groupheading">
        <h2>内部流式服务验收</h2>
        <p>用于验证宿主、连接排空和更新，不提供真实模型服务。</p>
      </div>
      <div className="settingssurface">
        <SettingRow
          label="服务状态"
          description={
            status.port ? `127.0.0.1:${status.port}` : "服务尚未启动"
          }
        >
          <StatusBadge
            tone={status.lifecycle === "ready" ? "success" : "neutral"}
          >
            {status.lifecycle === "ready" ? "运行中" : "已停止"}
          </StatusBadge>
        </SettingRow>
        <SettingRow label="测试服务" description="用于内部验收的独立服务。">
          <Button
            pending={Boolean(busy)}
            className="secondary"
            onClick={() =>
              run(async () => {
                await window.shell.request(
                  status.lifecycle === "ready"
                    ? "gateway.stop"
                    : "gateway.start",
                );
                await refresh();
              })
            }
          >
            {status.lifecycle === "ready" ? "停止测试服务" : "启动测试服务"}
          </Button>
        </SettingRow>
      </div>
    </section>
  );
}
