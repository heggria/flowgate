import type { FeatureProps } from "../modules";
import { mutation } from "../../../packages/client/src/index";
import { useDraft } from "../drafts";
export function RuleSources({ snapshot, run, busy }: FeatureProps) {
  const draft = useDraft("rule-source", {
    name: "",
    url: "",
    format: "domain-list",
    outbound: "direct",
  });
  return (
    <section className="panel">
      <h2>规则集来源</h2>
      <p className="hint">
        支持域名列表与单条件 sing-box JSON 规则。组合条件和其他类型会明确拒绝。
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            await mutation("ruleset.import", draft.value);
            await draft.clear({ ...draft.value, name: "", url: "" });
          });
        }}
      >
        <label>
          名称
          <input
            required
            value={draft.value.name}
            onChange={(event) => draft.change({ name: event.target.value })}
          />
        </label>
        <label>
          HTTPS 来源
          <input
            required
            type="url"
            value={draft.value.url}
            placeholder="https://…"
            onChange={(event) => draft.change({ url: event.target.value })}
          />
        </label>
        <div className="twocol">
          <label>
            格式
            <select
              value={draft.value.format}
              onChange={(event) => draft.change({ format: event.target.value })}
            >
              <option value="domain-list">域名列表</option>
              <option value="sing-box-json">sing-box JSON</option>
            </select>
          </label>
          <label>
            规则出口
            <select
              value={draft.value.outbound}
              onChange={(event) =>
                draft.change({ outbound: event.target.value })
              }
            >
              <option value="direct">直连</option>
              <option value="block">阻断</option>
              <option value="select">所选节点</option>
              {snapshot.configuration.nodes.map((node) => (
                <option key={node.id} value={node.id}>
                  {node.name}
                </option>
              ))}
              {snapshot.configuration.externalNetworks?.map((network) => (
                <option key={network.id} value={network.id}>
                  {network.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        {draft.error ? <p role="alert">{draft.error}</p> : null}
        <button disabled={busy || !draft.ready} className="secondary">
          导入规则集
        </button>
      </form>
      {snapshot.configuration.ruleSources?.map((source) => (
        <div className="entry" key={source.id}>
          <div>
            <strong>{source.name}</strong>
            <small>
              {source.count} 条 ·{" "}
              {source.updatedAt
                ? new Date(source.updatedAt).toLocaleString()
                : "尚未更新"}
            </small>
            {source.error ? <p role="alert">{source.error}</p> : null}
          </div>
          <button
            className="quiet"
            disabled={busy}
            onClick={() =>
              run(() => mutation("ruleset.refresh", { id: source.id }))
            }
          >
            更新
          </button>
          <button
            className="quiet"
            disabled={busy}
            onClick={() =>
              run(() => mutation("ruleset.remove", { id: source.id }))
            }
          >
            移除规则集
          </button>
        </div>
      ))}
    </section>
  );
}
