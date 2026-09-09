import {
  PageHeader,
  Disclosure,
  EmptyState,
  StatusBadge,
  TaskError,
  useTask,
} from "../components";
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
  const task = useTask();
  return (
    <>
      <PageHeader
        title="操作记录"
        description="查看操作结果，展开详情追踪异常。"
      />
      <Disclosure title="服务诊断">
        <button
          className="secondary"
          aria-disabled={task.pending}
          aria-busy={task.pending}
          onClick={() =>
            void task.execute(async () => {
              setEvents(
                (await window.shell.request(
                  "diagnostics.trace",
                )) as typeof events,
              );
            })
          }
        >
          {task.pending ? "读取中…" : "读取最近调用"}
        </button>
        <TaskError message={task.error} />
        {events
          .slice()
          .reverse()
          .map((event, index) => (
            <Disclosure
              key={index}
              title={`${new Date(event.time).toLocaleTimeString()} · ${event.name} · ${event.status}`}
            >
              <pre>{JSON.stringify(event.context, null, 2)}</pre>
            </Disclosure>
          ))}
      </Disclosure>

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
              <Disclosure title="详细信息">
                <code>{o.id}</code>
                <p>追踪编号：{o.traceId}</p>
              </Disclosure>
            </div>
            <StatusBadge
              tone={
                o.state === "succeeded"
                  ? "success"
                  : o.state === "failed"
                    ? "danger"
                    : "warning"
              }
            >
              {
                {
                  pending: "处理中",
                  succeeded: "已完成",
                  failed: "失败",
                  unknown: "结果未知",
                }[o.state]
              }
            </StatusBadge>
            {o.message ? (
              <p
                className={o.state === "failed" ? "taskerror" : "inlinestatus"}
              >
                {o.message}
              </p>
            ) : null}
          </section>
        ))
      ) : (
        <EmptyState
          title="暂无操作记录"
          description="启动代理、导入资源或保存配置后，结果会显示在这里。"
          icon="activity"
        />
      )}
    </>
  );
}
