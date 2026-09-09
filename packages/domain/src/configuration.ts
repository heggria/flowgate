import type { Configuration, NodeConfig } from "../../contracts/src/index";
export function initialConfiguration(): Configuration {
  return {
    schema: 1,
    revision: 0,
    nodes: [],
    subscriptions: [],
    rules: [],
    settings: {
      mode: "manual",
      listenPort: 17890,
      selectedNode: "direct",
      finalOutbound: "select",
      dnsServer: "https://1.1.1.1/dns-query",
      autoConnect: false,
    },
  };
}
export function validateConfiguration(c: Configuration): void {
  if (
    c.schema !== 1 ||
    !Number.isSafeInteger(c.revision) ||
    !Array.isArray(c.nodes) ||
    c.nodes.length > 5000 ||
    !Array.isArray(c.rules) ||
    c.rules.length > 10000 ||
    !Array.isArray(c.subscriptions)
  )
    throw new Error("配置结构无效");
  if (
    !c.settings ||
    typeof c.settings.autoConnect !== "boolean" ||
    !["manual", "system", "tun"].includes(c.settings.mode) ||
    !Number.isInteger(c.settings.listenPort) ||
    c.settings.listenPort < 1024 ||
    c.settings.listenPort > 65535
  )
    throw new Error("监听端口必须在 1024–65535 之间");
  const ids = new Set(["direct", "block", "select"]);
  for (const n of c.nodes) {
    validateNode(n);
    if (
      ["localhost", "127.0.0.1", "::1", "[::1]"].includes(n.server) &&
      n.port === c.settings.listenPort
    )
      throw new Error("节点指向本应用监听端口，会形成代理循环");
    if (ids.has(n.id)) throw new Error("节点标识重复");
    ids.add(n.id);
  }
  for (const network of c.externalNetworks ?? []) {
    if (
      !/^[\w.-]{1,100}$/.test(network.id) ||
      ids.has(network.id) ||
      !network.name ||
      !/^[a-zA-Z][a-zA-Z0-9]{0,20}$/.test(network.interface)
    )
      throw new Error("外部网络配置无效");
    const resolver = new URL(network.dnsServer);
    if (
      !["udp:", "tls:", "https:"].includes(resolver.protocol) ||
      resolver.username ||
      resolver.password
    )
      throw new Error("外部网络 DNS 无效");
    ids.add(network.id);
  }
  if (
    !ids.has(c.settings.selectedNode) ||
    c.settings.selectedNode === "select" ||
    c.settings.selectedNode === "block"
  )
    throw new Error("请选择有效节点");
  if (!ids.has(c.settings.finalOutbound)) throw new Error("默认出口不存在");
  const dns = new URL(c.settings.dnsServer);
  if (
    !["https:", "tls:", "udp:"].includes(dns.protocol) ||
    dns.username ||
    dns.password
  )
    throw new Error("DNS 地址须为 HTTPS、TLS 或 UDP");
  const sourceIds = new Set<string>();
  if (
    c.ruleSources &&
    (!Array.isArray(c.ruleSources) || c.ruleSources.length > 100)
  )
    throw new Error("规则集来源数量无效");
  for (const source of c.ruleSources ?? []) {
    if (
      !source ||
      !/^[\w.-]{1,100}$/.test(source.id) ||
      sourceIds.has(source.id) ||
      typeof source.name !== "string" ||
      !source.name.trim() ||
      source.name.length > 200 ||
      !["sing-box-json", "domain-list"].includes(source.format) ||
      !ids.has(source.outbound)
    )
      throw new Error("规则集来源配置无效");
    const url = new URL(source.url);
    if (url.protocol !== "https:" || url.username || url.password)
      throw new Error("规则集来源必须使用 HTTPS");
    sourceIds.add(source.id);
  }
  for (const r of c.rules) {
    if (
      !["domain_suffix", "domain", "ip_cidr", "process_name"].includes(
        r.kind,
      ) ||
      typeof r.value !== "string" ||
      !r.value.trim() ||
      r.value.length > 500 ||
      !ids.has(r.outbound) ||
      (r.sourceId !== undefined && !sourceIds.has(r.sourceId))
    )
      throw new Error("分流规则无效");
  }
}
export function validateNode(n: NodeConfig) {
  if (
    !n ||
    !/^[\w.-]{1,100}$/.test(n.id) ||
    typeof n.name !== "string" ||
    !n.name.trim() ||
    n.name.length > 200 ||
    ![
      "http",
      "socks",
      "shadowsocks",
      "trojan",
      "vless",
      "vmess",
      "hysteria2",
      "tuic",
    ].includes(n.type) ||
    typeof n.server !== "string" ||
    !n.server ||
    /[\s/]/.test(n.server) ||
    !Number.isInteger(n.port) ||
    n.port < 1 ||
    n.port > 65535 ||
    !n.options ||
    typeof n.options !== "object"
  )
    throw new Error("节点格式无效");
}
// Only explicitly supported outbound fields survive import. No arbitrary configuration execution.
const fields = [
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
];
export function nodeOutbound(n: NodeConfig) {
  return {
    type: n.type,
    tag: n.id,
    server: n.server,
    server_port: n.port,
    ...Object.fromEntries(
      fields.filter((k) => k in n.options).map((k) => [k, n.options[k]]),
    ),
  };
}
export function compileConfiguration(c: Configuration) {
  validateConfiguration(c);
  const dns = new URL(c.settings.dnsServer);
  const server = {
    type:
      dns.protocol === "https:"
        ? "https"
        : dns.protocol === "tls:"
          ? "tls"
          : "udp",
    tag: "resolver",
    server: dns.hostname,
    ...(dns.port ? { server_port: Number(dns.port) } : {}),
    ...(dns.protocol === "https:"
      ? { path: dns.pathname || "/dns-query" }
      : {}),
    ...(c.settings.selectedNode !== "direct"
      ? { detour: c.settings.selectedNode }
      : {}),
  };
  const networks = c.externalNetworks ?? [];
  const networkDNS = networks.map((network) => {
    const u = new URL(network.dnsServer);
    return {
      type:
        u.protocol === "https:"
          ? "https"
          : u.protocol === "tls:"
            ? "tls"
            : "udp",
      tag: "dns-" + network.id,
      server: u.hostname,
      ...(u.port ? { server_port: Number(u.port) } : {}),
      ...(u.protocol === "https:" ? { path: u.pathname || "/dns-query" } : {}),
      detour: network.id,
    };
  });
  const dnsRules = c.rules
    .filter(
      (r) =>
        ["domain", "domain_suffix"].includes(r.kind) &&
        networks.some((n) => n.id === r.outbound),
    )
    .map((r) => ({
      [r.kind]: [r.value],
      action: "route",
      server: "dns-" + r.outbound,
    }));
  return {
    log: { level: "warn", timestamp: true },
    dns: {
      servers: [
        { type: "udp", tag: "bootstrap", server: "1.1.1.1" },
        server,
        ...networkDNS,
      ],
      rules: dnsRules,
      final: "resolver",
      strategy: "prefer_ipv4",
    },
    inbounds:
      c.settings.mode === "tun"
        ? [
            {
              type: "tun",
              tag: "tun-in",
              interface_name: "utun",
              address: ["172.29.0.1/30", "fdfe:dcba:9876::1/126"],
              auto_route: true,
              strict_route: true,
            },
          ]
        : [
            {
              type: "mixed",
              tag: "mixed-in",
              listen: "127.0.0.1",
              listen_port: c.settings.listenPort,
            },
          ],
    outbounds: [
      { type: "direct", tag: "direct", domain_resolver: "resolver" },
      {
        type: "selector",
        tag: "select",
        outbounds: [
          "direct",
          ...c.nodes.map((n) => n.id),
          ...networks.map((n) => n.id),
        ],
        default: c.settings.selectedNode,
      },
      ...c.nodes.map(nodeOutbound),
      ...networks.map((n) => ({
        type: "direct",
        tag: n.id,
        bind_interface: n.interface,
        domain_resolver: "dns-" + n.id,
      })),
    ],
    route: {
      auto_detect_interface: true,
      default_domain_resolver: "bootstrap",
      rules: [
        { action: "sniff" },
        { protocol: "dns", action: "hijack-dns" },
        ...c.rules.map((r) => ({
          ...{ [r.kind]: [r.value] },
          ...(r.outbound === "block"
            ? { action: "reject" }
            : { action: "route", outbound: r.outbound }),
        })),
        ...(c.settings.finalOutbound === "block" ? [{ action: "reject" }] : []),
      ],
      final:
        c.settings.finalOutbound === "block"
          ? "direct"
          : c.settings.finalOutbound,
    },
  };
}
export function explainRoute(c: Configuration, target: string) {
  const hit = c.rules.find((r) =>
    r.kind === "domain"
      ? target === r.value
      : r.kind === "domain_suffix"
        ? target === r.value ||
          target.endsWith("." + r.value.replace(/^\./, ""))
        : false,
  );
  return {
    target,
    rule: hit ?? null,
    outbound: hit?.outbound ?? c.settings.finalOutbound,
    applied: false,
    note: "配置预览；实际连接还取决于 DNS、内核与外部路由。",
  };
}
