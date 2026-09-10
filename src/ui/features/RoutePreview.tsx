import { useDraft } from "../drafts";
import { useState } from "react";
import { Button, Field, TaskError, useTask } from "../components";
export function RoutePreview() {
  const draft = useDraft("preview", { target: "" });
  const [result, setResult] = useState("");
  const task = useTask();
  return (
    <section className="resourcesection routepreview">
      <div className="groupheading">
        <h2>路径预览</h2>
        <p>根据当前配置检查目标的匹配出口。</p>
      </div>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setResult("");
          await task.execute(async () => {
            const r = await task.request<{ outbound: string }>(
              "policy.explain",
              { target: draft.value.target },
            );
            setResult("配置匹配出口：" + r.outbound + "。尚未发起实际请求。");
          });
        }}
      >
        <Field id="preview-target" label="目标域名">
          <div className="inline">
            <input
              id="preview-target"
              placeholder="输入域名，例如 example.com"
              value={draft.value.target}
              onChange={(e) => {
                draft.change({ target: e.target.value });
                setResult("");
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
            {result}
          </p>
        ) : null}
      </form>
    </section>
  );
}
