import type {
  ConversionDiagnostic,
  SubscriptionDocument,
  SubscriptionParseOptions,
} from "../../../contracts/src/subscriptions";
import { SUBSCRIPTION_LIMITS } from "../../../contracts/src/subscriptions";
import type { NodeConfig } from "../../../contracts/src/index";

export class SubscriptionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly field?: string,
  ) {
    super(message);
  }
}
export function fail(code: string, message: string, field?: string): never {
  throw new SubscriptionError(code, message, field);
}
export const safeError = (error: unknown) =>
  error instanceof SubscriptionError
    ? error.message
    : "订阅内容无法解析，请检查格式或更换来源。";
export class ParseContext {
  constructor(
    readonly document: SubscriptionDocument,
    readonly options: SubscriptionParseOptions = {},
  ) {}
  add(diagnostic: ConversionDiagnostic) {
    const old = this.document.diagnostics.find(
      (d) =>
        d.code === diagnostic.code &&
        d.field === diagnostic.field &&
        d.message === diagnostic.message,
    );
    if (old) {
      old.count = (old.count ?? 1) + (diagnostic.count ?? 1);
      return;
    }
    if (this.document.diagnostics.length < SUBSCRIPTION_LIMITS.diagnostics)
      this.document.diagnostics.push({
        ...diagnostic,
        count: diagnostic.count ?? 1,
      });
  }
  entry(make: () => NodeConfig | undefined, line?: number) {
    if (
      this.document.nodes.length + this.document.rejected >=
      SUBSCRIPTION_LIMITS.nodes
    )
      fail("NODE_LIMIT", "订阅节点超过数量限制。");
    try {
      const node = make();
      if (node) this.document.nodes.push(node);
    } catch (error) {
      this.document.rejected++;
      this.add({
        code: error instanceof SubscriptionError ? error.code : "INVALID_NODE",
        severity: "error",
        message: safeError(error),
        field: error instanceof SubscriptionError ? error.field : undefined,
        line,
      });
    }
  }
  unsupported(keys: string[], supported: readonly string[]) {
    const key = keys.find((k) => !supported.includes(k));
    // Field names themselves may be hostile. Never echo arbitrary input into diagnostics.
    if (key)
      fail(
        "UNSUPPORTED_FIELD",
        "节点包含尚不支持的字段，已保留原配置而不静默丢弃连接参数。",
      );
  }
}
export function record(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("INVALID_OBJECT", "配置对象格式无效。");
  const object = value as Record<string, unknown>;
  if (
    Object.keys(object).some((k) =>
      ["__proto__", "prototype", "constructor"].includes(k),
    )
  )
    fail("UNSAFE_KEY", "配置包含无效字段。");
  return object;
}
export function text(value: unknown, max = 2000): string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)
  )
    fail("INVALID_TEXT", "配置文本字段无效。");
  return value;
}
export function boolean(value: unknown, fallback = false): boolean {
  if (value === undefined || value === "") return fallback;
  if (value === true || value === "true" || value === 1 || value === "1")
    return true;
  if (value === false || value === "false" || value === 0 || value === "0")
    return false;
  return fail("INVALID_BOOLEAN", "配置布尔值无效。");
}
export function integer(value: unknown, minimum = 0, maximum = 65535): number {
  if (typeof value === "string" && !/^\d+$/.test(value))
    fail("INVALID_NUMBER", "配置数值无效。");
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum)
    fail("INVALID_NUMBER", "配置数值超出范围。");
  return number;
}
export function strings(value: unknown, limit = 100): string[] {
  if (!Array.isArray(value) || value.length > limit)
    fail("INVALID_LIST", "配置列表无效。");
  return value.map((v) => text(v));
}
export function base64(value: string): string {
  const compact = value.replace(/\s/g, "");
  if (
    !compact ||
    !/^[A-Za-z0-9+/_-]*={0,2}$/.test(compact) ||
    compact.replace(/=/g, "").length % 4 === 1
  )
    fail("INVALID_BASE64", "Base64 订阅编码无效。");
  const buffer = Buffer.from(compact, "base64");
  const canonical = (s: string) =>
    s.replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
  if (canonical(buffer.toString("base64")) !== canonical(compact))
    fail("INVALID_BASE64", "Base64 订阅编码无效。");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return fail("INVALID_UTF8", "订阅不是有效的 UTF-8 文本。");
  }
}
