import { EmptyState } from "../components";
import { useState } from "react";
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
import { Icon } from "../icons";
const kindName = {
  domain_suffix: "域名后缀",
  domain: "完整域名",
  ip_cidr: "IP 网段",
  process_name: "进程名称",
};
export function Rules({
  config,
  save,
}: {
  config: Configuration;
  save: (c: Configuration, options?: { local?: boolean }) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState<Rule | "new" | null>(null),
    [notice, setNotice] = useState("");
  const choices = outletChoices(config);
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
      <PageHeader
        title="分流规则"
        description="从上到下匹配，第一条命中的规则决定出口。"
      >
        <button className="primary" onClick={() => setEditing("new")}>
          ＋ 添加规则
        </button>
      </PageHeader>
      {notice ? (
        <p className="inlinenotice" role="status">
          <span className="dot online" />
          {notice}
        </p>
      ) : null}
      <section className="resourcesection ruleslist" aria-label="规则优先级">
        <div className="resourcetools">
          <h2>
            匹配顺序 <span className="count">{config.rules.length}</span>
          </h2>
          <span className="hint">优先匹配上方规则</span>
        </div>
        {config.rules.length ? (
          config.rules.map((r, index) => (
            <div className="rulerow" key={r.id}>
              <span className="index">
                {String(index + 1).padStart(2, "0")}
              </span>
              <div className="ruleidentity">
                <div>
                  <span className="rulekind">{kindName[r.kind]}</span>
                  <strong className="rulevalue" title={r.value}>
                    {r.value}
                  </strong>
                </div>
                <small>
                  {r.sourceId
                    ? (config.ruleSources?.find((s) => s.id === r.sourceId)
                        ?.name ?? "规则集")
                    : "手动规则"}
                </small>
              </div>
              <span className="rulearrow">
                <Icon name="arrow" size={14} />
              </span>
              <span className="ruleoutbound" title={outboundName(r.outbound)}>
                {outboundName(r.outbound)}
              </span>
              <div className="rowactions">
                <button
                  className="iconbutton"
                  aria-label={`上移规则 ${r.value}`}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  ↑
                </button>
                <button
                  className="iconbutton"
                  aria-label={`下移规则 ${r.value}`}
                  disabled={index === config.rules.length - 1}
                  onClick={() => move(index, 1)}
                >
                  ↓
                </button>
                <button
                  className="quiet"
                  title={
                    r.sourceId
                      ? "修改来源中的规则会在下次更新时覆盖"
                      : "编辑规则"
                  }
                  onClick={() => {
                    setEditing(r);
                  }}
                >
                  编辑
                </button>
                <button
                  className="iconbutton dangertext"
                  aria-label={`删除规则 ${r.value}`}
                  onClick={async () => {
                    if (
                      await save({
                        ...config,
                        rules: config.rules.filter((x) => x.id !== r.id),
                      })
                    )
                      setNotice("规则已删除。");
                  }}
                >
                  <Icon name="close" size={13} />
                </button>
              </div>
            </div>
          ))
        ) : (
          <EmptyState
            title="为不同流量选择路径"
            description="按域名、IP 网段或进程分流，未匹配的流量使用默认出口。"
            icon="rules"
          />
        )}
        <div className="defaultrule">
          <span className="rulekind">默认规则</span>
          <span>其余流量发送到</span>
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
      </section>
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
