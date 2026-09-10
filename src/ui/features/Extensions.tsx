import {
  Button,
  Toggle,
  PageHeader,
  SearchField,
  EmptyState,
  Disclosure,
  TaskError,
} from "../components";
import { useEffect, useRef, useState } from "react";
import { Icon } from "../icons";
import { client } from "../../../packages/client/src/index";
import type { ExtensionState } from "../../../packages/contracts/src/extensions";
import type { TraceContext } from "../../../packages/contracts/src/index";
import type { FeatureProps } from "../modules";

const labels: Record<ExtensionState["status"], string> = {
  ready: "运行中",
  stopped: "已停用",
  starting: "启动中",
  draining: "停用中",
  failed: "运行异常",
  unavailable: "状态未知",
};
const summaries: Record<string, string> = {
  "builtin.tailscale": "检查 Tailscale 连接，帮助排查网络共存问题。",
  "builtin.singbox": "检查 GUI.for.SingBox 是否安装和运行。",
};
const permissions: Record<string, string> = {
  "subscription.https.read": "下载你提供的 HTTPS 订阅；不执行其中的代码。",
  "system.network.read": "只读查看本机接口、路由、DNS 和系统代理。",
  "application.status.read": "只读检查本机应用安装位置、进程及其状态接口。",
};
type Event = {
  name: string;
  time: string;
  status: string;
  context: Partial<TraceContext>;
};
export function Extensions({ snapshot, run, busy, navigate }: FeatureProps) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState("");
  const [showCore, setShowCore] = useState(false);
  const [pending, setPending] = useState("");
  const operation = useRef(false);
  const [feedback, setFeedback] = useState<Record<string, string>>({});
  const opener = useRef<HTMLButtonElement | null>(null);
  const detailHeading = useRef<HTMLHeadingElement | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [eventOwner, setEventOwner] = useState("");
  const entries = snapshot.extensions ?? [];
  const visible = entries.filter((entry) =>
    `${entry.name} ${entry.description}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const optional = visible.filter((entry) => !entry.required);
  const core = visible.filter((entry) => entry.required);
  const detail = entries.find((entry) => entry.id === selected);
  const unhealthy = (entry: ExtensionState) =>
    ["failed", "unavailable"].includes(entry.status);
  const coreError = core.some(unhealthy);
  const unavailable = entries.some(unhealthy);
  const closeDetail = () => {
    setSelected("");
    requestAnimationFrame(() => opener.current?.focus());
  };
  useEffect(() => {
    if (!selected) return;
    detailHeading.current?.focus({ preventScroll: true });
    const escape = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        document.querySelector("dialog[open]")
      )
        return;
      closeDetail();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [selected]);
  const change = async (entry: ExtensionState, retry = false) => {
    if (
      operation.current ||
      busy ||
      ["starting", "draining", "unavailable"].includes(entry.status)
    )
      return;
    operation.current = true;
    setPending(entry.id);
    setFeedback((current) => ({ ...current, [entry.id]: "" }));
    try {
      await run(async () => {
        try {
          await client.request("extensions.setEnabled", {
            id: entry.id,
            enabled: retry || !entry.desiredEnabled,
            revision: snapshot.extensionRevision,
          });
        } catch (error) {
          setFeedback((current) => ({
            ...current,
            [entry.id]:
              error instanceof Error ? error.message : "操作失败，请重试。",
          }));
        }
      });
    } finally {
      operation.current = false;
      setPending("");
    }
  };
  const row = (entry: ExtensionState) => {
    const changing =
      pending === entry.id || ["starting", "draining"].includes(entry.status);
    const locked =
      busy || !!pending || entry.status === "unavailable" || changing;
    return (
      <article
        key={entry.id}
        aria-label={entry.name}
        className={`extensioncard ${selected === entry.id ? "selected" : ""}`}
      >
        <span className="extensionicon" aria-hidden="true">
          <Icon name={entry.required ? "extensions" : "network"} size={20} />
        </span>
        <div className="extensioncopy">
          <Button
            className="extensionname"
            aria-label={`查看 ${entry.name} 详情`}
            aria-expanded={selected === entry.id}
            onClick={(event) => {
              opener.current = event.currentTarget;
              setSelected(entry.id);
            }}
          >
            <h3>{entry.name}</h3>
            <Icon name="chevron" size={12} />
          </Button>
          <p>{summaries[entry.id] ?? entry.description}</p>
          {unhealthy(entry) || changing ? (
            <span className="extensionstate" role="status">
              {changing
                ? entry.desiredEnabled
                  ? "正在应用更改…"
                  : "正在停用…"
                : labels[entry.status]}
            </span>
          ) : null}
          <TaskError message={feedback[entry.id] || entry.error} />
          {entry.status === "unavailable" ? (
            <p>连接恢复后将确认实际状态，已保存的偏好保持不变。</p>
          ) : null}
        </div>
        <div className="extensioncontrols">
          {entry.required ? (
            <span className="hint">始终启用</span>
          ) : (
            <>
              {entry.status === "failed" ? (
                <Button
                  className="quiet"
                  pending={locked}
                  onClick={() => void change(entry, true)}
                >
                  重试启用
                </Button>
              ) : null}
              <span className="extensionpreference">
                {entry.desiredEnabled ? "已启用" : "已停用"}
              </span>
              <Toggle
                type="checkbox"
                role="switch"
                className="switchinput"
                aria-label={`启用 ${entry.name}`}
                checked={entry.desiredEnabled}
                pending={locked}
                onChange={() => {
                  if (!locked) void change(entry);
                }}
              />
            </>
          )}
        </div>
      </article>
    );
  };
  return (
    <div className="extensionspage">
      <PageHeader title="扩展">
        <Button className="secondary" onClick={() => navigate("updates")}>
          管理更新
        </Button>
      </PageHeader>
      {entries.length >= 10 ? (
        <div className="tabletools extensionfilters">
          <SearchField
            label="搜索扩展"
            placeholder="搜索名称或功能"
            value={query}
            onChange={setQuery}
          />
        </div>
      ) : null}
      <div className={`extensionworkspace ${detail ? "hasdetail" : ""}`}>
        <div className="extensioncatalog">
          {!entries.length ? (
            <EmptyState
              icon="extensions"
              title="暂无扩展目录"
              description="当前服务未提供扩展目录，请稍后重试。"
            />
          ) : !visible.length ? (
            <EmptyState
              icon="extensions"
              title="没有匹配的扩展"
              description="试试其他关键词。"
            >
              <Button className="quiet" onClick={() => setQuery("")}>
                清除筛选
              </Button>
            </EmptyState>
          ) : (
            <>
              <div className="extensionsectionheading">
                <h2>可选扩展</h2>
                <span>{optional.length} 项</span>
              </div>
              <p className="extensionsectionhint">
                停用只会关闭对应诊断，不影响代理连接或外部应用。
              </p>
              <div className="extensionlist">{optional.map(row)}</div>
              <section className="extensioncore">
                <Button
                  className="extensioncoretoggle"
                  aria-expanded={showCore || coreError || !!query}
                  onClick={() => setShowCore((value) => !value)}
                >
                  <Icon name="chevron" size={14} />
                  <span>核心能力</span>
                  <small>
                    {core.length} 项 ·{" "}
                    {coreError ? "需要处理" : "由 FlowGate 自动管理"}
                  </small>
                </Button>
                {coreError ? (
                  <p className="taskerror" role="alert">
                    部分核心能力不可用，请查看详情或尝试恢复。
                  </p>
                ) : null}
                {showCore || coreError || query ? (
                  <div className="extensionlist">{core.map(row)}</div>
                ) : null}
              </section>
              <p className="extensionfooter">官方内置 · 随应用版本组合更新</p>
            </>
          )}
        </div>
        {detail ? (
          <section
            key={detail.id}
            className="panel extensiondetail"
            aria-label="扩展详情"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                closeDetail();
              }
            }}
          >
            <div className="extensiondetailheader">
              <Button className="quiet extensionclose" onClick={closeDetail}>
                返回扩展列表
              </Button>
              <small>扩展详情</small>
              <h2 ref={detailHeading} tabIndex={-1}>
                {detail.name}
              </h2>
            </div>
            <p>{detail.description}</p>
            <dl>
              <dt>发布者</dt>
              <dd>FlowGate · 官方内置</dd>
              <dt>版本</dt>
              <dd>{detail.version}</dd>
              <dt>当前状态</dt>
              <dd>{labels[detail.status]}</dd>
              <dt>启用偏好</dt>
              <dd>{detail.desiredEnabled ? "启用" : "停用"} · 已保存到本机</dd>
            </dl>
            <h3>访问范围</h3>
            <ul>
              {detail.permissions.length ? (
                detail.permissions.map((permission) => (
                  <li key={permission}>
                    {permissions[permission] ?? permission}
                  </li>
                ))
              ) : (
                <li>只处理传入的数据，不申请系统设置或凭据访问。</li>
              )}
            </ul>
            <h3>依赖</h3>
            <p>
              {detail.dependencies.length
                ? detail.dependencies
                    .map(
                      (id) =>
                        entries.find((entry) => entry.id === id)?.name ?? id,
                    )
                    .join("、")
                : "无其他扩展依赖"}
            </p>
            {snapshot.network?.plugins.find(
              (plugin) => plugin.id === detail.id,
            ) ? (
              <>
                <h3>最近诊断结果</h3>
                <p>
                  {
                    snapshot.network.plugins.find(
                      (plugin) => plugin.id === detail.id,
                    )?.detail
                  }
                </p>
              </>
            ) : null}
            <h3>管理方式</h3>
            <p>
              {detail.required
                ? "此能力用于代理客户端的基础功能，不能单独停用。"
                : "停用会取消并排空此扩展的任务，不会关闭外部应用，也不会停止代理内核。"}
            </p>
            <Disclosure title="技术信息与故障追踪">
              <dl>
                <dt>标识</dt>
                <dd>{detail.id}</dd>
                <dt>运行位置</dt>
                <dd>独立扩展宿主</dd>
                <dt>版本组合</dt>
                <dd>{detail.releaseSet}</dd>
                <dt>实例</dt>
                <dd>{detail.instance ?? "尚无运行实例"}</dd>
                <dt>贡献</dt>
                <dd>
                  {detail.contributions.includes("command") ? "业务命令" : "无"}
                </dd>
              </dl>
              <Button
                className="secondary"
                pending={Boolean(busy)}
                onClick={() =>
                  void run(async () => {
                    const all = (await window.shell.request(
                      "diagnostics.trace",
                    )) as Event[];
                    setEvents(
                      all.filter(
                        (event) =>
                          event.name === detail.id ||
                          event.context.pluginInstance?.startsWith(
                            detail.id + ":",
                          ),
                      ),
                    );
                    setEventOwner(detail.id);
                  })
                }
              >
                读取此扩展诊断
              </Button>
              {eventOwner === detail.id ? (
                events.length ? (
                  <ol className="extensionevents">
                    {events
                      .slice(-12)
                      .reverse()
                      .map((event, index) => (
                        <li key={index}>
                          <span>
                            {new Date(event.time).toLocaleTimeString()} ·{" "}
                            {event.status}
                          </span>
                          <small>
                            {event.context.traceId ??
                              event.context.pluginInstance}
                          </small>
                        </li>
                      ))}
                  </ol>
                ) : (
                  <p>暂无此扩展的诊断事件。</p>
                )
              ) : null}
            </Disclosure>
          </section>
        ) : null}
      </div>

      {unavailable ? (
        <section className="panel">
          <h2>扩展恢复</h2>
          <p>
            重启扩展宿主会中止正在进行的解析或诊断任务，并重新应用已保存的启用偏好。现有代理转发保持运行。
          </p>
          <Button
            className="secondary"
            pending={Boolean(busy)}
            onClick={() =>
              void run(() =>
                client.request("extensions.restart", {
                  revision: snapshot.extensionRevision,
                }),
              )
            }
          >
            重启扩展宿主
          </Button>
        </section>
      ) : null}
    </div>
  );
}
