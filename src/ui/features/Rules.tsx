import { Pagination } from "../components";
import { useResourceSearch } from "../resourceSearch";
import { Button, EmptyState, SearchField, ActionMenu } from "../components";
import { useEffect, useState } from "react";
import { useDraft } from "../drafts";
import type {
  Configuration,
  Rule,
} from "../../../packages/contracts/src/index";
import {
  Combobox,
  Field,
  FormFooter,
  Modal,
  PageHeader,
  TaskError,
  outletChoices,
  useTask,
} from "../components";
const kindName = {
  domain_suffix: "域名后缀",
  domain: "完整域名",
  domain_keyword: "域名关键词",
  ip_cidr: "IP 网段",
  process_name: "进程名称",
};
export function Rules({
  config,
  save,
  preview,
  sources,
}: {
  config: Configuration;
  preview?: import("react").ReactNode;
  sources?: import("react").ReactNode;
  save: (c: Configuration, options?: { local?: boolean }) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState<Rule | "new" | null>(null),
    [notice, setNotice] = useState("");
  const [showPreview, setShowPreview] = useState(false),
    [showSources, setShowSources] = useState(false);
  const [listPage, setListPage] = useState(0);
  const [query, setQuery] = useResourceSearch("rules");
  const [source, setSource] = useState("all");
  const [undo, setUndo] = useState<{
    rule: Rule;
    index: number;
    next?: string;
  } | null>(null);
  const choices = outletChoices(config);
  const filtered = config.rules
    .map((rule, index) => ({ rule, index }))
    .filter(
      ({ rule }) =>
        (source === "all" ||
          (source === "manual" ? !rule.sourceId : rule.sourceId === source)) &&
        `${rule.value} ${kindName[rule.kind]} ${choices.find((o) => o.value === rule.outbound)?.label}`
          .toLowerCase()
          .includes(query.trim().toLowerCase()),
    );
  const page = Math.min(
    listPage,
    Math.max(0, Math.ceil(filtered.length / 100) - 1),
  );
  useEffect(() => {
    setListPage(0);
  }, [query, source]);
  useEffect(() => {
    const reset = (event: Event) => {
      if ((event as CustomEvent).detail?.page === "rules") {
        setShowSources(false);
        setSource("all");
      }
    };
    window.addEventListener("flowgate:search", reset);
    return () => window.removeEventListener("flowgate:search", reset);
  }, []);
  const outboundName = (id: string) =>
    choices.find((o) => o.value === id)?.label ?? "不可用出口";
  const move = (index: number, direction: number) => {
    const rules = [...config.rules];
    [rules[index], rules[index + direction]] = [
      rules[index + direction],
      rules[index],
    ];
    return save({ ...config, rules });
  };
  const close = () => setEditing(null);
  return (
    <div className="resourcepage">
      <PageHeader title="分流规则">
        <Button className="quiet" onClick={() => setShowPreview(true)}>
          检查路径
        </Button>
        <Button
          className="quiet"
          aria-pressed={showSources}
          onClick={() => setShowSources(!showSources)}
        >
          {showSources ? "返回规则" : "管理规则集"}
        </Button>
        <Button className="primary" onClick={() => setEditing("new")}>
          ＋ 添加规则
        </Button>
      </PageHeader>
      {showPreview ? (
        <Modal
          title="路径预览"
          icon="rules"
          onClose={() => setShowPreview(false)}
        >
          {preview}
        </Modal>
      ) : null}
      {showSources ? (
        sources
      ) : (
        <>
          <div className="defaultrule">
            <span>默认出口</span>
            <Combobox
              label="默认出口"
              value={config.settings.finalOutbound}
              options={choices}
              onChange={(value) => {
                void save({
                  ...config,
                  settings: { ...config.settings, finalOutbound: value },
                });
              }}
            />
          </div>
          {notice ? (
            <p className="inlinenotice" role="status">
              <span className="dot online" />
              {notice}
              {undo ? (
                <Button
                  className="textbutton"
                  onClick={async () => {
                    if (config.rules.some((r) => r.id === undo.rule.id)) {
                      setUndo(null);
                      return;
                    }
                    const rules = [...config.rules];
                    const next = rules.findIndex((r) => r.id === undo.next);
                    rules.splice(
                      next >= 0 ? next : Math.min(undo.index, rules.length),
                      0,
                      undo.rule,
                    );
                    if (await save({ ...config, rules })) {
                      setUndo(null);
                      setNotice("规则已恢复原位置。");
                    }
                  }}
                >
                  撤销删除
                </Button>
              ) : null}
            </p>
          ) : null}
          <section
            className="resourcesection ruleslist"
            aria-label="规则优先级"
          >
            <div className="resourcetools listtoolbar">
              <h2>
                匹配顺序 <span className="count">{config.rules.length}</span>
              </h2>
              <SearchField
                label="搜索规则"
                value={query}
                onChange={setQuery}
                placeholder="搜索目标、类型或出口"
              />
              <Combobox
                label="规则来源"
                value={source}
                onChange={setSource}
                options={[
                  { value: "all", label: "全部来源" },
                  { value: "manual", label: "手动规则" },
                  ...[
                    ...(config.ruleSources ?? []),
                    ...config.subscriptions,
                  ].map((s) => ({ value: s.id, label: s.name })),
                ]}
              />
            </div>
            <Pagination
              total={filtered.length}
              page={page}
              onChange={setListPage}
            />
            {filtered.length ? (
              filtered
                .slice(page * 100, (page + 1) * 100)
                .map(({ rule: r, index }) => (
                  <div className="rulerow" key={r.id}>
                    <span className="index">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <div className="ruleidentity">
                      <Button
                        className="rowlink"
                        aria-label={`编辑规则 ${r.value}`}
                        onClick={() => setEditing(r)}
                      >
                        <strong className="rulevalue" title={r.value}>
                          {r.value}
                        </strong>
                      </Button>
                      <small>
                        {kindName[r.kind]}
                        {r.sourceId
                          ? ` · ${config.ruleSources?.find((s) => s.id === r.sourceId)?.name ?? config.subscriptions.find((s) => s.id === r.sourceId)?.name ?? "规则集"}`
                          : ""}
                      </small>
                    </div>
                    <span
                      className="ruleoutbound"
                      title={outboundName(r.outbound)}
                    >
                      {outboundName(r.outbound)}
                    </span>
                    <div className="rowactions">
                      <ActionMenu label={`管理规则 ${r.value}`}>
                        <Button onClick={() => setEditing(r)}>编辑</Button>
                        <Button
                          disabled={index === 0}
                          onClick={() => move(index, -1)}
                        >
                          上移
                        </Button>
                        <Button
                          disabled={index === config.rules.length - 1}
                          onClick={() => move(index, 1)}
                        >
                          下移
                        </Button>
                        <Button
                          disabled={index === 0}
                          onClick={() =>
                            save({
                              ...config,
                              rules: [
                                r,
                                ...config.rules.filter((x) => x.id !== r.id),
                              ],
                            })
                          }
                        >
                          移至顶部
                        </Button>
                        <Button
                          disabled={index === config.rules.length - 1}
                          onClick={() =>
                            save({
                              ...config,
                              rules: [
                                ...config.rules.filter((x) => x.id !== r.id),
                                r,
                              ],
                            })
                          }
                        >
                          移至底部
                        </Button>
                        <Button
                          className="dangertext"
                          aria-label={`删除规则 ${r.value}`}
                          onClick={async () => {
                            if (
                              await save({
                                ...config,
                                rules: config.rules.filter(
                                  (x) => x.id !== r.id,
                                ),
                              })
                            ) {
                              setUndo({
                                rule: r,
                                index,
                                next: config.rules[index + 1]?.id,
                              });
                              setNotice("规则已删除。");
                            }
                          }}
                        >
                          删除
                        </Button>
                      </ActionMenu>
                    </div>
                  </div>
                ))
            ) : (
              <EmptyState
                title={
                  query || source !== "all"
                    ? "没有匹配的规则"
                    : "为不同流量选择路径"
                }
                description="按域名、IP 网段或进程分流，未匹配的流量使用默认出口。"
                icon="rules"
              />
            )}
          </section>
        </>
      )}
      {editing ? (
        <RuleEditor
          key={editing === "new" ? "new" : editing.id}
          rule={editing === "new" ? undefined : editing}
          config={config}
          save={save}
          close={close}
          onSaved={() =>
            setNotice(
              editing === "new"
                ? "规则已添加，按列表顺序匹配。"
                : "规则更改已保存。",
            )
          }
        />
      ) : null}
    </div>
  );
}

function RuleEditor({
  rule,
  config,
  save,
  close,
  onSaved,
}: {
  rule?: Rule;
  config: Configuration;
  preview?: import("react").ReactNode;
  sources?: import("react").ReactNode;
  save: (c: Configuration, options?: { local?: boolean }) => Promise<boolean>;
  close: () => void;
  onSaved: () => void;
}) {
  const draft = useDraft(rule ? `rule-editor.${rule.id}` : "rules", {
    value: rule?.value ?? "",
    kind: rule?.kind ?? ("domain_suffix" as Rule["kind"]),
    outbound: rule?.outbound ?? "direct",
  });
  const { value, kind, outbound } = draft.value,
    task = useTask(),
    choices = outletChoices(config);
  return (
    <Modal
      title={rule ? "编辑分流规则" : "添加分流规则"}
      description="匹配一个条件，把流量交给指定出口。"
      icon="rules"
      onClose={close}
      busy={task.pending}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void task.execute(async () => {
            if (rule && !config.rules.some((r) => r.id === rule.id))
              throw new Error(
                "这条规则已被移除，草稿仍保留。请关闭表单并检查列表。",
              );
            const updated = {
              ...rule,
              id: rule?.id ?? crypto.randomUUID(),
              kind,
              value: value.trim(),
              outbound,
            };
            const saved = await save(
              {
                ...config,
                rules: rule
                  ? config.rules.map((r) => (r.id === rule.id ? updated : r))
                  : [...config.rules, updated],
              },
              { local: true },
            );
            if (!saved) return false;
            await draft.clear({ ...draft.value, value: rule ? value : "" });
            onSaved();
            close();
          });
        }}
      >
        <div className="rulefields">
          <Field id="rule-kind" label="当目标匹配">
            <Combobox
              id="rule-kind"
              label="匹配类型"
              value={kind}
              options={Object.entries(kindName).map(([value, label]) => ({
                value,
                label,
              }))}
              onChange={(kind) => draft.change({ kind: kind as Rule["kind"] })}
            />
          </Field>
          <Field id="rule-value" label="匹配内容">
            <input
              id="rule-value"
              aria-label="匹配内容"
              autoFocus
              data-autofocus="true"
              required
              value={value}
              onChange={(e) => draft.change({ value: e.target.value })}
              placeholder={
                kind === "ip_cidr"
                  ? "192.168.0.0/16"
                  : kind === "process_name"
                    ? "Safari"
                    : "example.com"
              }
            />
          </Field>
        </div>
        <Field id="rule-outbound" label="发送到">
          <Combobox
            id="rule-outbound"
            label="规则出口"
            value={outbound}
            options={choices}
            onChange={(outbound) => draft.change({ outbound })}
          />
        </Field>
        <div className="rulesummary">
          <span>这条规则表示</span>
          <p>
            {kindName[kind]} <strong>{value || "…"}</strong> →{" "}
            {choices.find((o) => o.value === outbound)?.label ?? "不可用出口"}
          </p>
        </div>
        {rule?.sourceId ? (
          <p className="fieldhint">
            此规则来自规则集，下次更新来源时会覆盖本次修改。
          </p>
        ) : null}
        <TaskError message={task.error || draft.error} />
        <FormFooter
          onClose={close}
          pending={task.pending}
          ready={draft.ready}
          label={rule ? "保存规则" : "添加规则"}
        />
      </form>
    </Modal>
  );
}
