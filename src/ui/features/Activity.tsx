import {
  Button,
  PageHeader,
  Disclosure,
  EmptyState,
  StatusBadge,
  TaskError,
  useTask,
  SearchField,
  Combobox,
  InfoTip,
} from "../components";
import { useState } from "react";
import type { TraceContext } from "../../../packages/contracts/src/index";
import type { FeatureProps } from "../modules";
const operationNames: Record<string, string> = {
  "proxy.connect": "启动代理",
  "proxy.disconnect": "停止代理",
  "configuration.save": "保存配置",
  "extensions.setEnabled": "更改扩展启用状态",
  "extensions.restart": "重启扩展宿主",
  "subscription.import": "导入资源",
  "subscription.refresh": "更新订阅",
  "subscription.rename": "重命名订阅",
  "subscription.remove": "移除订阅",
  "node.remove": "移除节点",
  "node.update": "更新节点",
  "group.select": "选择策略组成员",
  "ruleset.import": "导入规则集",
  "ruleset.refresh": "更新规则集",
  "ruleset.remove": "移除规则集",
};
function recoveryRoute(kind: string) {
  if (/subscription|node|group/.test(kind)) return "nodes";
  if (/ruleset/.test(kind)) return "rules";
  if (/extension/.test(kind)) return "extensions";
  if (/configuration/.test(kind)) return "settings";
  return "overview";
}
export function Activity({ snapshot, navigate }: FeatureProps) {
  const [query, setQuery] = useState(""),
    [state, setState] = useState("all"),
    [period, setPeriod] = useState("all");
  const [events, setEvents] = useState<
    {
      time: string;
      name: string;
      status: string;
      context: Partial<TraceContext>;
    }[]
  >([]);
  const task = useTask();
  const now = Date.now();
  const rows = snapshot.operations.filter(
    (o) =>
      (state === "all" || o.state === "failed" || o.state === "unknown") &&
      (period === "all" ||
        now - Date.parse(o.startedAt) <=
          (period === "hour" ? 3600000 : 86400000)) &&
      `${operationNames[o.kind] ?? o.kind} ${o.message ?? ""} ${o.id}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  return (
    <>
      <PageHeader title="操作记录" />
      <div className="resourcetools">
        <SearchField
          label="搜索操作"
          value={query}
          onChange={setQuery}
          placeholder="搜索操作或错误"
        />
        <Combobox
          label="操作结果"
          value={state}
          onChange={setState}
          options={[
            { value: "all", label: "全部结果" },
            { value: "failed", label: "失败与未知" },
          ]}
        />
        <Combobox
          label="操作时间"
          value={period}
          onChange={setPeriod}
          options={[
            { value: "all", label: "全部时间" },
            { value: "hour", label: "最近一小时" },
            { value: "day", label: "最近一天" },
          ]}
        />
      </div>
      <section className="operationlist" aria-label="操作列表">
        {rows.map((o) => (
          <details key={o.id} className="operationentry">
            <summary>
              <strong>{operationNames[o.kind] ?? o.kind}</strong>
              <time dateTime={o.startedAt}>
                {new Date(o.startedAt).toLocaleString()}
              </time>
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
            </summary>
            <div className="operationdetail">
              {o.message ? (
                <p
                  className={
                    o.state === "failed" ? "taskerror" : "inlinestatus"
                  }
                >
                  {o.message}
                </p>
              ) : null}
              {o.state === "failed" || o.state === "unknown" ? (
                <Button
                  className="secondary"
                  onClick={() => navigate(recoveryRoute(o.kind))}
                >
                  前往处理
                </Button>
              ) : null}
              <Disclosure title="技术详情">
                <p>修订 {o.revision}</p>
                <p>
                  操作编号：<code>{o.id}</code>
                </p>
                <p>
                  追踪编号：<code>{o.traceId}</code>
                </p>
              </Disclosure>
            </div>
          </details>
        ))}
        {!rows.length ? (
          <EmptyState
            title={
              snapshot.operations.length ? "没有匹配的操作" : "暂无操作记录"
            }
            icon="activity"
          >
            {snapshot.operations.length ? (
              <Button
                className="quiet"
                onClick={() => {
                  setQuery("");
                  setState("all");
                  setPeriod("all");
                }}
              >
                清除筛选
              </Button>
            ) : null}
          </EmptyState>
        ) : null}
      </section>
      <Disclosure title="服务诊断">
        <div className="sectionactions">
          <Button
            className="secondary"
            pending={task.pending}
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
          </Button>
          <InfoTip label="服务诊断说明">
            读取服务调用链，用于定位技术错误。普通操作失败可先展开上方记录，前往相关页面处理。
          </InfoTip>
        </div>
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
    </>
  );
}
