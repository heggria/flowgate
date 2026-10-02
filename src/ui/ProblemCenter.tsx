import { RecoveryLinks } from "./RecoveryLinks";
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  problems,
  adviseFailure,
  safeMessage,
  type Problem,
} from "../../packages/client/src/problems";
import { Icon } from "./icons";
import { Button, PageHeader } from "./components";
const operationLabels: Record<string, string> = {
  "proxy.connect": "启动代理",
  "proxy.disconnect": "停止代理",
  "helper.install": "安装辅助服务",
  "helper.status": "检查辅助服务",
  snapshot: "连接业务服务",
  "kernel.state": "代理运行状态",
  workspace: "工作区",
  "configuration.save": "保存配置",
};
function ProblemCard({ problem }: { problem: Problem }) {
  const advice = adviseFailure(problem.message);
  const [copied, setCopied] = useState(false);
  return (
    <article className="problemcard" aria-label={advice.title}>
      <div className="problemheading">
        <strong>{advice.title}</strong>
        <span>
          {problem.resolved ? "后续操作已成功" : "待处理"} ·{" "}
          {operationLabels[problem.method] ?? "应用操作"}
        </span>
      </div>
      <p>{advice.guidance}</p>
      <RecoveryLinks message={problem.message} />
      <details>
        <summary>
          错误详情{problem.count > 1 ? ` · 已出现 ${problem.count} 次` : ""}
        </summary>
        <pre>{problem.message}</pre>
        <small>
          {problem.time} · {advice.code} · {problem.method}
        </small>
        <Button
          type="button"
          className="quiet"
          onClick={() => {
            void navigator.clipboard
              .writeText(
                `${advice.code}\n${problem.method}\n${problem.time}\n${safeMessage(problem.message)}`,
              )
              .then(() => setCopied(true))
              .catch((error) => problems.report("diagnostics.copy", error));
          }}
        >
          {copied ? "已复制" : "复制脱敏详情"}
        </Button>
      </details>
    </article>
  );
}
export function ProblemNavigation({
  selected,
  navigate,
}: {
  selected: boolean;
  navigate: () => void;
}) {
  const entries = useSyncExternalStore(problems.subscribe, problems.snapshot);
  const pending = entries.filter((p) => !p.resolved).length;
  if (!entries.length) return null;
  return (
    <Button
      type="button"
      className={`nav problemnav ${selected ? "active" : ""}`}
      aria-label="问题与恢复"
      aria-current={selected ? "page" : undefined}
      onClick={navigate}
    >
      <Icon name="problems" />
      <span>问题与恢复</span>
      <small className={pending ? "problembadge" : ""}>
        {pending || entries.length}
      </small>
    </Button>
  );
}
export function ProblemNotification({
  navigate,
  selected,
}: {
  navigate: () => void;
  selected: boolean;
}) {
  const entries = useSyncExternalStore(problems.subscribe, problems.snapshot);
  const latest = entries.find((p) => !p.resolved && !p.dismissed);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    setVisible(Boolean(latest));
    const timer = window.setTimeout(() => setVisible(false), 7000);
    return () => window.clearTimeout(timer);
  }, [latest?.id, latest?.time]);
  useEffect(() => {
    if (selected) setVisible(false);
  }, [selected]);
  if (!latest || !visible || selected) return null;
  return (
    <div className="problemtoast" role="alert">
      <Icon name="problems" />
      <span>{adviseFailure(latest.message).title}</span>
      <Button
        type="button"
        className="quiet"
        onClick={() => {
          setVisible(false);
          navigate();
        }}
      >
        查看问题
      </Button>
      <Button
        type="button"
        className="iconbutton"
        aria-label="关闭错误"
        onClick={() => {
          setVisible(false);
          problems.dismiss(latest.id);
        }}
      >
        <Icon name="close" size={14} />
      </Button>
    </div>
  );
}
export function ProblemPage() {
  const entries = useSyncExternalStore(problems.subscribe, problems.snapshot);
  const [filter, setFilter] = useState("pending");
  const pending = entries.filter((p) => !p.resolved);
  const shown = filter === "pending" ? pending : entries;
  return (
    <div className="problemspage">
      <PageHeader
        title="问题与恢复"
        description="查看本次会话的问题，按提示完成处理。"
      />
      <div className="problemfilters" role="group" aria-label="筛选问题">
        <Button
          type="button"
          className={filter === "pending" ? "secondary" : "quiet"}
          aria-pressed={filter === "pending"}
          onClick={() => setFilter("pending")}
        >
          待处理 {pending.length}
        </Button>
        <Button
          type="button"
          className={filter === "all" ? "secondary" : "quiet"}
          aria-pressed={filter === "all"}
          onClick={() => setFilter("all")}
        >
          全部记录 {entries.length}
        </Button>
      </div>
      {shown.length ? (
        <section className="problemlist" aria-label="问题列表">
          {shown.map((p) => (
            <ProblemCard key={p.id} problem={p} />
          ))}
        </section>
      ) : (
        <div className="empty">
          <Icon name="problems" size={28} />
          <h2>{filter === "pending" ? "暂无待处理问题" : "暂无问题记录"}</h2>
          <p>出现新问题时，侧边栏会显示数量，你可以随时回来查看。</p>
        </div>
      )}
    </div>
  );
}
