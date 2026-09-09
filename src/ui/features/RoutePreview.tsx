import { useDraft } from "../drafts";
import { useState } from "react";
import { client } from "../../../packages/client/src/index";
export function RoutePreview() {
  const draft = useDraft("preview", { target: "" });
  const target = draft.value.target,
    setTarget = (target: string) => draft.change({ target });
  const [result, setResult] = useState("");
  return (
    <section className="resourcesection routepreview">
      <h2>路径预览</h2>
      <form
        className="inline"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const r = await client.request<{ outbound: string }>(
              "policy.explain",
              { target },
            );
            setResult("配置匹配出口：" + r.outbound + "。尚未发起实际请求。");
          } catch (e) {
            setResult(String(e));
          }
        }}
      >
        <input
          aria-label="目标域名"
          placeholder="输入域名，例如 example.com"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          required
        />
        <button className="secondary">检查路径</button>
      </form>
      {result ? <p role="status">{result}</p> : null}
    </section>
  );
}
