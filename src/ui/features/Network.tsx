import { client } from "../../../packages/client/src/index";
import { useDraft } from "../drafts";
import type { FeatureProps } from "../modules";
export function Network({ snapshot, save, run }: FeatureProps) {
  const draft = useDraft("network", { selected: "", dns: "" });
  const { selected, dns } = draft.value;
  const setSelected = (selected: string) => draft.change({ selected }),
    setDns = (dns: string) => draft.change({ dns });
  const c = snapshot.configuration;
  return (
    <>
      <h1>网络环境</h1>
      {draft.error ? <p role="alert">{draft.error}</p> : null}
      <p>
        HTTP / SOCKS 外部代理可在节点页导入。已有网络接口可作为独立的 TCP / UDP
        出口。
      </p>
      {snapshot.networkConflicts?.map((issue) => (
        <p key={issue.id} role="status" className="hint">
          {issue.message}
        </p>
      ))}
      {snapshot.network?.pacEnabled ? (
        <p role="status">
          系统正在使用 PAC。PAC
          会按目标动态选路，不能当作单一出口；本应用保留其设置，手动代理模式可独立使用。
        </p>
      ) : null}
      {(snapshot.network?.systemProxies?.length ?? 0) > 0 ? (
        <section className="panel">
          <h2>已观察的系统代理</h2>
          {snapshot.network!.systemProxies!.map((proxy) => (
            <div className="entry" key={proxy.kind}>
              <strong>
                {proxy.kind.toUpperCase()} · {proxy.host}:{proxy.port}
              </strong>
              <button
                className="secondary"
                disabled={
                  proxy.port === c.settings.listenPort &&
                  ["127.0.0.1", "localhost", "::1"].includes(proxy.host)
                }
                onClick={() =>
                  run(() =>
                    client.request("subscription.import", {
                      text: JSON.stringify([
                        {
                          type: proxy.kind === "socks" ? "socks" : "http",
                          server: proxy.host,
                          server_port: proxy.port,
                          tag: "系统代理 " + proxy.kind,
                        },
                      ]),
                    }),
                  )
                }
              >
                添加为可选出口
              </button>
            </div>
          ))}
        </section>
      ) : null}
      <section className="panel">
        <h2>绑定外部网络</h2>
        <p>
          明确选择接口与解析器，再在分流规则中选择该网络。接口消失时连接失败，不自动切换其他出口。
        </p>
        <form
          className="ruleform"
          onSubmit={(e) => {
            e.preventDefault();
            save({
              ...c,
              externalNetworks: [
                ...(c.externalNetworks ?? []),
                {
                  id: crypto.randomUUID(),
                  name: selected,
                  interface: selected,
                  dnsServer: dns,
                },
              ],
            });
          }}
        >
          <select
            aria-label="外部网络接口"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            required
          >
            <option value="">选择已观察的接口</option>
            {snapshot.network?.interfaces
              .filter((i) => i.name !== "lo0")
              .map((i) => (
                <option key={i.name} value={i.name}>
                  {i.name}
                </option>
              ))}
          </select>
          <input
            aria-label="外部网络 DNS"
            value={dns}
            onChange={(e) => setDns(e.target.value)}
            placeholder="udp://网络提供的DNS地址"
            required
          />
          <button className="primary">添加网络</button>
        </form>
        {(c.externalNetworks ?? []).map((n) => (
          <div className="entry" key={n.id}>
            <strong>{n.name}</strong>
            <code>{n.dnsServer}</code>
            <button
              className="quiet"
              onClick={() =>
                save({
                  ...c,
                  externalNetworks: c.externalNetworks?.filter(
                    (x) => x.id !== n.id,
                  ),
                  rules: c.rules.filter((r) => r.outbound !== n.id),
                  settings: {
                    ...c.settings,
                    selectedNode:
                      c.settings.selectedNode === n.id
                        ? "direct"
                        : c.settings.selectedNode,
                    finalOutbound:
                      c.settings.finalOutbound === n.id
                        ? "select"
                        : c.settings.finalOutbound,
                  },
                })
              }
            >
              移除
            </button>
          </div>
        ))}
      </section>
      {!snapshot.network ? (
        <div className="empty">点击右上角刷新，读取本机网络状态。</div>
      ) : (
        <>
          <section className="panel">
            <h2>接口与地址</h2>
            {snapshot.network.interfaces.map((i) => (
              <div className="detailrow" key={i.name}>
                <code>{i.name}</code>
                <span>{i.addresses.join(" · ")}</span>
              </div>
            ))}
          </section>
          <section className="panel">
            <h2>外部软件</h2>
            {snapshot.network.plugins.map((p) => (
              <div className="entry" key={p.id}>
                <strong>{p.name}</strong>
                <p>{p.detail}</p>
              </div>
            ))}
          </section>
          {snapshot.network.warnings.map((w) => (
            <p key={w} className="hint">
              {w}
            </p>
          ))}
        </>
      )}
    </>
  );
}
