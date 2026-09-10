import { parseDocument } from "yaml";
import {
  aead,
  clientFlags,
  makeNode,
  tlsOptions,
  transportOptions,
} from "./nodes";
import {
  boolean,
  fail,
  integer,
  record,
  strings,
  ParseContext,
} from "./context";
import { splitFields, scalar } from "./tokenizer";

export function readRule(input: string, context: ParseContext, line?: number) {
  try {
    const parts = splitFields(input).map(scalar);
    const kind = parts.shift()!.toUpperCase();
    const terminal = ["FINAL", "MATCH"].includes(kind);
    const value = terminal ? "" : parts.shift();
    const outbound = parts.shift();
    if (value === undefined || !outbound)
      fail("INVALID_RULE", "分流规则格式无效。");
    context.document.profile.rules.push({
      kind,
      value,
      outbound,
      modifiers: parts,
      line,
    });
  } catch {
    context.add({
      code: "INVALID_PROFILE_RULE",
      severity: "error",
      message: "配置包含无法解析的分流规则；完整配置迁移需要先处理此问题。",
      line,
    });
  }
}

export function parseClash(input: string, context: ParseContext) {
  const yaml = parseDocument(input, { uniqueKeys: true });
  if (yaml.errors.length) fail("INVALID_YAML", "YAML 格式无效或包含重复字段。");
  const data = record(yaml.toJS({ maxAliasCount: 50 }));
  if (!Array.isArray(data.proxies)) fail("MISSING_NODES", "配置缺少节点列表。");
  for (const entry of data.proxies)
    context.entry(() => {
      const p = record(entry);
      context.unsupported(Object.keys(p), [
        "name",
        "type",
        "server",
        "port",
        "cipher",
        "password",
        "uuid",
        "alterId",
        "tls",
        "servername",
        "sni",
        "skip-cert-verify",
        "alpn",
        "client-fingerprint",
        "reality-opts",
        "network",
        "ws-opts",
        "grpc-opts",
        "h2-opts",
        "http-opts",
        "flow",
        "udp",
        "tfo",
        "ip-version",
        "username",
        "plugin",
        "plugin-opts",
        "up",
        "down",
        "obfs",
        "obfs-password",
        "congestion-controller",
        "udp-relay-mode",
        "reduce-rtt",
        "heartbeat-interval",
        "packet-encoding",
      ]);
      if (p["ip-version"] && p["ip-version"] !== "dual")
        fail("UNSUPPORTED_IP_STRATEGY", "节点指定的 IP 选择策略尚不支持。");
      const type = String(p.type).toLowerCase();
      const o: Record<string, any> = {};
      if (p.uuid !== undefined) o.uuid = p.uuid;
      if (p.password !== undefined) o.password = p.password;
      if (p.username !== undefined) o.username = p.username;
      if (type === "ss") o.method = p.cipher;
      if (type === "vmess") {
        o.security = p.cipher ?? "auto";
        o.alter_id = aead(context, integer(p.alterId ?? 0));
      }
      if (p.flow) o.flow = p.flow;
      if (p["packet-encoding"]) o.packet_encoding = p["packet-encoding"];
      const tls = boolean(
        p.tls,
        ["trojan", "hysteria2", "tuic"].includes(type),
      );
      if (
        tls ||
        p.tls !== undefined ||
        p["reality-opts"] ||
        p["client-fingerprint"] ||
        p.alpn
      )
        o.tls = tlsOptions(
          tls,
          {
            sni: p.sni ?? p.servername,
            insecure: p["skip-cert-verify"],
            alpn: p.alpn,
            fingerprint: p["client-fingerprint"],
            reality: p["reality-opts"]
              ? {
                  public_key: p["reality-opts"]["public-key"],
                  short_id: p["reality-opts"]["short-id"],
                }
              : undefined,
          },
          context,
        );
      const w = p["ws-opts"] === undefined ? {} : record(p["ws-opts"]);
      context.unsupported(Object.keys(w), [
        "path",
        "headers",
        "max-early-data",
        "early-data-header-name",
      ]);
      const g = p["grpc-opts"] === undefined ? {} : record(p["grpc-opts"]);
      context.unsupported(Object.keys(g), ["grpc-service-name"]);
      const h = p["h2-opts"] ?? p["http-opts"] ?? {};
      context.unsupported(Object.keys(record(h)), [
        "path",
        "host",
        "method",
        "headers",
      ]);
      if (Array.isArray(h.path) && h.path.length !== 1)
        fail("UNSUPPORTED_TRANSPORT", "多个 HTTP 传输路径无法无损迁移。");
      const transport = transportOptions(
        p.network,
        p.network === "ws"
          ? {
              path: w.path,
              headers: w.headers,
              earlyData: w["max-early-data"],
              earlyHeader: w["early-data-header-name"],
            }
          : p.network === "grpc"
            ? { serviceName: g["grpc-service-name"] }
            : { ...h, path: Array.isArray(h.path) ? h.path[0] : h.path },
      );
      if (transport) o.transport = transport;
      if (p.plugin) {
        const opts = record(p["plugin-opts"] ?? {});
        if (p.plugin === "obfs") {
          context.unsupported(Object.keys(opts), ["mode", "host"]);
          if (!["http", "tls"].includes(opts.mode))
            fail("UNSUPPORTED_OBFS", "不支持此 Shadowsocks 混淆。");
          o.plugin = "obfs-local";
          o.plugin_opts = `obfs=${opts.mode}${opts.host ? `;obfs-host=${opts.host}` : ""}`;
        } else if (p.plugin === "v2ray-plugin") {
          context.unsupported(Object.keys(opts), [
            "mode",
            "tls",
            "skip-cert-verify",
            "host",
            "path",
            "mux",
          ]);
          if (opts.mode && opts.mode !== "websocket")
            fail("UNSUPPORTED_PLUGIN", "不支持此插件模式。");
          o.plugin = "v2ray-plugin";
          o.plugin_opts = [
            boolean(opts.tls) ? "tls" : "",
            boolean(opts["skip-cert-verify"]) ? "skip-cert-verify" : "",
            opts.host ? `host=${opts.host}` : "",
            opts.path ? `path=${opts.path}` : "",
            boolean(opts.mux) ? "mux=1" : "mux=0",
          ]
            .filter(Boolean)
            .join(";");
        } else fail("UNSUPPORTED_PLUGIN", "不支持此 Shadowsocks 插件。");
      }
      for (const [from, to] of [
        ["up", "up_mbps"],
        ["down", "down_mbps"],
        ["congestion-controller", "congestion_control"],
        ["udp-relay-mode", "udp_relay_mode"],
      ])
        if (p[from] !== undefined)
          o[to] = ["up", "down"].includes(from)
            ? integer(p[from], 1, 1000000)
            : p[from];
      if (p.obfs) o.obfs = { type: p.obfs, password: p["obfs-password"] };
      if (p["reduce-rtt"] !== undefined)
        o.zero_rtt_handshake = boolean(p["reduce-rtt"]);
      if (p["heartbeat-interval"] !== undefined)
        o.heartbeat = `${integer(p["heartbeat-interval"], 1)}ms`;
      clientFlags(type, o, p.udp, p.tfo);
      return makeNode(type, p.name, p.server, p.port, o);
    });
  try {
    if (
      data["proxy-groups"] !== undefined &&
      !Array.isArray(data["proxy-groups"])
    )
      fail("INVALID_PROFILE", "策略组列表无效。");
    if (data.rules !== undefined && !Array.isArray(data.rules))
      fail("INVALID_PROFILE", "规则列表无效。");
    for (const raw of data["proxy-groups"] ?? []) {
      const p = record(raw);
      context.document.profile.groups.push({
        name: String(p.name),
        type: String(p.type),
        members: Array.isArray(p.proxies) ? strings(p.proxies, 5000) : [],
        url: p.url,
        interval: p.interval,
        tolerance: p.tolerance,
      });
      if (
        Object.keys(p).some(
          (k) =>
            ![
              "name",
              "type",
              "proxies",
              "url",
              "interval",
              "tolerance",
            ].includes(k),
        )
      )
        context.add({
          code: "GROUP_SEMANTICS",
          severity: "error",
          message: "策略组包含无法无损迁移的参数。",
        });
    }
    for (const rule of data.rules ?? []) readRule(String(rule), context);
    if (data.dns || data.hosts) {
      const dns = record(data.dns ?? {});
      context.document.profile.dns = {
        enabled: boolean(dns.enable, true),
        servers: Array.isArray(dns.nameserver) ? strings(dns.nameserver) : [],
        hosts: data.hosts,
        unsupportedFields: Object.keys(dns)
          .filter((k) => !["enable", "nameserver"].includes(k))
          .map(() => "source-setting"),
      };
    }
    const knownSections = [
      "proxy-groups",
      "rules",
      "dns",
      "hosts",
      "proxy-providers",
      "rule-providers",
    ];
    context.document.profile.sections = Object.keys(data)
      .filter((k) => k !== "proxies")
      .map((name) => ({
        name: knownSections.includes(name) ? name : "other",
        count: Array.isArray(data[name]) ? data[name].length : 1,
      }));
    context.document.profile.remoteResources =
      Object.keys(data["proxy-providers"] ?? {}).length +
      Object.keys(data["rule-providers"] ?? {}).length;
    if (
      Object.keys(data).some((k) => !["proxies", ...knownSections].includes(k))
    )
      context.add({
        code: "UNSUPPORTED_PROFILE_SECTION",
        severity: "error",
        message:
          "来源还包含监听、脚本或其他客户端设置，不能完整迁移；节点可独立导入。",
      });
  } catch {
    context.add({
      code: "INVALID_PROFILE",
      severity: "error",
      message: "部分策略组、规则或 DNS 结构无法解析；节点仍可独立导入。",
    });
  }
}

