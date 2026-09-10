import { fail, text } from "./context";
/** Split separators only outside quoted strings/brackets. Preserve escapes until scalar decoding. */
export function splitFields(input: string, separator = ","): string[] {
  const fields: string[] = [];
  let current = "",
    quote = "",
    escaped = false,
    depth = 0;
  for (const character of input) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      current += character;
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = "";
      current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (character === "[" || character === "{") depth++;
    if (character === "]" || character === "}") {
      if (--depth < 0) fail("INVALID_BRACKETS", "配置括号不匹配。");
    }
    if (character === separator && depth === 0) {
      fields.push(current.trim());
      current = "";
    } else current += character;
  }
  if (quote || escaped || depth)
    fail("INVALID_QUOTING", "配置中的引号、转义或括号不完整。");
  fields.push(current.trim());
  return fields;
}
export function scalar(input: string): string {
  const value = input.trim();
  if (value.startsWith('"')) {
    try {
      return text(JSON.parse(value), 64000);
    } catch {
      return fail("INVALID_QUOTING", "配置字符串引号无效。");
    }
  }
  if (value.startsWith("'") && value.endsWith("'"))
    return value.slice(1, -1).replace(/\\(['\\])/g, "$1");
  return value.replace(/\\([,=;\\])/g, "$1");
}
export function assignment(input: string): [string, string] {
  const parts = splitFields(input, "=");
  if (parts.length < 2 || !parts[0])
    fail("INVALID_ASSIGNMENT", "配置行缺少名称或赋值。");
  return [scalar(parts.shift()!), parts.join("=").trim()];
}
export function parameters(fields: string[]): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (const field of fields) {
    const [key, value] = assignment(field);
    if (
      ["__proto__", "constructor", "prototype"].includes(key) ||
      Object.hasOwn(result, key)
    )
      fail("DUPLICATE_PARAMETER", "配置参数重复或无效。");
    result[key] = scalar(value);
  }
  return result;
}
export function endpoint(input: string): { server: string; port: number } {
  const match = input.match(/^(?:\[([^\]]+)\]|([^:\s]+)):(\d+)$/);
  if (!match)
    return fail("INVALID_ENDPOINT", "节点地址格式无效；IPv6 地址需要方括号。");
  return { server: match[1] || match[2], port: Number(match[3]) };
}
export interface SectionLine {
  text: string;
  line: number;
}
export function sections(input: string): Map<string, SectionLine[]> {
  const output = new Map<string, SectionLine[]>();
  let name = "preamble";
  for (const [index, raw] of input.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || /^(#|;|\/\/)/.test(line)) continue;
    const header = line.match(
      /^\[([A-Za-z][A-Za-z _-]{0,60})\]\s*(?:[#;].*)?$/,
    );
    if (header) {
      name = header[1].toLowerCase();
      if (!output.has(name)) output.set(name, []);
      continue;
    }
    const rows = output.get(name) ?? [];
    rows.push({ text: line, line: index + 1 });
    output.set(name, rows);
  }
  return output;
}
