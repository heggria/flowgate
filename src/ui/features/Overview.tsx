import type { FeatureProps } from "../modules";
import { mutation } from "../../../packages/client/src/index";
import { Traffic } from "./Traffic";
import { TrafficChart } from "./TrafficChart";
import { Icon } from "../icons";
import { bytes, modeLabels } from "../format";
export function Overview({
  snapshot,
  save,
  run,
  navigate,
  busy,
  detailPanels,
}: FeatureProps) {
  const c = snapshot.configuration,
    connected = snapshot.kernel.status === "running",
    t = snapshot.traffic;
  const available = connected && t?.available,
    total = available ? t.upload + t.download : null;
  const active = available
    ? (t.activeConnections ??
      t.flows.filter((f) => f.state === "active").length)
    : connected
      ? null
      : 0;
  const pending = connected && snapshot.kernel.appliedRevision !== c.revision;
  const metrics = [
    {
      label: "下载速率",
      value: bytes(available ? t.downloadRate : null),
      unit: available && t.downloadRate != null ? "/s" : "",
      icon: "down",
      hint: available ? `累计 ${bytes(t.download)}` : "等待采样",
      cls: "download",
    },
    {
      label: "上传速率",
      value: bytes(available ? t.uploadRate : null),
      unit: available && t.uploadRate != null ? "/s" : "",
      icon: "up",
      hint: available ? `累计 ${bytes(t.upload)}` : "等待采样",
      cls: "upload",
    },
    {
      label: "活跃连接",
      value: active ?? "—",
      unit: "",
      icon: "connections",
      hint: available
        ? `最近记录 ${t.flows.length} 条`
        : connected
          ? "等待采样"
          : "代理未启动",
      cls: "",
    },
    {
      label: "会话流量",
      value: bytes(total),
      unit: "",
      icon: "network",
      hint: "本次内核运行累计",
      cls: "",
    },
  ];
  const names = (id: string): string =>
    id === "select"
      ? names(c.settings.selectedNode)
      : (c.nodes.find((n) => n.id === id)?.name ??
        c.externalNetworks?.find((n) => n.id === id)?.name ??
        (id === "direct" ? "直连" : id === "proxy" ? "代理" : id));
  return (
    <>
      <div className="pageheading">
        <div>
          <h1>概览</h1>
          <span className="subtle">本机代理</span>
        </div>
        <span className="livecaption">
          <i className={available ? "dot online" : "dot"} />
          {available ? "实时更新" : connected ? "连接遥测中" : "尚未启动"}
        </span>
      </div>
      <section className="metrics" aria-label="运行指标">
        {metrics.map((m) => (
          <div className="metric" key={m.label}>
            <div className="metriclabel">
              <Icon name={m.icon} />
              {m.label}
            </div>
            <div className={`metricvalue ${m.cls}`}>
              {m.value}
              <small>{m.unit}</small>
            </div>
            <div className="metrichint">{m.hint}</div>
          </div>
        ))}
      </section>
      <div className="dashboardgrid">
        <TrafficChart traffic={t} running={connected} />
        <section className="panel exitpanel">
          <div className="paneltitle">
            <h2>代理出口</h2>
            <button
              className="iconbutton"
              aria-label="管理节点"
              onClick={() => navigate("nodes")}
            >
              <Icon name="nodes" />
            </button>
          </div>
          <label className="sr-only" htmlFor="outbound">
            选择代理节点
          </label>
          <select
            id="outbound"
            disabled={busy}
            value={c.settings.selectedNode}
            onChange={(e) =>
              save({
                ...c,
                settings: { ...c.settings, selectedNode: e.target.value },
              })
            }
          >
            <option value="direct">直接连接</option>
            {c.nodes.map((n) => (
              <option key={n.id} value={n.id}>
                {n.name}
              </option>
            ))}
            {(c.externalNetworks ?? []).map((n) => (
              <option key={n.id} value={n.id}>
                {n.name}
              </option>
            ))}
          </select>
          <dl className="settingslist">
            <dt>接入方式</dt>
            <dd>
              <button
                className="inlineaction"
                onClick={() => navigate("settings")}
              >
                {modeLabels[c.settings.mode]} <Icon name="chevron" size={12} />
              </button>
            </dd>
            <dt>监听地址</dt>
            <dd className="mono">127.0.0.1:{c.settings.listenPort}</dd>
            <dt>分流规则</dt>
            <dd>
              <button
                className="inlineaction"
                onClick={() => navigate("rules")}
              >
                {c.rules.length} 条 <Icon name="chevron" size={12} />
              </button>
            </dd>
            <dt>配置状态</dt>
            <dd>{pending ? "待应用" : connected ? "已应用" : "未应用"}</dd>
          </dl>
          {pending ? (
            <button
              className="secondary applybutton"
              disabled={busy}
              onClick={() => run(() => mutation("proxy.connect"))}
            >
              应用配置
            </button>
          ) : (
            <div className="exitnote">
              <Icon name="arrow" size={14} />
              <span>默认出口 · {names(c.settings.finalOutbound)}</span>
            </div>
          )}
        </section>
      </div>
      <div className="dashboardgrid lowergrid">
        <Traffic
          traffic={t}
          configuration={c}
          detailPanels={detailPanels}
          compact
          onExpand={() => navigate("connections")}
        />
        <section className="panel environmentpanel">
          <div className="paneltitle">
            <h2>网络状态</h2>
            <button
              className="iconbutton"
              aria-label="查看网络环境"
              onClick={() => navigate("network")}
            >
              <Icon name="chevron" size={14} />
            </button>
          </div>
          <dl className="settingslist">
            <dt>默认接口</dt>
            <dd className="mono">
              {snapshot.network?.defaultInterface ?? "未检测"}
            </dd>
            <dt>系统代理</dt>
            <dd>
              {snapshot.network?.proxyEnabled == null
                ? "未检测"
                : snapshot.network.proxyEnabled
                  ? "已开启"
                  : "未开启"}
            </dd>
            <dt>DNS</dt>
            <dd className="mono" title={c.settings.dnsServer}>
              {c.settings.dnsServer}
            </dd>
            <dt>外部网络</dt>
            <dd>{c.externalNetworks?.length ?? 0} 个</dd>
          </dl>
          <div className="smallsection">
            <span>资源</span>
            <div className="resourcecounts">
              <button onClick={() => navigate("nodes")}>
                <strong>{c.nodes.length}</strong>
                <small>节点</small>
              </button>
              <button onClick={() => navigate("nodes")}>
                <strong>{c.subscriptions.length}</strong>
                <small>订阅</small>
              </button>
              <button onClick={() => navigate("activity")}>
                <strong>
                  {
                    snapshot.operations.filter(
                      (o) => o.state === "failed" || o.state === "unknown",
                    ).length
                  }
                </strong>
                <small>近期异常</small>
              </button>
            </div>
          </div>
        </section>
      </div>
      {snapshot.kernel.status === "failed" ||
      snapshot.kernel.status === "unknown" ? (
        <div className="alert" role="alert">
          {snapshot.kernel.message ?? "代理状态异常，请查看操作记录"}
          <button onClick={() => navigate("activity")}>查看记录</button>
        </div>
      ) : null}
    </>
  );
}
