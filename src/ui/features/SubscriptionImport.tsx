import { useEffect, useRef, useState } from "react";
import type { Subscription } from "../../../packages/contracts/src/index";
import type {
  SubscriptionMetadata,
  SubscriptionParseOptions,
  SubscriptionPreview,
} from "../../../packages/contracts/src/subscriptions";
import {
  Button,
  Combobox,
  Field,
  FormFooter,
  Modal,
  TaskError,
  useTask,
} from "../components";
import { useDraft } from "../drafts";

export function SubscriptionMetadataLine({
  metadata,
}: {
  metadata?: SubscriptionMetadata;
}) {
  if (!metadata || !Object.keys(metadata).length) return null;
  const bytes = (value: number) => `${(value / 1024 ** 3).toFixed(2)} GB`;
  const used = (metadata.upload ?? 0) + (metadata.download ?? 0);
  return (
    <small>
      {metadata.total !== undefined
        ? `已用 ${bytes(used)} / ${bytes(metadata.total)}`
        : metadata.upload !== undefined || metadata.download !== undefined
          ? `已用 ${bytes(used)}`
          : ""}
      {metadata.expire
        ? ` · 到期 ${new Date(metadata.expire * 1000).toLocaleDateString()}`
        : ""}
    </small>
  );
}

export function ImportSubscription({
  close,
  imported,
  source,
}: {
  close: () => void;
  imported: () => void;
  source?: Subscription;
}) {
  const draft = useDraft("subscription-create", {
    name: "",
    mode: "url",
    url: "",
  });
  const [text, setText] = useState("");
  const [legacyReady, setLegacyReady] = useState(!!source);
  const [draftError, setDraftError] = useState("");
  const [urlError, setUrlError] = useState("");
  const [options, setOptions] = useState<SubscriptionParseOptions>(
    source?.parseOptions ?? {},
  );
  const [migration, setMigration] = useState<"nodes" | "profile">(
    source?.migration ?? "nodes",
  );
  const [refreshHours, setRefreshHours] = useState(source?.refreshHours ?? 0);
  const [acceptRejected, setAcceptRejected] = useState(false);
  const [preview, setPreview] = useState<SubscriptionPreview | null>(null);
  const edited = useRef(false),
    previewHeading = useRef<HTMLHeadingElement>(null),
    task = useTask();
  useEffect(() => {
    if (source) return;
    let alive = true;
    void window.shell
      .request("ui.draft.get")
      .then((value) => {
        if (alive && !edited.current) setText(String(value ?? ""));
      })
      .catch(() => {
        if (alive) setDraftError("草稿恢复失败，请检查输入");
      })
      .finally(() => {
        if (alive) setLegacyReady(true);
      });
    return () => {
      alive = false;
    };
  }, [source]);
  useEffect(() => {
    if (preview) previewHeading.current?.focus();
  }, [preview?.id]);
  const validate = () => {
    try {
      const url = new URL(draft.value.url);
      return url.protocol === "https:" && !url.username && !url.password
        ? ""
        : "订阅链接需要使用不含用户名或密码的 HTTPS 地址。";
    } catch {
      return "请填写完整的 HTTPS 订阅链接。";
    }
  };
  return (
    <Modal
      title={source ? "更新订阅" : "添加订阅"}
      description={
        source ? source.name : "用一个链接管理节点，也可以直接导入配置。"
      }
      onClose={close}
      busy={task.pending}
      onCancelRequest={() => void task.cancel()}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const error =
            !preview && !source && draft.value.mode === "url" ? validate() : "";
          setUrlError(error);
          if (error) {
            document.getElementById("subscription-url")?.focus();
            return;
          }
          void task.execute(async () => {
            if (!preview) {
              const result = await task.request<SubscriptionPreview>(
                "subscription.preview",
                {
                  ...(source
                    ? { id: source.id }
                    : draft.value.mode === "url"
                      ? {
                          url: draft.value.url.trim(),
                          name: draft.value.name.trim() || undefined,
                        }
                      : { text, name: draft.value.name.trim() || "本地配置" }),
                  options,
                  migration,
                  refreshHours,
                  acceptRejected,
                },
              );
              setPreview(result);
            } else {
              await task.request(
                source ? "subscription.refresh" : "subscription.import",
                { previewId: preview.id, id: source?.id, reviewed: true },
              );
              if (!source) {
                await window.shell.request("ui.draft.set", "");
                await draft.clear({
                  name: "",
                  mode: draft.value.mode,
                  url: "",
                });
              }
              imported();
              close();
            }
          });
        }}
      >
        {preview ? (
          <section className="subscriptionpreview" aria-label="订阅转换预览">
            <h3 ref={previewHeading} tabIndex={-1}>
              转换预览
            </h3>
            <p>
              {preview.summary.format} · {preview.nodes.length} 个已转换节点
              {preview.summary.rejected
                ? ` · ${preview.summary.rejected} 个未转换`
                : ""}
            </p>
            <p className="fieldhint">
              新增 {preview.changes.added} · 移除 {preview.changes.removed} ·
              变更 {preview.changes.updated} · 不变 {preview.changes.unchanged}
            </p>
            {preview.unchanged ? (
              <p role="status">来源未变化，本次仅更新检查时间。</p>
            ) : null}
            <SubscriptionMetadataLine metadata={preview.metadata} />
            {migration === "profile" ? (
              <p className="inlinenotice">
                确认后会替换当前策略组与分流规则，并迁移可支持的 DNS
                设置。监听端口和系统接入模式保持当前设置。
              </p>
            ) : (
              <p className="fieldhint">
                仅导入节点；来源含 {preview.summary.groups} 个策略组、
                {preview.summary.rules} 条规则。
              </p>
            )}
            {preview.summary.diagnostics.length ? (
              <details open>
                <summary>
                  转换提示（{preview.summary.diagnostics.length} 类）
                </summary>
                <ul>
                  {preview.summary.diagnostics.map((item, index) => (
                    <li key={`${item.code}-${index}`}>
                      {item.message}
                      {item.count && item.count > 1
                        ? `（${item.count} 项）`
                        : ""}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            {!preview.profile.supported ? (
              <details open={migration === "profile"}>
                <summary>完整配置迁移限制</summary>
                <ul>
                  {preview.profile.blockers.map((message) => (
                    <li key={message}>{message}</li>
                  ))}
                </ul>
              </details>
            ) : null}
            <details>
              <summary>查看节点（{preview.nodes.length}）</summary>
              <ul>
                {preview.nodes.slice(0, 50).map((node) => (
                  <li key={node.id}>
                    {node.name} · {node.type} · {node.server}:{node.port}
                  </li>
                ))}
              </ul>
              {preview.nodes.length > 50 ? (
                <p className="fieldhint">
                  此处展示前 50 个，导入后可查看全部节点。
                </p>
              ) : null}
            </details>
            {!preview.canCommit ? (
              <TaskError message="此预览暂时不能提交。请返回调整选项，或先处理当前出口和规则引用。" />
            ) : null}
            <Button
              type="button"
              className="quiet"
              onClick={() => {
                setPreview(null);
                task.setError("");
              }}
            >
              返回调整
            </Button>
          </section>
        ) : (
          <>
            {!source ? (
              <>
                <div className="entrytabs" role="group" aria-label="导入方式">
                  {[
                    { id: "url", name: "订阅链接" },
                    { id: "text", name: "配置文本" },
                  ].map((mode) => (
                    <Button
                      key={mode.id}
                      type="button"
                      aria-pressed={draft.value.mode === mode.id}
                      onClick={() => draft.change({ mode: mode.id })}
                    >
                      {mode.name}
                    </Button>
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
                        onChange={(event) =>
                          draft.change({ name: event.target.value })
                        }
                      />
                    </Field>
                    <Field
                      id="subscription-url"
                      label="订阅链接"
                      hint="使用服务商提供的 HTTPS 地址。"
                      error={urlError}
                    >
                      <div className="inputgroup">
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
                          onChange={(event) => {
                            draft.change({ url: event.target.value });
                            setUrlError("");
                          }}
                        />
                        <Button
                          type="button"
                          aria-label="清除订阅链接"
                          onClick={() => {
                            draft.change({ url: "" });
                            setUrlError("");
                            document
                              .getElementById("subscription-url")
                              ?.focus();
                          }}
                        >
                          ×
                        </Button>
                      </div>
                    </Field>
                  </>
                ) : (
                  <Field
                    id="subscription-text"
                    label="节点链接或配置"
                    hint="支持分享链接、sing-box、Clash、Quantumult X、Loon、Surge、Shadowrocket 与 SIP008。"
                  >
                    <textarea
                      id="subscription-text"
                      aria-label="订阅链接或配置"
                      required
                      rows={7}
                      spellCheck={false}
                      value={text}
                      placeholder="粘贴节点分享链接或配置内容"
                      onChange={(event) => {
                        edited.current = true;
                        setText(event.target.value);
                        void window.shell
                          .request("ui.draft.set", event.target.value)
                          .then(() => setDraftError(""))
                          .catch(() =>
                            setDraftError("草稿未保存，请缩减输入后重试"),
                          );
                      }}
                    />
                  </Field>
                )}
              </>
            ) : null}
            <Field id="subscription-migration" label="导入范围">
              <Combobox
                label="导入范围"
                id="subscription-migration"
                value={migration}
                options={[
                  { value: "nodes", label: "只导入节点（默认）" },
                  {
                    value: "profile",
                    label: "完整配置迁移",
                    detail: "预览兼容性；确认后替换策略组和规则",
                  },
                ]}
                onChange={(value) => setMigration(value as "nodes" | "profile")}
              />
            </Field>
            <details className="conversionoptions">
              <summary>转换与更新选项</summary>
              <Field id="subscription-format" label="来源格式">
                <Combobox
                  label="来源格式"
                  id="subscription-format"
                  value={options.format ?? "auto"}
                  options={[
                    { value: "auto", label: "自动识别" },
                    ...[
                      "sing-box",
                      "clash",
                      "uri",
                      "sip008",
                      "quantumult-x",
                      "loon",
                      "surge",
                      "shadowrocket",
                    ].map((value) => ({ value, label: value })),
                  ]}
                  onChange={(value) =>
                    setOptions({
                      ...options,
                      format:
                        value === "auto"
                          ? undefined
                          : (value as SubscriptionParseOptions["format"]),
                    })
                  }
                />
              </Field>
              <Field
                id="subscription-aead"
                label="VMess 握手"
                hint="默认遵循来源；仅在服务商明确说明时覆盖。"
              >
                <Combobox
                  label="VMess 握手"
                  id="subscription-aead"
                  value={options.vmessAead ?? "source"}
                  options={[
                    { value: "source", label: "遵循来源" },
                    { value: "enabled", label: "启用 AEAD" },
                    { value: "legacy", label: "使用旧握手" },
                  ]}
                  onChange={(value) =>
                    setOptions({
                      ...options,
                      vmessAead: value as SubscriptionParseOptions["vmessAead"],
                    })
                  }
                />
              </Field>
              <label className="conversioncheck">
                <input
                  type="checkbox"
                  checked={options.excludeInformation ?? false}
                  onChange={(event) =>
                    setOptions({
                      ...options,
                      excludeInformation: event.target.checked,
                    })
                  }
                />
                排除形似流量或到期提示的条目
              </label>
              <label className="conversioncheck">
                <input
                  type="checkbox"
                  checked={acceptRejected}
                  onChange={(event) => setAcceptRejected(event.target.checked)}
                />
                允许只导入成功转换的节点（需查看预览）
              </label>
              {source?.canRefresh || (!source && draft.value.mode === "url") ? (
                <Field id="subscription-refresh" label="自动更新">
                  <Combobox
                    label="自动更新"
                    id="subscription-refresh"
                    value={String(refreshHours)}
                    options={[
                      { value: "0", label: "关闭（默认）" },
                      { value: "6", label: "每 6 小时" },
                      { value: "12", label: "每 12 小时" },
                      { value: "24", label: "每天" },
                      { value: "168", label: "每周" },
                    ]}
                    onChange={(value) => setRefreshHours(Number(value))}
                  />
                </Field>
              ) : null}
            </details>
          </>
        )}
        <TaskError message={task.error || draftError || draft.error} />
        <FormFooter
          onClose={close}
          pending={task.pending}
          ready={
            preview
              ? preview.canCommit
              : !!source ||
                (draft.ready &&
                  legacyReady &&
                  !!(draft.value.mode === "url"
                    ? draft.value.url.trim()
                    : text.trim()))
          }
          label={preview ? (source ? "确认更新" : "确认导入") : "预览转换"}
          hint={
            preview
              ? "尚未写入，确认后保存"
              : source
                ? "先预览变化，再确认更新"
                : "关闭后保留草稿"
          }
        />
      </form>
    </Modal>
  );
}
