import { useState } from "react";
import { client } from "../../../packages/client/src/index";
import type { ExtensionState } from "../../../packages/contracts/src/extensions";
import type { TraceContext } from "../../../packages/contracts/src/index";
import type { FeatureProps } from "../modules";
import { ReleaseUpdates } from "./ReleaseUpdates";

const labels: Record<ExtensionState["status"], string> = {
  ready: "运行中",
  stopped: "已停用",
  starting: "启动中",
  draining: "停用中",
  failed: "运行异常",
  unavailable: "状态未知",
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
export function Extensions({ snapshot, run, busy }: FeatureProps) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState("");
  const [events, setEvents] = useState<Event[]>([]);
  const [eventOwner, setEventOwner] = useState("");
  const entries = snapshot.extensions ?? [];
  const visible = entries.filter(
    (entry) =>
      (filter === "all" ||
        (filter === "core" ? entry.required : !entry.required)) &&
      `${entry.name} ${entry.id} ${entry.description}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const detail = visible.find((entry) => entry.id === selected) ?? visible[0];
  const change = (entry: ExtensionState) =>
    run(() =>
      client.request("extensions.setEnabled", {
        id: entry.id,
        enabled: entry.status === "failed" ? true : !entry.desiredEnabled,
        revision: snapshot.extensionRevision,
      }),
    );
  const unavailable = entries.some(
    (entry) => entry.status === "failed" || entry.status === "unavailable",
  );
  return (
    <>
      <div className="pageintro">
        <h1>扩展</h1>
        <p>查看内置能力、运行状态与访问范围，管理可选扩展。</p>
      </div>
      <div className="extensionoverview">
        <span>{entries.length} 个内置扩展</span>
        <span>
          {entries.filter((entry) => entry.status === "ready").length} 个运行中
        </span>
        <span>官方内置 · 随版本组合更新</span>
      </div>
      <div className="tabletools extensionfilters">
        <input
          aria-label="搜索扩展"
          placeholder="搜索扩展名称或功能"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <select
          aria-label="扩展类型"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        >
          <option value="all">全部扩展</option>
          <option value="core">核心能力</option>
          <option value="optional">可选扩展</option>
        </select>
      </div>
      {!entries.length ? (
        <div className="empty">
          当前服务未提供扩展目录。请通过设置检查完整应用更新。
        </div>
      ) : !visible.length ? (
        <div className="empty">
          没有匹配的扩展
          <button
            className="quiet"
            onClick={() => {
              setQuery("");
              setFilter("all");
            }}
          >
            清除筛选
          </button>
        </div>
      ) : (
        <div className="extensionworkspace">
          <div className="extensionlist">
            {visible.map((entry) => (
              <article
                key={entry.id}
                aria-label={entry.name}
                className={`extensioncard ${detail?.id === entry.id ? "selected" : ""}`}
              >
                <div className="extensionheading">
                  <h2>{entry.name}</h2>
                  <span
                    className={`badge ${entry.status === "failed" ? "extensionerror" : ""}`}
                  >
                    {labels[entry.status]}
                  </span>
                </div>
                <p>{entry.description}</p>
                <small>
                  {entry.required ? "核心能力 · 始终启用" : "可选扩展"} · v
                  {entry.version}
                </small>
                {entry.error ? (
                  <p className="extensionerror">{entry.error}</p>
                ) : null}
                <div className="formactions">
                  <button
                    className="quiet"
                    aria-pressed={detail?.id === entry.id}
                    onClick={() => setSelected(entry.id)}
                  >
                    查看详情
                  </button>
                  {entry.required ? (
                    <span className="hint">由应用管理</span>
                  ) : (
                    <button
                      className="secondary"
                      disabled={
                        busy ||
                        ["starting", "draining", "unavailable"].includes(
                          entry.status,
                        )
                      }
                      onClick={() => void change(entry)}
                    >
                      {entry.status === "failed"
                        ? "重试启用"
                        : entry.desiredEnabled
                          ? "停用"
                          : "启用"}
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
          {detail ? (
            <section className="panel extensiondetail" aria-label="扩展详情">
              <small>扩展详情</small>
              <h2>{detail.name}</h2>
              <p>{detail.description}</p>
              <dl>
                <dt>发布者</dt>
                <dd>FlowGate · 官方内置</dd>
                <dt>版本</dt>
                <dd>{detail.version}</dd>
                <dt>当前状态</dt>
                <dd>{labels[detail.status]}</dd>
                <dt>启用偏好</dt>
                <dd>
                  {detail.desiredEnabled ? "启用" : "停用"} · 已保存到本机
                </dd>
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
              <p className="hint">
                首版仅运行受信的内置扩展，不支持导入第三方代码。访问清单用于审计，不代表不可信代码沙箱。
              </p>
              <details>
                <summary>技术信息与故障追踪</summary>
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
                    {detail.contributions.includes("command")
                      ? "业务命令"
                      : "无"}
                  </dd>
                </dl>
                <button
                  className="secondary"
                  disabled={busy}
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
                </button>
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
              </details>
            </section>
          ) : null}
        </div>
      )}
      {unavailable ? (
        <section className="panel">
          <h2>扩展恢复</h2>
          <p>
            重启扩展宿主会中止正在进行的解析或诊断任务，并重新应用已保存的启用偏好。现有代理转发保持运行。
          </p>
          <button
            className="secondary"
            disabled={busy}
            onClick={() =>
              void run(() =>
                client.request("extensions.restart", {
                  revision: snapshot.extensionRevision,
                }),
              )
            }
          >
            重启扩展宿主
          </button>
        </section>
      ) : null}
      <ReleaseUpdates run={run} busy={busy} extensions={entries} />
    </>
  );
}
