import { useDraft } from "../drafts";
import type {
  Configuration,
  Rule,
} from "../../../packages/contracts/src/index";
export function Rules({
  config,
  save,
}: {
  config: Configuration;
  save: (c: Configuration) => Promise<boolean>;
}) {
  const draft = useDraft("rules", {
    value: "",
    kind: "domain_suffix" as Rule["kind"],
    outbound: "direct",
  });
  const { value, kind, outbound } = draft.value;
  const setValue = (value: string) => draft.change({ value });
  const setKind = (kind: Rule["kind"]) => draft.change({ kind });
  const setOutbound = (outbound: string) => draft.change({ outbound });
  const outboundName = (id: string) =>
    ({ direct: "直连", select: "所选节点", block: "阻断" })[id] ??
    config.nodes.find((node) => node.id === id)?.name ??
    config.externalNetworks?.find((network) => network.id === id)?.name ??
    "不可用出口";
  const kindName = {
    domain_suffix: "域名后缀",
    domain: "完整域名",
    ip_cidr: "IP 网段",
    process_name: "进程名称",
  };
  return (
    <>
      <h1>分流规则</h1>
      {draft.error ? <p role="alert">{draft.error}</p> : null}
      <p>按顺序匹配，将流量发送至指定出口。</p>
      <section className="panel">
        <form
          className="ruleform"
          onSubmit={async (e) => {
            e.preventDefault();
            const saved = await save({
              ...config,
              rules: [
                ...config.rules,
                { id: crypto.randomUUID(), kind, value, outbound },
              ],
            });
            if (saved) await draft.clear({ ...draft.value, value: "" });
          }}
        >
          <select
            aria-label="匹配类型"
            value={kind}
            onChange={(e) => setKind(e.target.value as Rule["kind"])}
          >
            <option value="domain_suffix">域名后缀</option>
            <option value="domain">完整域名</option>
            <option value="ip_cidr">IP 网段</option>
            <option value="process_name">进程名称</option>
          </select>
          <input
            aria-label="匹配内容"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="example.com"
            required
          />
          <select
            aria-label="规则出口"
            value={outbound}
            onChange={(e) => setOutbound(e.target.value)}
          >
            <option value="direct">直连</option>
            <option value="select">所选节点</option>
            <option value="block">阻断</option>
            {config.nodes.map((n) => (
              <option key={n.id} value={n.id}>
                {n.name}
              </option>
            ))}
            {(config.externalNetworks ?? []).map((n) => (
              <option key={n.id} value={n.id}>
                网络 · {n.name}
              </option>
            ))}
          </select>
          <button className="primary" disabled={!draft.ready}>
            添加规则
          </button>
        </form>
      </section>
      {config.rules.map((r, index) => (
        <div className="entry" key={r.id}>
          <span className="index">{index + 1}</span>
          <span>{kindName[r.kind]}</span>
          <strong>{r.value}</strong>
          <span>→ {outboundName(r.outbound)}</span>
          <button
            className="quiet"
            onClick={() =>
              save({
                ...config,
                rules: config.rules.filter((x) => x.id !== r.id),
              })
            }
          >
            删除
          </button>
        </div>
      ))}
      <div className="entry">
        <span>默认规则</span>
        <strong>
          其余流量 → {outboundName(config.settings.finalOutbound)}
        </strong>
      </div>
    </>
  );
}
