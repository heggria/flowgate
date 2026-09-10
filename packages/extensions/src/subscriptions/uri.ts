import { aead, makeNode, tlsOptions, transportOptions } from "./nodes";
import {
  base64,
  boolean,
  fail,
  integer,
  record,
  ParseContext,
} from "./context";
import { SUBSCRIPTION_LIMITS } from "../../../contracts/src/subscriptions";

export function parseUris(input: string, context: ParseContext) {
  const content = input.includes("://") ? input : base64(input);
  const lines = content.split(/\r?\n/);
  if (
    lines.length > SUBSCRIPTION_LIMITS.lines ||
    lines.some(
      (line) => Buffer.byteLength(line) > SUBSCRIPTION_LIMITS.lineBytes,
    )
  )
    fail("LINE_LIMIT", "URI 订阅行数或单行长度超过限制。");
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    context.entry(() => {
      if (line.startsWith("vmess://")) {
        const p = record(JSON.parse(base64(line.slice(8))));
        context.unsupported(Object.keys(p), [
          "v",
          "ps",
          "remark",
          "add",
          "port",
          "id",
          "aid",
          "scy",
          "net",
          "type",
          "host",
          "path",
          "tls",
          "sni",
          "alpn",
          "fp",
          "allowInsecure",
          "alterId",
          "headerType",
          "service_name",
          "verify_cert",
          "class",
          "group",
          "ratio",
          "is_soga",
          "soga_node_id",
        ]);
        if (
          (p.type && p.type !== "none") ||
          (p.headerType && p.headerType !== "none")
        )
          fail("UNSUPPORTED_HEADER", "此 VMess 伪装头尚不支持。");
        if (p.tls && p.tls !== "tls" && p.tls !== "none")
          fail("UNSUPPORTED_TLS", "此 TLS 模式尚不支持。");
        const o: Record<string, any> = {
          uuid: p.id,
          security: p.scy || "auto",
          alter_id: aead(context, integer(p.aid ?? p.alterId ?? 0)),
        };
        if (p.tls === "tls")
          o.tls = tlsOptions(
            true,
            {
              sni: p.sni || p.host,
              alpn: p.alpn || undefined,
              fingerprint: p.fp || undefined,
              insecure:
                p.allowInsecure ??
                (p.verify_cert === undefined
                  ? undefined
                  : !boolean(p.verify_cert)),
            },
            context,
          );
        const transport = transportOptions(p.net, {
          path: p.path,
          host: p.host,
          serviceName: p.service_name || p.path,
        });
        if (transport) o.transport = transport;
        return information(
          makeNode("vmess", p.ps ?? p.remark, p.add, p.port, o),
          context,
        );
      }
      // SIP002 permits both base64 userinfo and the historical fully encoded form.
      let uri = line;
      if (
        line.startsWith("ss://") &&
        !line.slice(5).split("#")[0].includes("@")
      ) {
        const [encoded, fragment] = line.slice(5).split("#");
        uri = `ss://${base64(encoded)}${fragment === undefined ? "" : `#${fragment}`}`;
      }
      const u = new URL(uri);
      const type = u.protocol.slice(0, -1).toLowerCase();
      const p = Object.fromEntries(u.searchParams);
      if ([...u.searchParams.keys()].length !== Object.keys(p).length)
        fail("DUPLICATE_PARAMETER", "URI 参数重复。");
      context.unsupported(Object.keys(p), [
        "security",
        "sni",
        "peer",
        "allowInsecure",
        "insecure",
        "alpn",
        "fp",
        "pbk",
        "sid",
        "flow",
        "type",
        "path",
        "host",
        "serviceName",
        "plugin",
        "obfs",
        "obfs-password",
        "upmbps",
        "downmbps",
        "congestion_control",
        "udp_relay_mode",
        "disable_sni",
        "heartbeat",
        "encryption",
      ]);
      if (p.encryption && p.encryption !== "none")
        fail("UNSUPPORTED_ENCRYPTION", "不支持此 VLESS 加密扩展。");
      if (p.disable_sni && boolean(p.disable_sni))
        fail("UNSUPPORTED_TLS", "禁用 SNI 的参数尚不支持。");
      if (p.security && !["none", "tls", "reality"].includes(p.security))
        fail("UNSUPPORTED_TLS", "此 TLS 模式尚不支持。");
      const o: Record<string, any> = {};
      const user = decodeURIComponent(u.username),
        password = decodeURIComponent(u.password);
      if (type === "ss") {
        const auth = u.password
          ? `${user}:${password}`
          : user.includes(":")
            ? user
            : base64(user);
        const at = auth.indexOf(":");
        if (at < 1) fail("INVALID_AUTH", "Shadowsocks 认证格式无效。");
        o.method = auth.slice(0, at);
        o.password = auth.slice(at + 1);
        if (p.plugin) {
          const [plugin, ...opts] = p.plugin.split(";");
          o.plugin = plugin === "simple-obfs" ? "obfs-local" : plugin;
          o.plugin_opts = opts.join(";");
        }
      } else if (["vless", "tuic"].includes(type)) {
        o.uuid = user;
        if (type === "tuic") o.password = password;
        if (p.flow) o.flow = p.flow;
      } else if (["trojan", "hysteria2", "hy2"].includes(type))
        o.password = password ? `${user}:${password}` : user;
      else {
        o.username = user;
        o.password = password;
      }
      const enabled =
        ["tls", "reality"].includes(p.security) ||
        ["trojan", "hysteria2", "hy2", "tuic", "https"].includes(type);
      if (enabled || p.security)
        o.tls = tlsOptions(
          enabled,
          {
            sni: p.sni || p.peer,
            insecure:
              p.allowInsecure ??
              (p.verify_cert === undefined
                ? undefined
                : !boolean(p.verify_cert)) ??
              p.insecure,
            alpn: p.alpn,
            fingerprint:
              p.fp || (p.security === "reality" ? "chrome" : undefined),
            reality:
              p.security === "reality"
                ? { public_key: p.pbk, short_id: p.sid }
                : undefined,
          },
          context,
        );
      const transport = transportOptions(p.type, {
        path: p.path,
        host: p.host,
        serviceName: p.serviceName,
      });
      if (transport) o.transport = transport;
      if (p.obfs) o.obfs = { type: p.obfs, password: p["obfs-password"] };
      if (p.upmbps) o.up_mbps = integer(p.upmbps, 1, 1000000);
      if (p.downmbps) o.down_mbps = integer(p.downmbps, 1, 1000000);
      for (const key of ["congestion_control", "udp_relay_mode", "heartbeat"])
        if (p[key]) o[key] = p[key];
      return information(
        makeNode(
          type,
          decodeURIComponent(u.hash.slice(1)),
          u.hostname,
          u.port ||
            (["http"].includes(type)
              ? 80
              : ["socks", "socks5"].includes(type)
                ? 1080
                : 443),
          o,
        ),
        context,
      );
    }, index + 1);
  }
}
function information(node: ReturnType<typeof makeNode>, context: ParseContext) {
  if (/^(剩余流量|过期时间|到期时间|套餐到期)[：:]/.test(node.name)) {
    context.document.informationEntries++;
    context.add({
      code: "INFORMATION_ENTRY",
      severity: context.options.excludeInformation ? "info" : "warning",
      message: context.options.excludeInformation
        ? "已按所选选项排除形似流量或到期提示的 URI 条目。"
        : "部分 URI 条目形似流量或到期提示，默认保留；可在预览中选择排除。",
    });
    if (context.options.excludeInformation) return undefined;
  }
  return node;
}
