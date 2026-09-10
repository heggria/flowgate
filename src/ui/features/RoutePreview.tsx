import { useDraft } from "../drafts";
import { useState } from "react";
import { Button, Field, TaskError, useTask } from "../components";
import type {
  Configuration,
  Rule,
} from "../../../packages/contracts/src/index";
import { outletChoices } from "../components";
export function RoutePreview({ config }: { config: Configuration }) {
  const draft = useDraft("preview", { target: "" });
  const [result, setResult] = useState<{
    text: string;
    revision: number;
  } | null>(null);
  const task = useTask();
  return (
    <section className="resourcesection routepreview">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setResult(null);
          await task.execute(async () => {
            const r = await task.request<{
              outbound: string;
              target: string;
              revision: number;
              rule: Rule | null;
            }>("policy.explain", { target: draft.value.target });
            if (r.revision !== config.revision)
              throw new Error("配置已变化，请重新检查路径");
            const id =
              r.outbound === "select"
                ? config.settings.selectedNode
                : r.outbound;
            const name =
              outletChoices(config).find((o) => o.value === id)?.label ?? id;
            const index = config.rules.findIndex(
              (rule) => rule.id === r.rule?.id,
            );
            setResult({
              revision: r.revision,
              text: `${r.target} → ${index >= 0 ? `第 ${index + 1} 条 · ${r.rule!.value}` : "默认规则"} → ${name} · 已保存配置`,
            });
          });
        }}
      >
        <Field
          id="preview-target"
          label="目标域名"
          hint="检查已保存的域名规则；不模拟 IP、进程、DNS 或实际请求。"
        >
          <div className="inline">
            <input
              id="preview-target"
              placeholder="输入域名，例如 example.com"
              value={draft.value.target}
              onChange={(e) => {
                draft.change({ target: e.target.value });
                setResult(null);
                task.setError("");
              }}
              required
              disabled={task.pending}
            />
            <Button
              className="secondary"
              pending={task.pending}
              disabled={!draft.ready}
            >
              {task.pending ? "检查中…" : "检查路径"}
            </Button>
          </div>
        </Field>
        <TaskError message={task.error || draft.error} />
        {result ? (
          <p className="inlinestatus" role="status">
            {result.text}
            {result.revision !== config.revision
              ? " · 配置已变化，请重新检查"
              : ""}
          </p>
        ) : null}
      </form>
    </section>
  );
}
