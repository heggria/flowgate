import type { NodeConfig } from "../../contracts/src/index";

const object = (value: unknown): Record<string, any> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("节点选项必须是对象");
  return value as Record<string, any>;
};
const allowed = (value: Record<string, unknown>, keys: readonly string[]) => {
  if (Object.keys(value).some((k) => !keys.includes(k)))
    throw new Error("节点包含不支持的连接参数");
};
const string = (value: unknown, maximum = 4096) => {
  if (
    typeof value !== "string" ||
    value.length > maximum ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)
  )
    throw new Error("节点文本参数无效");
};
const bool = (value: unknown) => {
  if (typeof value !== "boolean") throw new Error("节点开关参数无效");
};
const list = (value: unknown) => {
  if (!Array.isArray(value) || value.length > 100)
    throw new Error("节点列表参数无效");
  value.forEach((v) => string(v));
};
const choice = (value: unknown, values: readonly unknown[]) => {
  if (!values.includes(value)) throw new Error("节点参数不受支持");
};
const number = (value: unknown, min = 0, max = 65535) => {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < min ||
    Number(value) > max
  )
    throw new Error("节点数值参数无效");
};

export const outboundOptionFields = [
  "username",
  "password",
  "method",
  "uuid",
  "security",
  "alter_id",
  "flow",
  "tls",
  "transport",
  "up_mbps",
  "down_mbps",
  "obfs",
  "congestion_control",
  "udp_relay_mode",
  "udp_over_stream",
  "zero_rtt_handshake",
  "heartbeat",
  "plugin",
  "plugin_opts",
  "packet_encoding",
  "network",
  "version",
  "multiplex",
  "global_padding",
  "authenticated_length",
  "tcp_fast_open",
] as const;

