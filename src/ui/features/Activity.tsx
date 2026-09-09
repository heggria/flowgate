import { useState } from "react";
import type { TraceContext } from "../../../packages/contracts/src/index";
import type { FeatureProps } from "../modules";
export function Activity({ snapshot }: FeatureProps) {
  const [events, setEvents] = useState<
    {
      time: string;
      name: string;
      status: string;
      context: Partial<TraceContext>;
    }[]
  >([]);
  const [error, setError] = useState("");
  return (
    <>
      <h1>操作记录</h1>
      <details>
        <summary>服务诊断</summary>
        <button
          className="secondary"
          onClick={() => {
            void window.shell
              .request("diagnostics.trace")
              .then((value) => {
                setEvents(value as typeof events);
                setError("");
              })
              .catch(() => setError("读取诊断失败"));
          }}
        >
          读取最近调用
        </button>
        {error ? <p role="alert">{error}</p> : null}
        {events
          .slice()
          .reverse()
          .map((event, index) => (
            <details key={index}>
              <summary>
                {new Date(event.time).toLocaleTimeString()} · {event.name} ·{" "}
                {event.status}
              </summary>
              <pre>{JSON.stringify(event.context, null, 2)}</pre>
            </details>
          ))}
      </details>

      {snapshot.operations.length ? (
        snapshot.operations.map((o) => (
          <section key={o.id} className="operation">
            <div>
              <strong>
                {(
                  {
                    "proxy.connect": "启动代理",
                    "extensions.setEnabled": "更改扩展启用状态",
                    "extensions.restart": "重启扩展宿主",
                    "proxy.disconnect": "停止代理",
                    "configuration.save": "保存配置",
                    "subscription.import": "导入节点",
                    "subscription.refresh": "更新订阅",
                    "node.remove": "移除节点",
                  } as Record<string, string>
                )[o.kind] ?? o.kind}
              </strong>
              <small>
                {new Date(o.startedAt).toLocaleString()} · 修订 {o.revision}
              </small>
              <details>
                <summary>详细信息</summary>
                <code>{o.id}</code>
                <p>追踪编号：{o.traceId}</p>
              </details>
            </div>
            <span className="badge">
              {
                {
                  pending: "处理中",
                  succeeded: "已完成",
                  failed: "失败",
                  unknown: "结果未知",
                }[o.state]
              }
            </span>
            {o.message ? <p>{o.message}</p> : null}
          </section>
        ))
      ) : (
        <div className="empty">暂无操作记录</div>
      )}
    </>
  );
}
