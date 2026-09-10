import {
  aead,
  clientFlags,
  makeNode,
  tlsOptions,
  transportOptions,
} from "./nodes";
import { boolean, fail, integer, ParseContext } from "./context";
import {
  assignment,
  endpoint,
  parameters,
  scalar,
  sections,
  splitFields,
} from "./tokenizer";
import { readRule } from "./structured";

function decorate(
  o: Record<string, any>,
  p: Record<string, string>,
  context: ParseContext,
  qx: boolean,
) {
  const obfs = p.obfs;
  if (qx && obfs && !["ws", "wss", "over-tls", "http", "tls"].includes(obfs))
    fail("UNSUPPORTED_OBFS", "节点混淆类型尚不支持。");
  const enabled = qx
    ? ["wss", "over-tls"].includes(obfs) || boolean(p["over-tls"])
    : boolean(p.tls ?? p["over-tls"]);
  if (enabled || p.tls !== undefined || p["over-tls"] !== undefined)
    o.tls = tlsOptions(
      enabled,
      {
        sni: p.sni ?? p["tls-host"] ?? p["obfs-host"],
        insecure: qx
          ? !boolean(p["tls-verification"], true)
          : boolean(p["skip-cert-verify"]),
        alpn: p.alpn,
      },
      context,
    );
  let headers: Record<string, string> | undefined;
  if (p["ws-headers"]) {
    headers = Object.create(null);
    for (const field of splitFields(p["ws-headers"], "|")) {
      const separator = field.indexOf(":");
      const [key, value] =
        separator > 0
          ? [
              field.slice(0, separator).trim(),
              field.slice(separator + 1).trim(),
            ]
          : assignment(field);
      if (Object.hasOwn(headers!, key))
        fail("DUPLICATE_HEADER", "传输请求头重复。");
      headers![key] = scalar(value);
    }
  }
  const transport = transportOptions(
    qx
      ? ["ws", "wss"].includes(obfs)
        ? "ws"
        : "tcp"
      : (p.transport ?? (boolean(p.ws) ? "ws" : "tcp")),
    {
      path: p.path ?? p["ws-path"] ?? p["obfs-uri"],
      host: p.host ?? p["obfs-host"],
      headers,
    },
  );
  if (transport) o.transport = transport;
  if (["http", "tls"].includes(obfs)) {
    if (!o.method) fail("UNSUPPORTED_OBFS", "此协议不支持 Shadowsocks 混淆。");
    o.plugin = "obfs-local";
    o.plugin_opts = `obfs=${obfs}${p["obfs-host"] ? `;obfs-host=${p["obfs-host"]}` : ""}`;
  } else if (!qx && obfs)
    fail("UNSUPPORTED_OBFS", "此格式的混淆设置尚不支持。");
}

