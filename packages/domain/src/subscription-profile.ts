import type {
  Configuration,
  NodeConfig,
  ProxyGroup,
  Rule,
} from "../../contracts/src/index";
import type {
  SubscriptionDocument,
  SubscriptionPreview,
} from "../../contracts/src/subscriptions";

export interface ProfilePlan {
  summary: SubscriptionPreview["profile"];
  groups: ProxyGroup[];
  rules: Rule[];
  finalOutbound?: string;
}
/** A closed, declarative migration. Unsupported semantics block the entire profile, never just disappear. */
export function planSubscriptionProfile(
  document: SubscriptionDocument,
  nodes: NodeConfig[],
  sourceId: string,
  stableId: (kind: string, name: string) => string,
): ProfilePlan {
  const blockers = new Set<string>();
  for (const diagnostic of document.diagnostics)
    if (diagnostic.severity === "error") blockers.add(diagnostic.message);
  if (document.rejected)
    blockers.add("存在未转换的节点，无法完整迁移策略引用。");
  const targets = new Map<string, string>([
    ["DIRECT", "direct"],
    ["direct", "direct"],
    ["REJECT", "block"],
    ["reject", "block"],
  ]);
  const register = (name: string, id: string) => {
    if (targets.has(name))
      blockers.add("节点或策略组名称重复，无法唯一解析引用。");
    else targets.set(name, id);
  };
  for (const node of nodes) register(node.name, node.id);
  for (const group of document.profile.groups)
    register(group.name, stableId("group", group.name));
  const resolve = (name: string) => {
    const value = targets.get(name);
    if (!value) blockers.add("策略组或规则引用了来源中不存在的出口。");
    return value ?? "direct";
  };
  const groups: ProxyGroup[] = document.profile.groups.map((group) => {
    const type = ["select", "static", "selector"].includes(
      group.type.toLowerCase(),
    )
      ? "selector"
      : ["url-test", "urltest"].includes(group.type.toLowerCase())
        ? "urltest"
        : undefined;
    if (!type) blockers.add("策略组类型尚不支持无损迁移。");
    const members = group.members.map(resolve);
    if (members.includes("block"))
      blockers.add("策略组中的拒绝出口暂不支持，无法完整迁移。");
    if (!members.length) blockers.add("策略组缺少静态成员，可能依赖远程来源。");
    return {
      id: stableId("group", group.name),
      name: group.name,
      sourceId,
      type: type ?? "selector",
      members,
      selected: group.selected ? resolve(group.selected) : undefined,
      url: group.url,
      interval: group.interval,
      tolerance: group.tolerance,
    };
  });
  const rules: Rule[] = [];
  let finalOutbound: string | undefined;
  const kinds: Record<string, Rule["kind"]> = {
    DOMAIN: "domain",
    HOST: "domain",
    "DOMAIN-SUFFIX": "domain_suffix",
    "HOST-SUFFIX": "domain_suffix",
    "DOMAIN-KEYWORD": "domain_keyword",
    "HOST-KEYWORD": "domain_keyword",
    "IP-CIDR": "ip_cidr",
    "IP6-CIDR": "ip_cidr",
    "IP-CIDR6": "ip_cidr",
    "PROCESS-NAME": "process_name",
  };
  for (const [index, rule] of document.profile.rules.entries()) {
    if (finalOutbound !== undefined)
      blockers.add("终结规则之后仍有规则，无法保留源配置顺序语义。");
    if (rule.modifiers.length)
      blockers.add(
        "规则包含 no-resolve 等修饰符，当前无法无损保留其 DNS 语义。",
      );
    if (["FINAL", "MATCH"].includes(rule.kind))
      finalOutbound = resolve(rule.outbound);
    else if (!kinds[rule.kind])
      blockers.add(
        ["GEOIP", "GEOSITE", "IP-ASN"].includes(rule.kind)
          ? "地理或 ASN 规则依赖外部数据集，尚未建立可信数据来源映射。"
          : rule.kind === "USER-AGENT"
            ? "当前内核不提供源配置的 User-Agent 分流能力。"
            : "存在当前分流模型不支持的规则类型。",
      );
    else
      rules.push({
        id: stableId("rule", String(index)),
        sourceId,
        kind: kinds[rule.kind],
        value: rule.value,
        outbound: resolve(rule.outbound),
      });
  }
  let dnsServer: string | undefined;
  const dns = document.profile.dns;
  if (dns) {
    if (
      dns.enabled === false ||
      dns.unsupportedFields.length ||
      (dns.hosts && Object.keys(dns.hosts).length)
    )
      blockers.add(
        "DNS 包含多路选择、hosts、Fake-IP 或其他尚不能无损迁移的设置。",
      );
    if (dns.servers.length !== 1)
      blockers.add("当前完整迁移只支持单个明确的 DNS 上游。");
    else {
      const candidate = dns.servers[0];
      try {
        const url = new URL(
          candidate.includes("://") ? candidate : `udp://${candidate}`,
        );
        if (
          !["https:", "tls:", "udp:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          !url.hostname ||
          url.hostname === "system"
        )
          throw new Error();
        dnsServer = url.href;
      } catch {
        blockers.add("DNS 上游地址无法迁移。");
      }
    }
  }
  if (document.profile.remoteResources)
    blockers.add("远程资源未下载、执行或隐式授权。");
  return {
    summary: {
      supported: blockers.size === 0,
      blockers: [...blockers],
      groups: groups.length,
      rules: rules.length,
      dnsServer,
    },
    groups,
    rules,
    finalOutbound,
  };
}
export function applySubscriptionProfile(
  configuration: Configuration,
  plan: ProfilePlan,
) {
  if (!plan.summary.supported)
    throw new Error("完整配置包含不支持的设置，请查看预览或选择只导入节点");
  configuration.groups = plan.groups.map((group) => {
    const previous = configuration.groups?.find((old) => old.id === group.id);
    return previous?.selected && group.members.includes(previous.selected)
      ? { ...group, selected: previous.selected }
      : group;
  });
  configuration.rules = plan.rules;
  configuration.ruleSources = [];
  if (plan.finalOutbound !== undefined)
    configuration.settings.finalOutbound = plan.finalOutbound;
  if (plan.summary.dnsServer)
    configuration.settings.dnsServer = plan.summary.dnsServer;
}