export function parseJson(input: string, context: ParseContext) {
  const data = JSON.parse(input);
  const entries = Array.isArray(data)
    ? data
    : context.document.format === "sip008"
      ? record(data).servers
      : record(data).outbounds;
  if (!Array.isArray(entries)) fail("MISSING_NODES", "配置缺少节点列表。");
  for (const raw of entries)
    context.entry(() => {
      const p = record(raw);
      if (["direct", "block", "dns"].includes(p.type)) return undefined;
      if (["selector", "urltest"].includes(p.type)) {
        let interval: number | undefined;
        if (p.interval !== undefined) {
          const match = String(p.interval).match(/^(\d+)(s|m|h)$/);
          if (match)
            interval = integer(
              Number(match[1]) * ({ s: 1, m: 60, h: 3600 }[match[2]] ?? 1),
              1,
              604800,
            );
          else
            context.add({
              code: "GROUP_SEMANTICS",
              severity: "error",
              message: "策略组检测间隔无法迁移。",
            });
        }
        context.document.profile.groups.push({
          name: p.tag,
          type: p.type,
          members: strings(p.outbounds, 5000),
          selected: p.default,
          url: p.url,
          interval,
          tolerance: p.tolerance,
        });
        if (
          Object.keys(p).some(
            (k) =>
              ![
                "type",
                "tag",
                "outbounds",
                "default",
                "url",
                "interval",
                "tolerance",
              ].includes(k),
          )
        )
          context.add({
            code: "GROUP_SEMANTICS",
            severity: "error",
            message: "策略组包含无法迁移的其他设置。",
          });
        return undefined;
      }
      if (context.document.format === "sip008") {
        context.unsupported(Object.keys(p), [
          "id",
          "remarks",
          "server",
          "server_port",
          "password",
          "method",
          "plugin",
          "plugin_opts",
        ]);
        return makeNode("ss", p.remarks, p.server, p.server_port, {
          method: p.method,
          password: p.password,
          ...(p.plugin
            ? { plugin: p.plugin, plugin_opts: p.plugin_opts ?? "" }
            : {}),
        });
      }
      const options = Object.fromEntries(
        Object.entries(p).filter(
          ([key]) =>
            ![
              "id",
              "tag",
              "name",
              "type",
              "server",
              "server_port",
              "port",
            ].includes(key),
        ),
      );
      if (p.type === "vmess")
        options.alter_id = aead(context, integer(options.alter_id ?? 0));
      return makeNode(
        p.type,
        p.tag ?? p.name,
        p.server,
        p.server_port ?? p.port,
        options,
      );
    });
  if (!Array.isArray(data)) {
    context.document.profile.sections = Object.keys(data)
      .filter((k) => !["outbounds", "servers", "version"].includes(k))
      .map((name) => ({
        name: ["route", "dns", "inbounds"].includes(name) ? name : "other",
        count: 1,
      }));
    if (context.document.profile.sections.length)
      context.add({
        code: "NATIVE_PROFILE",
        severity: "error",
        message:
          "此原生配置的路由、DNS 或其他设置需要专用迁移，节点可以独立导入。",
      });
  }
}
