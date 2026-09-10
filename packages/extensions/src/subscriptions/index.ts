import { createHash } from "node:crypto";
import type {
  SubscriptionDocument,
  SubscriptionFormat,
  SubscriptionParseOptions,
} from "../../../contracts/src/subscriptions";
import {
  SUBSCRIPTION_PARSER_VERSION,
  SUBSCRIPTION_LIMITS,
} from "../../../contracts/src/subscriptions";
import { fail, ParseContext, safeError } from "./context";
import { parseClash, parseJson } from "./structured";
import { parseIni } from "./ini";
import { parseUris } from "./uri";
import { assignment, sections, splitFields } from "./tokenizer";

const registry: Record<
  SubscriptionFormat,
  (input: string, context: ParseContext) => void
> = {
  "sing-box": parseJson,
  sip008: parseJson,
  clash: parseClash,
  uri: parseUris,
  "quantumult-x": parseIni,
  loon: parseIni,
  surge: parseIni,
  shadowrocket: parseIni,
};
function detect(input: string): SubscriptionFormat {
  if (/^\[\s*\{|^\{/.test(input)) {
    const data = JSON.parse(input);
    if (!Array.isArray(data)) {
      const lists = ["servers", "proxies", "outbounds"].filter((key) =>
        Array.isArray(data?.[key]),
      );
      if (lists.length > 1)
        fail("AMBIGUOUS_FORMAT", "配置包含多种节点列表，请明确选择来源格式。");
      if (lists[0] === "proxies") return "clash";
    }
    if (Array.isArray(data) && data[0]?.method && !data[0]?.type)
      return "sip008";
    return !Array.isArray(data) && Array.isArray(data?.servers)
      ? "sip008"
      : "sing-box";
  }
  if (/^\s*["']?proxies["']?\s*:/m.test(input)) return "clash";
  if (
    /^\[server_local\]/im.test(input) ||
    /^(?:vmess|shadowsocks|trojan|http|socks5)\s*=\s*(?:\[[^\]]+\]|[^,\s:]+):\d+/m.test(
      input,
    )
  )
    return "quantumult-x";
  if (/^\[proxy\]/im.test(input)) {
    for (const row of sections(input).get("proxy") ?? []) {
      try {
        const fields = splitFields(assignment(row.text)[1]);
        const parameter = fields[3];
        if (
          parameter &&
          (parameter.startsWith('"') ||
            parameter.startsWith("'") ||
            !parameter.includes("="))
        )
          return "loon";
      } catch {
        /* The adapter reports line diagnostics after format selection. */
      }
    }
    if (/\b(?:username|vmess-aead|encrypt-method)\s*=/i.test(input))
      return "surge";
    return "shadowrocket";
  }
  return "uri";
}
export function parseSubscriptionDocument(
  raw: string,
  options: SubscriptionParseOptions = {},
): SubscriptionDocument {
  try {
    if (
      typeof raw !== "string" ||
      Buffer.byteLength(raw) > SUBSCRIPTION_LIMITS.bytes
    )
      fail("BODY_LIMIT", "订阅内容超过 4 MB 限制。");
    const input = raw.replace(/^\uFEFF/, "").trim();
    if (!input || /^\s*<(?:!doctype|html|\?xml)/i.test(input))
      fail("INVALID_CONTENT", "来源返回了空内容或网页，请确认订阅地址。");
    const lines = input.split(/\r?\n/);
    const format = options.format ?? detect(input);
    if (
      lines.length > SUBSCRIPTION_LIMITS.lines ||
      (!(format === "uri" && !input.includes("://")) &&
        lines.some(
          (line) => Buffer.byteLength(line) > SUBSCRIPTION_LIMITS.lineBytes,
        ))
    )
      fail("LINE_LIMIT", "订阅行数或单行长度超过限制。");
    if (!Object.hasOwn(registry, format))
      fail("UNKNOWN_FORMAT", "不支持此订阅格式。");
    const document: SubscriptionDocument = {
      version: 2,
      parserVersion: SUBSCRIPTION_PARSER_VERSION,
      format,
      digest: createHash("sha256").update(input).digest("hex"),
      nodes: [],
      metadata: {},
      diagnostics: [],
      rejected: 0,
      informationEntries: 0,
      profile: { groups: [], rules: [], sections: [], remoteResources: 0 },
    };
    const context = new ParseContext(document, options);
    registry[format](input, context);
    if (!document.nodes.length)
      fail("NO_NODES", "订阅没有可导入的节点；请检查来源格式与连接参数。");
    if (document.profile.remoteResources)
      context.add({
        code: "REMOTE_RESOURCES",
        severity: "error",
        message: "来源包含远程规则、节点或脚本资源；未执行或自动下载这些资源。",
      });
    return document;
  } catch (error) {
    throw new Error(safeError(error));
  }
}
