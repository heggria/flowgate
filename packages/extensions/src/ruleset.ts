import { createHash } from "node:crypto";
import type { Rule } from "../../contracts/src/index";
export function parseRuleSet(payload: {
  text: string;
  format: string;
  sourceId: string;
  outbound: string;
}): Rule[] {
  if (
    typeof payload.text !== "string" ||
    Buffer.byteLength(payload.text) > 4 * 1024 * 1024
  )
    throw new Error("规则集超过大小限制");
  const rules: Rule[] = [];
  const seen = new Set<string>();
  const add = (kind: Rule["kind"], value: unknown) => {
    if (typeof value !== "string" || !value.trim() || value.length > 500)
      throw new Error("规则值无效");
    value = value.trim();
    const key = kind + ":" + value;
    if (seen.has(key)) return;
    seen.add(key);
    if (rules.length >= 10000) throw new Error("规则集超过条目限制");
    rules.push({
      id: createHash("sha256")
        .update(payload.sourceId + ":" + key)
        .digest("hex")
        .slice(0, 32),
      kind,
      value: value as string,
      outbound: payload.outbound,
      sourceId: payload.sourceId,
    });
  };
  if (payload.format === "domain-list") {
    for (const line of payload.text.split(/\r?\n/)) {
      const value = line.trim();
      if (!value || value.startsWith("#")) continue;
      if (
        !/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z0-9-]+$/.test(
          value,
        )
      )
        throw new Error("域名列表含非域名条目");
      add("domain_suffix", value.toLowerCase());
    }
  } else if (payload.format === "sing-box-json") {
    const parsed = JSON.parse(payload.text);
    if (![1, 2, 3, 4].includes(parsed.version) || !Array.isArray(parsed.rules))
      throw new Error("规则集 JSON 结构无效");
    for (const rule of parsed.rules) {
      if (
        !rule ||
        typeof rule !== "object" ||
        Array.isArray(rule) ||
        Object.keys(rule).length !== 1
      )
        throw new Error("仅支持单一条件规则；不转换逻辑组合");
      for (const [kind, values] of Object.entries(rule)) {
        if (
          !["domain", "domain_suffix", "ip_cidr", "process_name"].includes(kind)
        )
          throw new Error("规则集含不支持的匹配类型");
        for (const value of Array.isArray(values) ? values : [values])
          add(kind as Rule["kind"], value);
      }
    }
  } else throw new Error("不支持的规则集格式");
  if (!rules.length) throw new Error("规则集为空");
  return rules;
}
