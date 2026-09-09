import { useState, useEffect } from "react";
import type {
  Configuration,
  NodeConfig,
} from "../../../packages/contracts/src/index";
import { mutation, client } from "../../../packages/client/src/index";
import { useDraft } from "../drafts";
function NodeEditor({
  node,
  revision,
  run,
  close,
}: {
  node: NodeConfig;
  revision: number;
  run: (fn: () => Promise<unknown>) => Promise<void>;
  close: () => void;
}) {
  const draft = useDraft("node-editor", {
    id: node.id,
    name: node.name,
    server: node.server,
    port: node.port,
  });
  const match = draft.value.id === node.id,
    value = match ? draft.value : node;
  return (
    <form
      className="panel"
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          await mutation("node.update", { ...value, revision });
          await draft.clear({
            id: node.id,
            name: value.name,
            server: value.server,
            port: value.port,
          });
          close();
        });
      }}
    >
      <h2>编辑节点</h2>
      <label>
        名称
        <input
          aria-label="节点名称"
          required
          maxLength={100}
          value={value.name}
          onChange={(e) => draft.change({ ...value, name: e.target.value })}
        />
      </label>
      <div className="twocol">
        <label>
          服务器
          <input
            aria-label="节点服务器"
            required
            value={value.server}
            onChange={(e) => draft.change({ ...value, server: e.target.value })}
          />
        </label>
        <label>
          端口
          <input
            aria-label="节点端口"
            type="number"
            min={1}
            max={65535}
            required
            value={value.port}
            onChange={(e) =>
              draft.change({ ...value, port: Number(e.target.value) })
            }
          />
        </label>
      </div>
      <p className="hint">协议与认证信息随节点导入。</p>
      {draft.error ? <p role="alert">{draft.error}</p> : null}
      <button className="primary" disabled={!draft.ready}>
        保存节点
      </button>
      <button type="button" className="quiet" onClick={close}>
        关闭
      </button>
    </form>
  );
}
export function Nodes({
  config,
  run,
  measurements = [],
}: {
  measurements?: import("../../../packages/contracts/src/index").AppSnapshot["nodeMeasurements"];
  config: Configuration;
  run: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [draftError, setDraftError] = useState("");
  const [text, setText] = useState(""),
    [query, setQuery] = useState(""),
    [editing, setEditing] = useState<string | null>(null);
  const sourceDraft = useDraft("subscription-name", { id: "", name: "" });
  useEffect(() => {
    void window.shell
      .request("ui.draft.get")
      .then((value) => setText((current) => current || String(value ?? "")))
      .catch(() => setDraftError("草稿恢复失败，请检查输入"));
  }, []);
  const node = config.nodes.find((n) => n.id === editing);
  return (
    <>
      <h1>节点与订阅</h1>
      <section className="panel">
        <h2>导入</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await mutation(
                "subscription.import",
                text.trim().startsWith("https://")
                  ? { url: text.trim() }
                  : { text },
              );
              await window.shell.request("ui.draft.set", "");
              setText("");
              setDraftError("");
            });
          }}
        >
          <textarea
            aria-label="订阅链接或配置"
            placeholder="订阅链接、节点链接或配置内容"
            rows={4}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              void window.shell
                .request("ui.draft.set", e.target.value)
                .then(() => setDraftError(""))
                .catch(() => setDraftError("草稿未保存，请缩减输入后重试"));
            }}
            required
          />
          {draftError ? <p role="alert">{draftError}</p> : null}
          <button className="primary">导入节点</button>
        </form>
      </section>
      {config.subscriptions.length ? (
        <section className="panel">
          <h2>订阅</h2>
          {config.subscriptions.map((s) => (
            <div className="subscriptionrow" key={s.id}>
              <div>
                <strong>{s.name}</strong>
                <small>
                  {s.count} 个节点 ·{" "}
                  {s.updatedAt
                    ? new Date(s.updatedAt).toLocaleString()
                    : "尚未更新"}
                </small>
                {s.error ? <p role="alert">{s.error}</p> : null}
              </div>
              <button
                className="quiet"
                onClick={() =>
                  run(() => mutation("subscription.refresh", { id: s.id }))
                }
              >
                更新
              </button>
              <button
                className="quiet"
                onClick={() => sourceDraft.change({ id: s.id, name: s.name })}
              >
                重命名
              </button>
              <button
                className="quiet"
                title="移除订阅来源，节点保留为本地节点"
                onClick={() =>
                  run(() => mutation("subscription.remove", { id: s.id }))
                }
              >
                移除来源
              </button>
            </div>
          ))}
          {sourceDraft.value.id ? (
            <form
              className="inline"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  await mutation("subscription.rename", sourceDraft.value);
                  await sourceDraft.clear({ id: "", name: "" });
                });
              }}
            >
              <input
                aria-label="订阅名称"
                required
                maxLength={100}
                value={sourceDraft.value.name}
                onChange={(e) => sourceDraft.change({ name: e.target.value })}
              />
              <button className="secondary">保存名称</button>
            </form>
          ) : null}
        </section>
      ) : null}
      {node ? (
        <NodeEditor
          key={node.id}
          node={node}
          revision={config.revision}
          run={run}
          close={() => setEditing(null)}
        />
      ) : null}
      <section className="panel">
        <div className="paneltitle">
          <h2>
            节点 <span className="count">{config.nodes.length}</span>
          </h2>
          <input
            className="nodesearch"
            aria-label="搜索节点"
            placeholder="搜索节点"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {config.nodes
          .filter((n) =>
            `${n.name} ${n.server} ${n.type}`
              .toLowerCase()
              .includes(query.toLowerCase()),
          )
          .map((n) => (
            <div className="node" key={n.id}>
              <span className="nodeicon">↗</span>
              <div>
                <strong>{n.name}</strong>
                <small>
                  {n.type} · {n.server}:{n.port}
                  {n.id === config.settings.selectedNode ? " · 当前所选" : ""}
                </small>
              </div>
              <div className="nodeactions">
                <span
                  title={
                    measurements.find((value) => value.id === n.id)?.message
                  }
                >
                  {measurements.find((value) => value.id === n.id)?.state ===
                  "running"
                    ? "检测中…"
                    : measurements.find((value) => value.id === n.id)?.state ===
                        "succeeded"
                      ? `${measurements.find((value) => value.id === n.id)?.delayMs} ms`
                      : measurements.find((value) => value.id === n.id)
                            ?.state === "failed"
                        ? "检测失败"
                        : ""}
                </span>
                <button
                  className="quiet"
                  onClick={() =>
                    run(() =>
                      client.request("node.measure", { id: n.id }),
                    )
                  }
                >
                  测延迟
                </button>
                <button className="quiet" onClick={() => setEditing(n.id)}>
                  编辑
                </button>
                <button
                  className="quiet"
                  onClick={() =>
                    run(() => mutation("node.remove", { id: n.id }))
                  }
                >
                  移除
                </button>
              </div>
            </div>
          ))}
        {!config.nodes.length ? (
          <div className="empty">导入节点后选择代理出口</div>
        ) : null}
      </section>
    </>
  );
}