/** Validate executable connection fields; arbitrary file paths, commands and native dial options are never admitted. */
export function validateNodeOptions(
  type: NodeConfig["type"],
  input: unknown,
  strict = false,
) {
  const options = object(input);
  const protocolFields: Record<NodeConfig["type"], string[]> = {
    http: ["username", "password", "tls"],
    socks: ["username", "password", "version", "network"],
    shadowsocks: [
      "method",
      "password",
      "plugin",
      "plugin_opts",
      "network",
      "multiplex",
    ],
    vmess: [
      "uuid",
      "security",
      "alter_id",
      "global_padding",
      "authenticated_length",
      "network",
      "tls",
      "packet_encoding",
      "transport",
      "multiplex",
    ],
    vless: [
      "uuid",
      "flow",
      "network",
      "tls",
      "packet_encoding",
      "transport",
      "multiplex",
    ],
    trojan: ["password", "network", "tls", "transport", "multiplex"],
    hysteria2: ["password", "up_mbps", "down_mbps", "obfs", "network", "tls"],
    tuic: [
      "uuid",
      "password",
      "congestion_control",
      "udp_relay_mode",
      "udp_over_stream",
      "zero_rtt_handshake",
      "heartbeat",
      "network",
      "tls",
    ],
  };
  if (strict) allowed(options, [...protocolFields[type], "tcp_fast_open"]);
  if (options.tcp_fast_open !== undefined) bool(options.tcp_fast_open);
  for (const key of ["username", "password", "uuid", "method", "plugin_opts"])
    if (options[key] !== undefined)
      string(options[key], key === "plugin_opts" ? 8192 : 4096);
  if (
    ["vmess", "vless", "tuic"].includes(type) &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      options.uuid ?? "",
    )
  )
    throw new Error("节点 UUID 无效");
  if (
    ["trojan", "hysteria2", "shadowsocks", "tuic"].includes(type) &&
    !options.password
  )
    throw new Error("节点缺少认证信息");
  if (type === "shadowsocks" && !options.method)
    throw new Error("节点缺少加密方法");
  if (type === "shadowsocks")
    choice(options.method, [
      "2022-blake3-aes-128-gcm",
      "2022-blake3-aes-256-gcm",
      "2022-blake3-chacha20-poly1305",
      "none",
      "aes-128-gcm",
      "aes-192-gcm",
      "aes-256-gcm",
      "chacha20-ietf-poly1305",
      "xchacha20-ietf-poly1305",
      "aes-128-ctr",
      "aes-192-ctr",
      "aes-256-ctr",
      "aes-128-cfb",
      "aes-192-cfb",
      "aes-256-cfb",
      "rc4-md5",
      "chacha20-ietf",
      "xchacha20",
    ]);
  if (options.security !== undefined)
    choice(options.security, [
      "auto",
      "none",
      "zero",
      "aes-128-gcm",
      "chacha20-poly1305",
      "aes-128-ctr",
    ]);
  if (options.alter_id !== undefined) number(options.alter_id);
  if (options.flow !== undefined)
    choice(options.flow, ["", "xtls-rprx-vision"]);
  if (options.network !== undefined) choice(options.network, ["tcp", "udp"]);
  if (options.version !== undefined) choice(options.version, ["4", "4a", "5"]);
  if (options.packet_encoding !== undefined)
    choice(options.packet_encoding, ["", "packetaddr", "xudp"]);
  if (options.congestion_control !== undefined)
    choice(options.congestion_control, ["cubic", "new_reno", "bbr"]);
  if (options.udp_relay_mode !== undefined)
    choice(options.udp_relay_mode, ["native", "quic"]);
  for (const key of [
    "udp_over_stream",
    "zero_rtt_handshake",
    "global_padding",
    "authenticated_length",
  ])
    if (options[key] !== undefined) bool(options[key]);
  if (
    options.heartbeat !== undefined &&
    !/^\d+(?:ms|s|m)$/.test(options.heartbeat)
  )
    throw new Error("节点心跳间隔无效");
  for (const key of ["up_mbps", "down_mbps"])
    if (options[key] !== undefined) number(options[key], 1, 1000000);
  if (options.plugin !== undefined) {
    if (type !== "shadowsocks")
      throw new Error("此协议不支持 Shadowsocks 插件");
    choice(options.plugin, ["obfs-local", "v2ray-plugin"]);
    const fields = String(options.plugin_opts ?? "")
      .split(";")
      .filter(Boolean);
    const seen = new Set<string>();
    for (const field of fields) {
      const at = field.indexOf("="),
        key = at < 0 ? field : field.slice(0, at),
        value = at < 0 ? "" : field.slice(at + 1);
      if (seen.has(key)) throw new Error("插件参数重复");
      seen.add(key);
      choice(
        key,
        options.plugin === "obfs-local"
          ? ["obfs", "obfs-host", "obfs-uri"]
          : ["tls", "host", "path", "mux", "skip-cert-verify"],
      );
      if (key === "obfs") choice(value, ["http", "tls"]);
      if (key === "mux") choice(value, ["0", "1", "4", "8", "16"]);
      if (["tls", "skip-cert-verify"].includes(key) && value)
        throw new Error("插件布尔参数无效");
    }
    if (options.plugin === "obfs-local" && !seen.has("obfs"))
      throw new Error("插件缺少混淆类型");
  }
  if (options.plugin_opts && !options.plugin)
    throw new Error("插件参数缺少插件名称");
  if (options.obfs !== undefined) {
    if (type !== "hysteria2") throw new Error("此混淆参数不受支持");
    const obfs = object(options.obfs);
    allowed(obfs, ["type", "password"]);
    choice(obfs.type, ["salamander"]);
    string(obfs.password);
    if (!obfs.password) throw new Error("缺少混淆认证信息");
  }
  if (options.tls !== undefined) {
    if (type === "socks")
      throw new Error("当前内核 SOCKS 出口不支持此 TLS 包装");
    const tls = object(options.tls);
    allowed(tls, [
      "enabled",
      "server_name",
      "insecure",
      "alpn",
      "min_version",
      "max_version",
      "cipher_suites",
      "certificate",
      "utls",
      "reality",
    ]);
    bool(tls.enabled);
    for (const key of ["server_name", "min_version", "max_version"])
      if (tls[key] !== undefined) string(tls[key]);
    if (tls.insecure !== undefined) bool(tls.insecure);
    for (const key of ["alpn", "cipher_suites"])
      if (tls[key] !== undefined) list(tls[key]);
    if (tls.certificate !== undefined) {
      if (typeof tls.certificate === "string") string(tls.certificate, 128000);
      else list(tls.certificate);
    }
    if (tls.utls !== undefined) {
      const u = object(tls.utls);
      allowed(u, ["enabled", "fingerprint"]);
      bool(u.enabled);
      string(u.fingerprint);
    }
    if (tls.reality !== undefined) {
      const r = object(tls.reality);
      allowed(r, ["enabled", "public_key", "short_id"]);
      bool(r.enabled);
      string(r.public_key);
      if (!r.public_key) throw new Error("Reality 公钥缺失");
      if (!/^[0-9a-f]{0,16}$/i.test(r.short_id ?? ""))
        throw new Error("Reality short ID 无效");
    }
  }
  if (
    ["trojan", "hysteria2", "tuic"].includes(type) &&
    !(options.tls as any)?.enabled
  )
    throw new Error("此协议需要 TLS");
  if (options.transport !== undefined) {
    if (!["vmess", "vless", "trojan"].includes(type))
      throw new Error("此协议不支持 V2Ray 传输包装");
    const transport = object(options.transport);
    choice(transport.type, ["ws", "grpc", "http", "httpupgrade"]);
    const fields =
      transport.type === "grpc"
        ? [
            "type",
            "service_name",
            "idle_timeout",
            "ping_timeout",
            "permit_without_stream",
          ]
        : transport.type === "ws"
          ? [
              "type",
              "path",
              "headers",
              "max_early_data",
              "early_data_header_name",
            ]
          : transport.type === "http"
            ? ["type", "host", "path", "method", "headers"]
            : ["type", "host", "path", "headers"];
    allowed(transport, fields);
    for (const key of [
      "path",
      "method",
      "service_name",
      "idle_timeout",
      "ping_timeout",
      "early_data_header_name",
    ])
      if (transport[key] !== undefined) string(transport[key]);
    if (transport.host !== undefined) {
      if (Array.isArray(transport.host)) list(transport.host);
      else string(transport.host);
    }
    if (transport.max_early_data !== undefined)
      number(transport.max_early_data, 0, 1048576);
    if (transport.permit_without_stream !== undefined)
      bool(transport.permit_without_stream);
    if (transport.headers !== undefined) {
      const headers = object(transport.headers);
      if (Object.keys(headers).length > 50) throw new Error("传输请求头过多");
      for (const [key, value] of Object.entries(headers)) {
        if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/.test(key))
          throw new Error("传输请求头无效");
        string(value);
        if (/[\r\n]/.test(value as string)) throw new Error("传输请求头无效");
      }
    }
  }
  if (options.multiplex !== undefined) {
    const multiplex = object(options.multiplex);
    allowed(multiplex, [
      "enabled",
      "protocol",
      "max_connections",
      "min_streams",
      "max_streams",
      "padding",
    ]);
    bool(multiplex.enabled);
    if (multiplex.protocol !== undefined)
      choice(multiplex.protocol, ["smux", "yamux", "h2mux"]);
    for (const key of ["max_connections", "min_streams", "max_streams"])
      if (multiplex[key] !== undefined) number(multiplex[key], 0, 10000);
    if (multiplex.padding !== undefined) bool(multiplex.padding);
  }
}
