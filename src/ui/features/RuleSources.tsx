import { useState } from "react";
import { ConfirmAction } from "../ConfirmAction";
import type { FeatureProps } from "../modules";
import { mutation } from "../../../packages/client/src/index";
import { useDraft } from "../drafts";
import {
  Button,
  ActionMenu,
  Combobox,
  Field,
  FormFooter,
  Modal,
  TaskError,
  outletChoices,
  useTask,
} from "../components";
export function RuleSources({ snapshot, run, busy }: FeatureProps) {
  const draft = useDraft("rule-source", {
      name: "",
      url: "",
      format: "domain-list",
      outbound: "direct",
    }),
    task = useTask();
  const [adding, setAdding] = useState(false),
    [urlError, setUrlError] = useState("");
  const close = () => setAdding(false);
  return (
    <section className="resourcesection rulesources">
      <div className="resourcetools">
        <h2>
          规则集来源{" "}
          <span className="count">
            {snapshot.configuration.ruleSources?.length ?? 0}
          </span>
        </h2>
        <Button className="secondary" onClick={() => setAdding(true)}>
          添加规则集
        </Button>
      </div>
      {!snapshot.configuration.ruleSources?.length ? (
        <p className="sectionempty">从 URL 导入一组规则，集中管理与更新。</p>
      ) : null}
      {snapshot.configuration.ruleSources?.map((source) => (
        <div className="subscriptionrow" key={source.id}>
          <div>
            <strong>{source.name}</strong>
            <small>
              {source.count} 条 ·{" "}
              {source.updatedAt
                ? new Date(source.updatedAt).toLocaleString()
                : "尚未更新"}
            </small>
            <TaskError message={source.error} />
          </div>
          <Button
            className="quiet"
            pending={Boolean(busy)}
            onClick={() =>
              run(() => mutation("ruleset.refresh", { id: source.id }))
            }
          >
            更新
          </Button>
          <ActionMenu label={`管理规则集 ${source.name}`}>
            <ConfirmAction
              label="移除规则集"
              title={`移除「${source.name}」？`}
              description={`该来源及其 ${source.count} 条规则将一并移除。其余手动规则会保留。`}
              disabled={busy}
              onConfirm={() => mutation("ruleset.remove", { id: source.id })}
            />
          </ActionMenu>
        </div>
      ))}
      {adding ? (
        <Modal
          title="添加规则集"
          description="导入域名列表或单条件 sing-box JSON 规则。"
          onClose={close}
          busy={task.pending}
          onCancelRequest={() => {
            void task.cancel();
          }}
          icon="rules"
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!draft.value.url.startsWith("https://")) {
                setUrlError("规则集链接需要以 https:// 开头。");
                return;
              }
              void task.execute(async () => {
                await task.request("ruleset.import", draft.value);
                await draft.clear({ ...draft.value, name: "", url: "" });
                close();
              });
            }}
          >
            <Field id="ruleset-name" label="名称">
              <input
                id="ruleset-name"
                autoFocus
                data-autofocus="true"
                required
                value={draft.value.name}
                onChange={(event) => draft.change({ name: event.target.value })}
              />
            </Field>
            <Field id="ruleset-url" label="HTTPS 来源" error={urlError}>
              <input
                id="ruleset-url"
                required
                type="url"
                spellCheck={false}
                aria-invalid={!!urlError}
                aria-describedby={urlError ? "ruleset-url-hint" : undefined}
                value={draft.value.url}
                placeholder="https://example.com/rules.txt"
                onChange={(event) => {
                  setUrlError("");
                  draft.change({ url: event.target.value });
                }}
              />
            </Field>
            <Field id="ruleset-format" label="格式">
              <Combobox
                id="ruleset-format"
                label="格式"
                value={draft.value.format}
                options={[
                  { value: "domain-list", label: "域名列表" },
                  { value: "sing-box-json", label: "sing-box JSON" },
                ]}
                onChange={(format) => draft.change({ format })}
              />
            </Field>
            <Field id="ruleset-outlet" label="规则出口">
              <Combobox
                id="ruleset-outlet"
                label="规则集出口"
                value={draft.value.outbound}
                options={outletChoices(snapshot.configuration)}
                onChange={(outbound) => draft.change({ outbound })}
              />
            </Field>
            <TaskError message={task.error || draft.error} />
            <FormFooter
              onClose={close}
              pending={task.pending}
              ready={draft.ready}
              label="导入规则集"
            />
          </form>
        </Modal>
      ) : null}
    </section>
  );
}
