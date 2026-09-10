import type { Configuration, NodeConfig } from "../../contracts/src/index";
import { tunAddresses } from "./ip-range";
import { isLoopbackHost } from "./endpoint";
import { outboundOptionFields, validateNodeOptions } from "./node-options";
export function initialConfiguration(): Configuration {
  return {
    schema: 2,
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
    ![1, 2].includes(c.schema) ||
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
    if (isLoopbackHost(n.server) && n.port === c.settings.listenPort)
      throw new Error("节点指向本应用监听端口，会形成代理循环");
    if (ids.has(n.id)) throw new Error("节点标识重复");
    ids.add(n.id);
  }
  if (
    c.externalNetworks !== undefined &&
    (!Array.isArray(c.externalNetworks) || c.externalNetworks.length > 100)
  )
    throw new Error("外部网络数量无效");
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
  const groups = c.groups ?? [];
  if (!Array.isArray(groups) || groups.length > 100)
    throw new Error("策略组数量无效");
  for (const group of groups) {
    if (
      !group ||
      !/^[\w.-]{1,100}$/.test(group.id) ||
      ids.has(group.id) ||
      typeof group.name !== "string" ||
      !group.name.trim() ||
      group.name.length > 200 ||
      !["selector", "urltest"].includes(group.type) ||
      !Array.isArray(group.members) ||
      !group.members.length ||
      group.members.length > 5000
    )
      throw new Error("策略组无效");
    if (group.url) {
      const url = new URL(group.url);
      if (url.protocol !== "https:" || url.username || url.password)
        throw new Error("策略组检测地址必须使用 HTTPS");
    }
    if (
      group.interval !== undefined &&
      (!Number.isInteger(group.interval) ||
        group.interval < 1 ||
        group.interval > 604800)
    )
      throw new Error("策略组检测间隔无效");
    if (
      group.tolerance !== undefined &&
      (!Number.isInteger(group.tolerance) ||
        group.tolerance < 0 ||
        group.tolerance > 65535)
    )
      throw new Error("策略组检测容差无效");
    if (group.selected !== undefined && !group.members.includes(group.selected))
      throw new Error("策略组选中成员不存在");
    ids.add(group.id);
  }
  const visited = new Set<string>();
  const visit = (id: string, path: Set<string>) => {
    if (path.has(id)) throw new Error("策略组引用形成循环");
    if (visited.has(id)) return;
    const group = groups.find((g) => g.id === id);
    if (!group) return;
    const next = new Set(path).add(id);
    for (const member of group.members) {
      if (!ids.has(member) || ["select", "block"].includes(member))
        throw new Error("策略组引用不存在或不支持的出口");
      visit(member, next);
    }
    visited.add(id);
  };
  for (const group of groups) visit(group.id, new Set());
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
  for (const subscription of c.subscriptions) {
    if (
      !subscription ||
      !/^[\w.-]{1,100}$/.test(subscription.id) ||
      sourceIds.has(subscription.id) ||
      typeof subscription.name !== "string" ||
      !subscription.name.trim() ||
      subscription.name.length > 200
    )
      throw new Error("订阅来源无效");
    if (subscription.url) {
      const url = new URL(subscription.url);
      if (url.protocol !== "https:" || url.username || url.password)
        throw new Error("订阅地址必须使用 HTTPS");
    }
    if (
      subscription.refreshHours !== undefined &&
      (!Number.isInteger(subscription.refreshHours) ||
        subscription.refreshHours < 0 ||
        subscription.refreshHours > 168)
    )
      throw new Error("订阅刷新间隔无效");
    sourceIds.add(subscription.id);
  }
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
      ![
        "domain_suffix",
        "domain",
        "domain_keyword",
        "ip_cidr",
        "process_name",
      ].includes(r.kind) ||
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
  if (n.optionsVersion !== undefined && n.optionsVersion !== 2)
    throw new Error("节点选项版本无效");
  if (n.optionsVersion === 2) validateNodeOptions(n.type, n.options, true);
}
// Only explicitly supported outbound fields survive import. No arbitrary configuration execution.
const fields = outboundOptionFields;
const legacyFields = [
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
      (n.optionsVersion === 2 ? fields : legacyFields)
        .filter((k) => k in n.options)
        .map((k) => [k, n.options[k]]),
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
              address: tunAddresses,
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
          ...(c.groups ?? []).map((g) => g.id),
        ],
        default: c.settings.selectedNode,
      },
      ...c.nodes.map(nodeOutbound),
      ...(c.groups ?? []).map((group) => ({
        type: group.type,
        tag: group.id,
        outbounds: group.members,
        ...(group.type === "selector"
          ? { default: group.selected ?? group.members[0] }
          : {
              ...(group.url ? { url: group.url } : {}),
              ...(group.interval ? { interval: `${group.interval}s` } : {}),
              ...(group.tolerance !== undefined
                ? { tolerance: group.tolerance }
                : {}),
            }),
      })),
      ...networks.map((n) => ({
        type: "direct",
        tag: n.id,
        bind_interface: n.interface,
        domain_resolver: "dns-" + n.id,
      })),
    ],
    route: {
      // TUN needs loop prevention. Manual/system listeners must honor OS VPN routes.
      auto_detect_interface: c.settings.mode === "tun",
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
  target = target.trim().toLowerCase().replace(/\.$/, "");
  if (!target || /[\s:/?#@]/.test(target))
    throw new Error("请输入域名，例如 example.com；不要包含协议或路径");
  try {
    target = new URL(`http://${target}`).hostname;
  } catch {
    throw new Error("域名格式无效，请检查输入");
  }
  const hit = c.rules.find((r) =>
    r.kind === "domain"
      ? target === r.value
      : r.kind === "domain_suffix"
        ? target === r.value ||
          target.endsWith("." + r.value.replace(/^\./, ""))
        : r.kind === "domain_keyword"
          ? target.includes(r.value)
          : false,
  );
  return {
    target,
    revision: c.revision,
    rule: hit ?? null,
    outbound: hit?.outbound ?? c.settings.finalOutbound,
    applied: false,
    note: "配置预览；实际连接还取决于 DNS、内核与外部路由。",
  };
}
