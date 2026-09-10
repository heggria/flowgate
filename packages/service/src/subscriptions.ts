import { createHash, randomUUID } from "node:crypto";
import type { Configuration, NodeConfig } from "../../contracts/src/index";
import type {
  SubscriptionDocument,
  SubscriptionFetchResult,
  SubscriptionParseOptions,
  SubscriptionPreview,
  SubscriptionSummary,
} from "../../contracts/src/subscriptions";
import {
  applySubscriptionProfile,
  planSubscriptionProfile,
} from "../../domain/src/subscription-profile";
import { validateConfiguration } from "../../domain/src/configuration";

import { SUBSCRIPTION_PARSER_VERSION } from "../../contracts/src/subscriptions";

const fingerprint = (configuration: Configuration) =>
  createHash("sha256").update(JSON.stringify(configuration)).digest("hex");

type Extension = (
  method: string,
  payload?: unknown,
  signal?: AbortSignal,
) => Promise<unknown>;
interface PreviewInput {
  id?: string;
  text?: string;
  url?: string;
  name?: string;
  options?: SubscriptionParseOptions;
  migration?: "nodes" | "profile";
  acceptRejected?: boolean;
  refreshHours?: number;
}
interface Prepared {
  baseFingerprint: string;
  preview: SubscriptionPreview;
  next: Configuration;
  sourceId: string;
  refresh: boolean;
}
const formatNames = [
  "sing-box",
  "clash",
  "uri",
  "sip008",
  "quantumult-x",
  "loon",
  "surge",
  "shadowrocket",
];
export class SubscriptionService {
  private previews = new Map<string, Prepared>();
  private controller = new AbortController();
  private running = 0;
  constructor(
    private readonly configuration: () => Configuration,
    private readonly extension: Extension,
  ) {}
  pause() {
    this.controller.abort();
    this.previews.clear();
  }
  resume() {
    if (this.controller.signal.aborted) this.controller = new AbortController();
  }
  private options(
    input: SubscriptionParseOptions = {},
  ): SubscriptionParseOptions {
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).some(
        (k) => !["format", "vmessAead", "excludeInformation"].includes(k),
      )
    )
      throw new Error("订阅转换选项无效");
    if (input.format !== undefined && !formatNames.includes(input.format))
      throw new Error("订阅格式无效");
    if (
      input.vmessAead !== undefined &&
      !["source", "enabled", "legacy"].includes(input.vmessAead)
    )
      throw new Error("VMess 转换选项无效");
    if (
      input.excludeInformation !== undefined &&
      typeof input.excludeInformation !== "boolean"
    )
      throw new Error("信息条目选项无效");
    return {
      ...(input.format ? { format: input.format } : {}),
      vmessAead: input.vmessAead ?? "source",
      excludeInformation: input.excludeInformation ?? false,
    };
  }
  async preview(
    input: PreviewInput,
    signal?: AbortSignal,
  ): Promise<SubscriptionPreview> {
    if (this.running >= 2 || this.controller.signal.aborted)
      throw new Error("订阅服务正在处理其他请求或暂停中");
    this.running++;
    try {
      const combined = signal
        ? AbortSignal.any([signal, this.controller.signal])
        : this.controller.signal;
      const prepared = await this.prepare(input, combined);
      combined.throwIfAborted();
      if (fingerprint(this.configuration()) !== prepared.baseFingerprint)
        throw new Error("配置已变化，请重新生成订阅预览");
      for (const [id, value] of this.previews)
        if (Date.parse(value.preview.expiresAt) <= Date.now())
          this.previews.delete(id);
      while (this.previews.size >= 8)
        this.previews.delete(this.previews.keys().next().value!);
      this.previews.set(prepared.preview.id, prepared);
      return structuredClone(prepared.preview);
    } finally {
      this.running--;
    }
  }
  commit(
    id: string,
    refresh: boolean,
    sourceId?: string,
    reviewed = false,
  ): Configuration {
    const prepared = this.previews.get(id);
    if (!prepared || Date.parse(prepared.preview.expiresAt) <= Date.now()) {
      this.previews.delete(id);
      throw new Error("订阅预览已过期，请重新预览");
    }
    if (this.controller.signal.aborted) throw new Error("订阅服务已暂停");
    if (fingerprint(this.configuration()) !== prepared.baseFingerprint)
      throw new Error("配置已变化，请重新生成订阅预览");
    if (
      prepared.refresh !== refresh ||
      (refresh && prepared.sourceId !== sourceId)
    )
      throw new Error("预览与提交来源不一致");
    if (!prepared.preview.canCommit)
      throw new Error("此预览存在未解决的问题，请调整选项后重新预览");
    if (prepared.preview.requiresReview && !reviewed)
      throw new Error("请先查看转换提示，再确认导入");
    // One-time token. A failed durable commit must be retried with a fresh preview.
    this.previews.delete(id);
    return structuredClone(prepared.next);
  }
  metadataOnly(id: string): boolean {
    return this.previews.get(id)?.preview.unchanged === true;
  }
  private async prepare(
    input: PreviewInput,
    signal: AbortSignal,
  ): Promise<Prepared> {
    signal.throwIfAborted();
    const next = structuredClone(this.configuration());
    const baseFingerprint = fingerprint(next);
    const existing = input.id
      ? next.subscriptions.find((s) => s.id === input.id)
      : undefined;
    if (input.id && !existing) throw new Error("订阅不存在");
    const sourceId = existing?.id ?? randomUUID();
    const name = String(input.name ?? existing?.name ?? "订阅").trim();
    if (!name || name.length > 100) throw new Error("订阅名称无效");
    const options = this.options(input.options ?? existing?.parseOptions);
    const migration = input.migration ?? existing?.migration ?? "nodes";
    if (!["nodes", "profile"].includes(migration))
      throw new Error("订阅迁移方式无效");
    const refreshHours = input.refreshHours ?? existing?.refreshHours ?? 0;
    if (
      !Number.isInteger(refreshHours) ||
      refreshHours < 0 ||
      refreshHours > 168
    )
      throw new Error("自动刷新间隔须为 0–168 小时，0 表示关闭");
    if (
      input.acceptRejected !== undefined &&
      typeof input.acceptRejected !== "boolean"
    )
      throw new Error("部分导入选项无效");
    let text = input.text,
      url = existing?.url ?? input.url ?? "";
    let fetchResult: SubscriptionFetchResult | undefined;
    let conditionalRequest = false;
    if (url) {
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== "https:" || parsed.username || parsed.password)
          throw new Error();
        url = parsed.href;
      } catch {
        throw new Error("订阅链接必须使用不含用户名或密码的 HTTPS 地址");
      }
      const cache =
        existing &&
        existing.conversion?.parserVersion === SUBSCRIPTION_PARSER_VERSION &&
        JSON.stringify(this.options(existing.parseOptions)) ===
          JSON.stringify(options) &&
        migration === (existing.migration ?? "nodes");
      conditionalRequest =
        !!cache && !!(existing?.etag || existing?.lastModified);
      fetchResult = (await this.extension(
        "subscription.fetch",
        {
          url,
          version: 2,
          ...(cache
            ? { etag: existing.etag, lastModified: existing.lastModified }
            : {}),
        },
        signal,
      )) as SubscriptionFetchResult;
      if (
        !fetchResult ||
        fetchResult.version !== 2 ||
        !["ok", "not-modified"].includes(fetchResult.status)
      )
        throw new Error("订阅扩展版本不兼容，请更新完整应用");
      text = fetchResult.text;
    } else if (existing)
      throw new Error("本地导入没有订阅地址，请重新导入配置文本");
    if (fetchResult?.status === "not-modified") {
      if (!conditionalRequest || !existing?.conversion)
        throw new Error("订阅缓存缺失，请重新导入来源");
      existing.updatedAt = new Date().toISOString();
      existing.metadata = { ...existing.metadata, ...fetchResult.metadata };
      existing.refreshHours = refreshHours;
      existing.name = name;
      if (fetchResult.etag) existing.etag = fetchResult.etag;
      if (fetchResult.lastModified)
        existing.lastModified = fetchResult.lastModified;
      delete existing.error;
      const nodes = next.nodes.filter((n) => n.sourceId === sourceId);
      return {
        baseFingerprint,
        sourceId,
        refresh: true,
        next,
        preview: {
          id: randomUUID(),
          revision: next.revision,
          sourceId,
          expiresAt: new Date(Date.now() + 600000).toISOString(),
          name,
          summary: existing.conversion,
          metadata: existing.metadata ?? {},
          nodes: nodes.map(publicNode),
          changes: {
            added: 0,
            removed: 0,
            updated: 0,
            unchanged: nodes.length,
          },
          canCommit: true,
          requiresReview: false,
          unchanged: true,
          migration,
          profile: {
            supported: true,
            blockers: [],
            groups: (next.groups ?? []).filter((g) => g.sourceId === sourceId)
              .length,
            rules: next.rules.filter((r) => r.sourceId === sourceId).length,
          },
        },
      };
    }
    if (typeof text !== "string" || !text.trim())
      throw new Error("请输入订阅链接或配置内容");
    const document = (await this.extension(
      "subscription.parse",
      { text, version: 2, options },
      signal,
    )) as SubscriptionDocument;
    if (!document || document.version !== 2 || !Array.isArray(document.nodes))
      throw new Error("订阅扩展版本不兼容，请更新完整应用");
    const previous = next.nodes.filter((node) => node.sourceId === sourceId);
    const nodes = preserveNodeIdentity(document.nodes, previous, sourceId);
    const previousIds = new Map(previous.map((n) => [n.id, n]));
    const incomingIds = new Set(nodes.map((node) => node.id));
    const changes = {
      added: 0,
      removed: previous.filter((n) => !incomingIds.has(n.id)).length,
      updated: 0,
      unchanged: 0,
    };
    for (const node of nodes) {
      const before = previousIds.get(node.id);
      if (!before) changes.added++;
      else if (JSON.stringify(before) === JSON.stringify(node))
        changes.unchanged++;
      else changes.updated++;
    }
    const summary: SubscriptionSummary = {
      format: document.format,
      parserVersion: document.parserVersion,
      digest: document.digest,
      rejected: document.rejected,
      informationEntries: document.informationEntries,
      diagnostics: document.diagnostics,
      groups: document.profile.groups.length,
      rules: document.profile.rules.length,
      sections: document.profile.sections,
    };
    const metadata = {
      ...existing?.metadata,
      ...document.metadata,
      ...fetchResult?.metadata,
    };
    const source = {
      id: sourceId,
      name,
      url,
      count: nodes.length,
      updatedAt: new Date().toISOString(),
      conversion: summary,
      metadata,
      parseOptions: options,
      etag: fetchResult?.etag,
      lastModified: fetchResult?.lastModified,
      refreshHours: url ? refreshHours : 0,
      migration,
    };
    next.subscriptions = next.subscriptions
      .filter((s) => s.id !== sourceId)
      .concat(source);
    next.nodes = next.nodes
      .filter((node) => node.sourceId !== sourceId)
      .concat(nodes);
    const plan = planSubscriptionProfile(
      document,
      nodes,
      sourceId,
      (kind, label) =>
        `${kind}-${createHash("sha256")
          .update(JSON.stringify([sourceId, label]))
          .digest("hex")
          .slice(0, 32)}`,
    );
    let canCommit = !document.rejected || input.acceptRejected === true;
    if (migration === "profile") {
      canCommit &&= plan.summary.supported;
      if (canCommit) applySubscriptionProfile(next, plan);
    }
    const checks: string[] = [];
    try {
      validateConfiguration(next);
    } catch (error) {
      canCommit = false;
      checks.push(error instanceof Error ? error.message : "配置引用无效");
    }
    if (checks.length)
      summary.diagnostics = [
        ...summary.diagnostics,
        {
          code: "CONFIGURATION_CONFLICT",
          severity: "error",
          message: "导入后的配置引用无效；请先调整当前出口或规则再重新预览。",
        },
      ];
    const requiresReview =
      changes.removed > 0 ||
      document.rejected > 0 ||
      document.diagnostics.some((d) => d.severity === "warning") ||
      migration === "profile";
    return {
      baseFingerprint,
      sourceId,
      refresh: !!existing,
      next,
      preview: {
        id: randomUUID(),
        revision: next.revision,
        sourceId: existing?.id,
        expiresAt: new Date(Date.now() + 600000).toISOString(),
        name,
        summary,
        metadata,
        nodes: nodes.map(publicNode),
        changes,
        canCommit,
        requiresReview,
        migration,
        profile: plan.summary,
      },
    };
  }
}
const publicNode = ({ id, name, type, server, port }: NodeConfig) => ({
  id,
  name,
  type,
  server,
  port,
});
/** Keep named identities across endpoint and credential rotation; duplicates use exact endpoints and consume IDs once. */
export function preserveNodeIdentity(
  incoming: NodeConfig[],
  previous: NodeConfig[],
  sourceId: string,
): NodeConfig[] {
  const used = new Set<string>();
  const key = (node: NodeConfig) => JSON.stringify([node.type, node.name]);
  const counts = new Map<string, number>();
  const byKey = new Map<string, NodeConfig[]>();
  for (const node of previous) {
    const identity = key(node);
    const entries = byKey.get(identity) ?? [];
    entries.push(node);
    byKey.set(identity, entries);
  }
  for (const node of incoming)
    counts.set(key(node), (counts.get(key(node)) ?? 0) + 1);
  return incoming.map((node) => {
    const candidates = (byKey.get(key(node)) ?? []).filter(
      (old) => !used.has(old.id),
    );
    const match =
      candidates.find(
        (old) => old.server === node.server && old.port === node.port,
      ) ??
      (counts.get(key(node)) === 1 && candidates.length === 1
        ? candidates[0]
        : undefined);
    const id = match?.id ?? randomUUID();
    used.add(id);
    return { ...node, id, sourceId };
  });
}