export function parseIni(input: string, context: ParseContext) {
  const document = sections(input);
  const qx = context.document.format === "quantumult-x";
  const nodeSection = qx ? "server_local" : "proxy";
  const rows = document.get(nodeSection) ?? document.get("preamble") ?? [];
  for (const row of rows)
    context.entry(() => {
      const [nameOrType, rhs] = assignment(row.text);
      const fields = splitFields(rhs);
      let type = qx
        ? nameOrType.toLowerCase()
        : scalar(fields.shift()!).toLowerCase();
      if (["direct", "reject", "reject-tinygif"].includes(type))
        return undefined;
      let server: string, port: number;
      if (qx) ({ server, port } = endpoint(scalar(fields.shift()!)));
      else {
        server = scalar(fields.shift()!);
        port = integer(scalar(fields.shift()!), 1);
      }
      const o: Record<string, any> = {};
      const loon = context.document.format === "loon";
      if (loon) {
        if (["vmess", "shadowsocks", "ss"].includes(type)) {
          const cipher = scalar(fields.shift()!);
          o[type === "vmess" ? "security" : "method"] = cipher;
          o[type === "vmess" ? "uuid" : "password"] = scalar(fields.shift()!);
        } else if (["trojan", "vless"].includes(type))
          o[type === "vless" ? "uuid" : "password"] = scalar(fields.shift()!);
        else if (
          ["http", "https", "socks5"].includes(type) &&
          fields.length &&
          !fields[0].includes("=")
        ) {
          o.username = scalar(fields.shift()!);
          o.password = scalar(fields.shift()!);
        }
      }
      const p = parameters(fields);
      context.unsupported(Object.keys(p), [
        "method",
        "password",
        "username",
        "tag",
        "aead",
        "vmess-aead",
        "encrypt-method",
        "alterId",
        "obfs",
        "obfs-host",
        "obfs-uri",
        "tls-verification",
        "tls-host",
        "udp-relay",
        "fast-open",
        "udp",
        "tfo",
        "tls",
        "over-tls",
        "sni",
        "skip-cert-verify",
        "ws",
        "ws-path",
        "ws-headers",
        "transport",
        "path",
        "host",
        "alpn",
        "flow",
        "uuid",
      ]);
      if (type === "vmess") {
        o.uuid ??= qx ? p.password : (p.username ?? p.password ?? p.uuid);
        o.security ??=
          p.method ??
          p["encrypt-method"] ??
          (context.document.format === "surge" ? "aes-128-gcm" : "auto");
        const source =
          p.alterId !== undefined
            ? integer(p.alterId)
            : boolean(
                  p["vmess-aead"] ?? p.aead,
                  context.document.format !== "surge",
                )
              ? 0
              : 1;
        o.alter_id = aead(
          context,
          source,
          context.document.format === "surge" && p["vmess-aead"] === undefined,
        );
      } else if (["ss", "shadowsocks"].includes(type)) {
        o.method ??= p.method ?? p["encrypt-method"];
        o.password ??= p.password;
      } else if (type === "vless") {
        o.uuid ??= p.uuid ?? p.username ?? p.password;
        if (p.flow) o.flow = p.flow;
      } else {
        if (p.password !== undefined) o.password = p.password;
        if (p.username !== undefined) o.username = p.username;
      }
      if (["trojan", "hysteria2", "https"].includes(type)) {
        if (qx) p["over-tls"] ??= "true";
        else p.tls ??= "true";
      }
      decorate(o, p, context, qx);
      clientFlags(type, o, p["udp-relay"] ?? p.udp, p["fast-open"] ?? p.tfo);
      return makeNode(type, qx ? p.tag : nameOrType, server, port, o);
    }, row.line);
  for (const [name, lines] of document) {
    if (name === nodeSection || name === "preamble") continue;
    context.document.profile.sections.push({ name, count: lines.length });
    if (/remote|resource/i.test(name))
      context.document.profile.remoteResources += lines.length;
    if (["rule", "filter_local"].includes(name))
      for (const row of lines) readRule(row.text, context, row.line);
    else if (["proxy group", "proxy-group", "policy"].includes(name))
      for (const row of lines) {
        try {
          const [label, rhs] = assignment(row.text);
          const fields = splitFields(rhs).map(scalar);
          const type = qx ? label : fields.shift()!;
          const groupName = qx ? fields.shift()! : label;
          const members = fields.filter((s) => !s.includes("="));
          const p = parameters(fields.filter((s) => s.includes("=")));
          context.document.profile.groups.push({
            name: groupName,
            type,
            members,
            url: p.url ?? p["check-interval-url"],
            interval: p.interval ? integer(p.interval, 1, 604800) : undefined,
            tolerance: p.tolerance ? integer(p.tolerance) : undefined,
          });
          if (
            Object.keys(p).some(
              (k) => !["url", "interval", "tolerance", "img-url"].includes(k),
            )
          )
            context.add({
              code: "GROUP_SEMANTICS",
              severity: "error",
              message: "策略组包含尚不能无损迁移的参数。",
              line: row.line,
            });
        } catch {
          context.add({
            code: "INVALID_PROFILE_GROUP",
            severity: "error",
            message: "策略组格式无法解析。",
            line: row.line,
          });
        }
      }
    else if (name === "general" || name === "dns") {
      const dns = (context.document.profile.dns ??= {
        servers: [],
        unsupportedFields: [],
      });
      for (const row of lines) {
        try {
          const [key, value] = assignment(row.text);
          if (["dns-server", "server"].includes(key))
            dns.servers.push(...splitFields(value).map(scalar));
          else dns.unsupportedFields.push("source-setting");
        } catch {
          dns.unsupportedFields.push("source-setting");
        }
      }
    } else if (lines.length)
      context.add({
        code: "UNSUPPORTED_PROFILE_SECTION",
        severity: "error",
        message:
          "来源包含脚本、重写、证书或其他尚不支持的配置段；节点可独立导入。",
      });
  }
}
