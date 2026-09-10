import { Button, SearchField, EmptyState } from "../components";
import { useState, useEffect } from "react";
import type {
  Configuration,
  NodeConfig,
} from "../../../packages/contracts/src/index";
import { mutation, client } from "../../../packages/client/src/index";
import { ConfirmAction } from "../ConfirmAction";
import { useDraft } from "../drafts";
import {
  ActionMenu,
  Combobox,
  Field,
  FormFooter,
  Modal,
  PageHeader,
  TaskError,
  useTask,
} from "../components";
import { Icon } from "../icons";
import {
  ImportSubscription,
  SubscriptionMetadataLine,
} from "./SubscriptionImport";
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
    [refreshing, setRefreshing] = useState<string | null>(null),
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
        <Button className="primary" onClick={() => setAdding(true)}>
          <span aria-hidden="true">＋</span> 添加订阅
        </Button>
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
                  <Button
                    className="latencybutton"
                    disabled={!running || appliedRevision !== config.revision}
                    pending={measurementById.get(n.id)?.state === "running"}
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
                  </Button>
                  <Button
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
                  </Button>
                  <ActionMenu label={`更多操作 ${n.name}`}>
                    <Button onClick={() => setEditing(n.id)}>编辑</Button>
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
            <Button
              className="secondary"
              onClick={() =>
                config.nodes.length ? setQuery("") : setAdding(true)
              }
            >
              {config.nodes.length ? "清除搜索" : "导入代理资源"}
            </Button>
          </EmptyState>
        )}
      </section>
      {(config.groups ?? []).length ? (
        <section className="resourcesection" aria-label="策略组">
          <div className="resourcetools">
            <h2>
              策略组 <span className="count">{config.groups!.length}</span>
            </h2>
            <span className="hint">选择成员后应用配置生效</span>
          </div>
          {config.groups!.map((group) => (
            <div className="subscriptionrow" key={group.id}>
              <span className="sourceicon">
                <Icon name="nodes" size={16} />
              </span>
              <div>
                <strong>{group.name}</strong>
                <small>
                  {group.type === "urltest" ? "自动测速选择" : "手动选择"} ·{" "}
                  {group.members.length} 个成员
                </small>
                {group.type === "selector" ? (
                  <Combobox
                    label={`策略组 ${group.name} 的成员`}
                    value={group.selected ?? group.members[0]}
                    options={group.members.map((id) => ({
                      value: id,
                      label:
                        id === "direct"
                          ? "直连"
                          : (config.nodes.find((node) => node.id === id)
                              ?.name ??
                            config.groups?.find((entry) => entry.id === id)
                              ?.name ??
                            "不可用成员"),
                    }))}
                    onChange={(member) => {
                      void run(() =>
                        mutation("group.select", {
                          id: group.id,
                          member,
                          revision: config.revision,
                        }),
                      );
                    }}
                  />
                ) : null}
              </div>
              <Button
                className="quiet"
                disabled={config.settings.selectedNode === group.id}
                onClick={() =>
                  void save({
                    ...config,
                    settings: { ...config.settings, selectedNode: group.id },
                  })
                }
              >
                {config.settings.selectedNode === group.id
                  ? "✓ 已选择"
                  : "选择出口"}
              </Button>
            </div>
          ))}
        </section>
      ) : null}
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
                <SubscriptionMetadataLine metadata={s.metadata} />
                {s.conversion ? (
                  <small>
                    {s.conversion.format} ·{" "}
                    {s.refreshHours
                      ? `每 ${s.refreshHours} 小时更新`
                      : "自动更新关闭"}
                  </small>
                ) : null}
                {s.conversion ? (
                  <details className="subscriptionrecord">
                    <summary>转换记录</summary>
                    <p>
                      {s.conversion.groups} 个来源策略组 · {s.conversion.rules}{" "}
                      条来源规则 ·{" "}
                      {s.migration === "profile"
                        ? "完整配置迁移"
                        : "仅导入节点"}
                    </p>
                    {s.conversion.diagnostics.length ? (
                      <ul>
                        {s.conversion.diagnostics.map((diagnostic, index) => (
                          <li key={index}>{diagnostic.message}</li>
                        ))}
                      </ul>
                    ) : (
                      <p>未发现转换问题。</p>
                    )}
                  </details>
                ) : null}
                {s.error ? <TaskError message={s.error} /> : null}
              </div>
              <Button
                className="quiet"
                disabled={!s.canRefresh}
                onClick={() => setRefreshing(s.id)}
              >
                更新
              </Button>
              <ActionMenu label={`管理订阅 ${s.name}`}>
                <Button
                  onClick={() => {
                    sourceDraft.change({ id: s.id, name: s.name });
                    setRenaming(true);
                  }}
                >
                  重命名
                </Button>
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
            暂无订阅来源。添加链接或导入配置后，可在这里查看转换结果。
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
      {refreshing && config.subscriptions.some((s) => s.id === refreshing) ? (
        <ImportSubscription
          key={refreshing}
          source={config.subscriptions.find((s) => s.id === refreshing)!}
          close={() => setRefreshing(null)}
          imported={() =>
            setNotice("订阅已更新。运行中的连接仍使用已应用的配置。 ")
          }
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
