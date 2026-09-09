import { SearchField, EmptyState } from "../components";
import { useState, useEffect, useRef } from "react";
import type {
  Configuration,
  NodeConfig,
} from "../../../packages/contracts/src/index";
import { mutation, client } from "../../../packages/client/src/index";
import { ConfirmAction } from "../ConfirmAction";
import { useDraft } from "../drafts";
import {
  ActionMenu,
  Field,
  FormFooter,
  Modal,
  PageHeader,
  TaskError,
  useTask,
} from "../components";
import { Icon } from "../icons";
function NodeEditor({
  node,
  revision,
  close,
}: {
  node: NodeConfig;
  revision: number;
  close: () => void;
}) {
  const draft = useDraft(`node-editor.${node.id}`, {
    id: node.id,
    name: node.name,
    server: node.server,
    port: node.port,
  });
  const value = draft.value.id === node.id ? draft.value : node,
    task = useTask();
  return (
    <Modal
      title="编辑节点"
      description="修改名称与连接地址，认证信息保持原样。"
      onClose={close}
      busy={task.pending}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void task.execute(async () => {
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
        <Field id="node-name" label="名称">
          <input
            id="node-name"
            aria-label="节点名称"
            autoFocus
            data-autofocus="true"
            required
            maxLength={200}
            value={value.name}
            onChange={(e) => draft.change({ ...value, name: e.target.value })}
          />
        </Field>
        <div className="addressfields">
          <Field id="node-server" label="服务器">
            <input
              id="node-server"
              aria-label="节点服务器"
              required
              value={value.server}
              onChange={(e) =>
                draft.change({ ...value, server: e.target.value })
              }
            />
          </Field>
          <Field id="node-port" label="端口">
            <input
              id="node-port"
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
          </Field>
        </div>
        <TaskError message={task.error || draft.error} />
        <FormFooter
          onClose={close}
          pending={task.pending}
          ready={draft.ready}
          label="保存节点"
        />
      </form>
    </Modal>
  );
}
function ImportSubscription({
  close,
  imported,
}: {
  close: () => void;
  imported: () => void;
}) {
  const draft = useDraft("subscription-create", {
    name: "",
    mode: "url",
    url: "",
  });
  const [text, setText] = useState(""),
    [legacyReady, setLegacyReady] = useState(false),
    [draftError, setDraftError] = useState(""),
    [urlError, setUrlError] = useState("");
  const edited = useRef(false),
    task = useTask();
  useEffect(() => {
    let alive = true;
    void window.shell
      .request("ui.draft.get")
      .then((value) => {
        if (alive && !edited.current) setText(String(value ?? ""));
      })
      .catch(() => setDraftError("草稿恢复失败，请检查输入"))
      .finally(() => {
        if (alive) setLegacyReady(true);
      });
    return () => {
      alive = false;
    };
  }, []);
  const validate = () => {
    try {
      if (new URL(draft.value.url).protocol !== "https:")
        return "订阅链接需要以 https:// 开头。";
      return "";
    } catch {
      return "请填写完整的 HTTPS 订阅链接。";
    }
  };
  return (
    <Modal
      title="添加订阅"
      description="用一个链接管理节点，也可以直接导入配置。"
      onClose={close}
      busy={task.pending}
      onCancelRequest={() => {
        void task.cancel();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const error = draft.value.mode === "url" ? validate() : "";
          setUrlError(error);
          if (error) {
            document.getElementById("subscription-url")?.focus();
            return;
          }
          void task.execute(async () => {
            await task.request(
              "subscription.import",
              draft.value.mode === "url"
                ? {
                    url: draft.value.url.trim(),
                    name: draft.value.name.trim() || undefined,
                  }
                : { text },
            );
            await window.shell.request("ui.draft.set", "");
            await draft.clear({ name: "", mode: draft.value.mode, url: "" });
            imported();
            close();
          });
        }}
      >
        <div className="entrytabs" role="group" aria-label="导入方式">
          {[
            { id: "url", name: "订阅链接" },
            { id: "text", name: "配置文本" },
          ].map((mode) => (
            <button
              key={mode.id}
              type="button"
              aria-pressed={draft.value.mode === mode.id}
              onClick={() => draft.change({ mode: mode.id })}
            >
              {mode.name}
            </button>
          ))}
        </div>
        {draft.value.mode === "url" ? (
          <>
            <Field id="subscription-name" label="订阅名称" optional>
              <input
                id="subscription-name"
                maxLength={100}
                value={draft.value.name}
                placeholder="例如：工作网络"
                onChange={(e) => draft.change({ name: e.target.value })}
              />
            </Field>
            <Field
              id="subscription-url"
              label="订阅链接"
              hint="使用服务商提供的 HTTPS 地址。"
              error={urlError}
            >
              <div className="inputgroup">
                <Icon name="arrow" size={15} />
                <input
                  id="subscription-url"
                  aria-describedby="subscription-url-hint"
                  aria-invalid={!!urlError}
                  autoFocus
                  data-autofocus="true"
                  required
                  type="text"
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="https://example.com/subscribe"
                  value={draft.value.url}
                  onBlur={() => {
                    if (draft.value.url) setUrlError(validate());
                  }}
                  onChange={(e) => {
                    draft.change({ url: e.target.value });
                    setUrlError("");
                  }}
                />
                <button
                  type="button"
                  aria-label="清除订阅链接"
                  onClick={() => {
                    draft.change({ url: "" });
                    setUrlError("");
                    document.getElementById("subscription-url")?.focus();
                  }}
                >
                  <Icon name="close" size={13} />
                </button>
              </div>
            </Field>
          </>
        ) : (
          <Field
            id="subscription-text"
            label="节点链接或配置"
            hint="支持节点分享链接、sing-box 与 Clash 配置。"
          >
            <textarea
              id="subscription-text"
              aria-label="订阅链接或配置"
              required
              rows={7}
              spellCheck={false}
              value={text}
              placeholder="粘贴节点分享链接或配置内容"
              onChange={(e) => {
                edited.current = true;
                setText(e.target.value);
                void window.shell
                  .request("ui.draft.set", e.target.value)
                  .then(() => setDraftError(""))
                  .catch(() => setDraftError("草稿未保存，请缩减输入后重试"));
              }}
            />
          </Field>
        )}
        <TaskError message={task.error || draftError || draft.error} />
        <FormFooter
          onClose={close}
          pending={task.pending}
          ready={
            draft.ready &&
            legacyReady &&
            !!(draft.value.mode === "url"
              ? draft.value.url.trim()
              : text.trim())
          }
          label={draft.value.mode === "url" ? "添加订阅" : "导入节点"}
        />
      </form>
    </Modal>
  );
}
export function Nodes({
  config,
  run,
  measurements = [],
  save,
  running,
  appliedRevision,
}: {
  save: (config: Configuration) => Promise<boolean>;
  running: boolean;
  appliedRevision?: number;
  measurements?: import("../../../packages/contracts/src/index").AppSnapshot["nodeMeasurements"];
  config: Configuration;
  run: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [query, setQuery] = useState(""),
    [editing, setEditing] = useState<string | null>(null),
    [adding, setAdding] = useState(false),
    [renaming, setRenaming] = useState(false),
    [notice, setNotice] = useState("");
  const sourceDraft = useDraft("subscription-name", { id: "", name: "" }),
    task = useTask();
  const node = config.nodes.find((n) => n.id === editing),
    filtered = config.nodes.filter((n) =>
      `${n.name} ${n.server} ${n.type}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
    );
  const measurementById = new Map(
    measurements.map((value) => [value.id, value]),
  );
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 6000);
    return () => clearTimeout(timer);
  }, [notice]);
  return (
    <div className="resourcepage">
      <PageHeader title="节点与订阅" description="管理代理资源，选择流量出口。">
        <button className="primary" onClick={() => setAdding(true)}>
          <span aria-hidden="true">＋</span> 添加订阅
        </button>
      </PageHeader>
      {notice ? (
        <p className="inlinenotice" role="status">
          <span className="dot online" />
          {notice}
        </p>
      ) : null}
      <section className="resourcesection" aria-label="代理节点">
        <div className="resourcetools">
          <div className="sectioncaption">
            全部节点 <span className="count">{config.nodes.length}</span>
          </div>
          <SearchField
            label="搜索节点"
            placeholder="搜索名称、地址或协议"
            value={query}
            onChange={setQuery}
            clearLabel="清空节点搜索"
          />
        </div>
        {filtered.length ? (
          <div className="resourcelist">
            <div className="listcolumns">
              <span>名称 / 服务器</span>
              <span>延迟与操作</span>
            </div>
            {filtered.map((n) => (
              <div
                className={`node ${n.id === config.settings.selectedNode ? "selectednode" : ""}`}
                key={n.id}
              >
                <span className="nodeicon">
                  <Icon name="nodes" size={17} />
                </span>
                <div className="nodeidentity">
                  <strong title={n.name}>{n.name}</strong>
                  <small>
                    {n.server}:{n.port}
                    <span className="protocolbadge">{n.type}</span>
                  </small>
                </div>
                <div className="nodeactions">
                  <button
                    className="latencybutton"
                    disabled={
                      !running ||
                      appliedRevision !== config.revision ||
                      measurementById.get(n.id)?.state === "running"
                    }
                    aria-label={`测延迟 ${n.name}`}
                    title={
                      !running
                        ? "启动代理后可测延迟"
                        : appliedRevision !== config.revision
                          ? "应用配置后可测延迟"
                          : measurementById.get(n.id)?.message ||
                            "检测节点连接延迟"
                    }
                    onClick={() =>
                      run(() => client.request("node.measure", { id: n.id }))
                    }
                  >
                    {measurementById.get(n.id)?.state === "running"
                      ? "检测中…"
                      : measurementById.get(n.id)?.state === "succeeded"
                        ? `${measurementById.get(n.id)?.delayMs} ms`
                        : measurementById.get(n.id)?.state === "failed"
                          ? "重试测速"
                          : "测延迟"}
                  </button>
                  <button
                    className={
                      n.id === config.settings.selectedNode
                        ? "quiet chosen"
                        : "secondary"
                    }
                    disabled={n.id === config.settings.selectedNode}
                    onClick={async () => {
                      if (
                        await save({
                          ...config,
                          settings: { ...config.settings, selectedNode: n.id },
                        })
                      )
                        setNotice("已选择出口，下次启动或应用配置时生效。");
                    }}
                  >
                    {n.id === config.settings.selectedNode
                      ? "✓ 已选择"
                      : "选择出口"}
                  </button>
                  <ActionMenu label={`更多操作 ${n.name}`}>
                    <button onClick={() => setEditing(n.id)}>编辑</button>
                    <ConfirmAction
                      label="移除"
                      title={`移除节点「${n.name}」？`}
                      description="该节点及引用它的分流规则会移除。如果它是当前出口，配置将回到直连；运行中的连接在应用配置后改变。"
                      onConfirm={() => mutation("node.remove", { id: n.id })}
                    />
                  </ActionMenu>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            title={
              config.nodes.length ? "没有匹配的节点" : "添加你的第一个节点"
            }
            description={
              config.nodes.length
                ? "尝试节点名称、服务器地址或协议。"
                : "导入订阅或节点配置，然后选择一个出口开始连接。"
            }
            icon="nodes"
          >
            <button
              className="secondary"
              onClick={() =>
                config.nodes.length ? setQuery("") : setAdding(true)
              }
            >
              {config.nodes.length ? "清除搜索" : "导入代理资源"}
            </button>
          </EmptyState>
        )}
      </section>
      <section className="resourcesection subscriptions">
        <div className="resourcetools">
          <h2>
            订阅来源{" "}
            <span className="count">{config.subscriptions.length}</span>
          </h2>
          <span className="hint">更新来源，同步节点</span>
        </div>
        {config.subscriptions.length ? (
          config.subscriptions.map((s) => (
            <div className="subscriptionrow" key={s.id}>
              <span className="sourceicon">
                <Icon name="refresh" size={16} />
              </span>
              <div>
                <strong>{s.name}</strong>
                <small>
                  {s.count} 个节点 ·{" "}
                  {s.updatedAt
                    ? new Date(s.updatedAt).toLocaleString()
                    : "尚未更新"}
                </small>
                {s.error ? <TaskError message={s.error} /> : null}
              </div>
              <button
                className="quiet"
                onClick={() =>
                  run(() => mutation("subscription.refresh", { id: s.id }))
                }
              >
                更新
              </button>
              <ActionMenu label={`管理订阅 ${s.name}`}>
                <button
                  onClick={() => {
                    sourceDraft.change({ id: s.id, name: s.name });
                    setRenaming(true);
                  }}
                >
                  重命名
                </button>
                <ConfirmAction
                  label="移除来源"
                  title={`移除订阅「${s.name}」？`}
                  description="节点会保留为本地节点，此来源将不再提供更新。"
                  onConfirm={() =>
                    mutation("subscription.remove", { id: s.id })
                  }
                />
              </ActionMenu>
            </div>
          ))
        ) : (
          <p className="sectionempty">
            暂无订阅来源。直接导入的配置保留为本地节点。
          </p>
        )}
      </section>
      {adding ? (
        <ImportSubscription
          close={() => setAdding(false)}
          imported={() => {
            setQuery("");
            setNotice("代理资源已添加，请在列表中选择出口。");
          }}
        />
      ) : null}
      {node ? (
        <NodeEditor
          key={node.id}
          node={node}
          revision={config.revision}
          close={() => setEditing(null)}
        />
      ) : null}
      {renaming ? (
        <Modal
          title="重命名订阅"
          onClose={() => setRenaming(false)}
          busy={task.pending}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void task.execute(async () => {
                await mutation("subscription.rename", sourceDraft.value);
                await sourceDraft.clear({ id: "", name: "" });
                setRenaming(false);
              });
            }}
          >
            <Field id="rename-subscription" label="订阅名称">
              <input
                id="rename-subscription"
                autoFocus
                data-autofocus="true"
                required
                maxLength={100}
                value={sourceDraft.value.name}
                onChange={(e) => sourceDraft.change({ name: e.target.value })}
              />
            </Field>
            <TaskError message={task.error || sourceDraft.error} />
            <FormFooter
              onClose={() => setRenaming(false)}
              pending={task.pending}
              ready={sourceDraft.ready}
              label="保存名称"
            />
          </form>
        </Modal>
      ) : null}
    </div>
  );
}
