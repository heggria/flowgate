import { randomUUID } from "node:crypto";
import type { NodeConfig } from "../../../contracts/src/index";
import { validateNodeOptions } from "../../../domain/src/node-options";
import { boolean, fail, integer, record, text, ParseContext } from "./context";

export function makeNode(
  typeValue: unknown,
  name: unknown,
  server: unknown,
  port: unknown,
  options: Record<string, unknown>,
): NodeConfig {
  const aliases: Record<string, NodeConfig["type"]> = {
    ss: "shadowsocks",
    shadowsocks: "shadowsocks",
    vmess: "vmess",
    vless: "vless",
    trojan: "trojan",
    hysteria2: "hysteria2",
    hy2: "hysteria2",
    tuic: "tuic",
    http: "http",
    https: "http",
    socks: "socks",
    socks5: "socks",
  };
  const type = aliases[String(typeValue).toLowerCase()];
  if (!type)
    return fail("UNSUPPORTED_PROTOCOL", "此节点协议尚未被当前内核适配层支持。");
  const node: NodeConfig = {
    id: randomUUID(),
    name: text(String(name || server || "节点"), 200),
    type,
    server: text(String(server ?? ""), 255).replace(/^\[([^\]]+)\]$/, "$1"),
    port: integer(port, 1),
    options,
    optionsVersion: 2,
  };
  if (!node.server || /[\s/@?#\\]/.test(node.server))
    fail("INVALID_SERVER", "节点服务器地址无效。");
  try {
    validateNodeOptions(type, options, true);
  } catch {
    fail(
      "INVALID_OPTIONS",
      "节点认证、TLS、传输或协议参数无效，未导入此节点。",
    );
  }
  return node;
}
export function aead(
  context: ParseContext,
  source: number,
  ambiguous = false,
): number {
  if (
    ambiguous &&
    (!context.options.vmessAead || context.options.vmessAead === "source")
  )
    context.add({
      code: "AEAD_SOURCE_DEFAULT",
      severity: "warning",
      message:
        "Surge 未指定 VMess AEAD，已按源格式的旧握手默认值解释；可在转换选项中明确覆盖。",
    });
  if (context.options.vmessAead === "enabled") return 0;
  if (context.options.vmessAead === "legacy") return 1;
  return source;
}
export function clientFlags(
  type: string,
  options: Record<string, unknown>,
  udp: unknown,
  fastOpen: unknown,
) {
  if (udp !== undefined && !boolean(udp) && !["http", "https"].includes(type))
    options.network = "tcp";
  if (fastOpen !== undefined) options.tcp_fast_open = boolean(fastOpen);
}
export function tlsOptions(
  enabled: boolean,
  values: Record<string, any>,
  context: ParseContext,
) {
  const tls: Record<string, unknown> = { enabled };
  if (values.sni) tls.server_name = text(values.sni);
  if (values.insecure !== undefined) tls.insecure = boolean(values.insecure);
  if (values.alpn !== undefined)
    tls.alpn = Array.isArray(values.alpn)
      ? values.alpn
      : String(values.alpn)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
  if (values.fingerprint)
    tls.utls = { enabled: true, fingerprint: values.fingerprint };
  if (values.reality) {
    const r = record(values.reality);
    tls.reality = {
      enabled: true,
      public_key: r.public_key,
      short_id: r.short_id ?? "",
    };
  }
  if (tls.insecure === true)
    context.add({
      code: "TLS_INSECURE",
      severity: "warning",
      message: "此来源要求跳过节点证书验证，该设置已明确保留。",
    });
  if (!enabled && (values.reality || values.fingerprint || values.alpn))
    fail("TLS_REQUIRED", "TLS 扩展参数缺少已启用的 TLS。");
  return tls;
}
export function transportOptions(kind: unknown, options: Record<string, any>) {
  if (kind === undefined || kind === "" || kind === "tcp" || kind === "none")
    return undefined;
  if (kind === "ws")
    return {
      type: "ws",
      path: options.path || "/",
      headers: options.headers ?? (options.host ? { Host: options.host } : {}),
      ...(options.earlyData !== undefined
        ? {
            max_early_data: integer(options.earlyData, 0, 1048576),
            early_data_header_name:
              options.earlyHeader || "Sec-WebSocket-Protocol",
          }
        : {}),
    };
  if (kind === "grpc")
    return { type: "grpc", service_name: options.serviceName || "" };
  if (kind === "h2" || kind === "http")
    return {
      type: "http",
      path: options.path || "/",
      ...(options.host
        ? { host: Array.isArray(options.host) ? options.host : [options.host] }
        : {}),
      ...(options.method ? { method: options.method } : {}),
      ...(options.headers ? { headers: options.headers } : {}),
    };
  if (kind === "httpupgrade")
    return {
      type: "httpupgrade",
      host: options.host || "",
      path: options.path || "/",
      ...(options.headers ? { headers: options.headers } : {}),
    };
  return fail(
    "UNSUPPORTED_TRANSPORT",
    "此传输类型尚未支持，未将它静默改成 TCP。",
  );
}
