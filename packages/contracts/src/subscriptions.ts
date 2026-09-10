export const SUBSCRIPTION_PARSER_VERSION = "2.0.0";
import type { NodeConfig } from "./index";

export type SubscriptionFormat =
  | "sing-box"
  | "clash"
  | "uri"
  | "sip008"
  | "quantumult-x"
  | "loon"
  | "surge"
  | "shadowrocket";
export type ConversionSeverity = "info" | "warning" | "error";
/** Safe diagnostics contain locations and codes, never raw source lines or URLs. */
export interface ConversionDiagnostic {
  code: string;
  severity: ConversionSeverity;
  message: string;
  line?: number;
  field?: string;
  count?: number;
}
export interface SubscriptionMetadata {
  upload?: number;
  download?: number;
  total?: number;
  expire?: number;
  updateIntervalHours?: number;
}
export interface SubscriptionFetchResult {
  version: 2;
  status: "ok" | "not-modified";
  text?: string;
  metadata: SubscriptionMetadata;
  etag?: string;
  lastModified?: string;
}
export interface SourceGroup {
  name: string;
  type: string;
  members: string[];
  selected?: string;
  url?: string;
  interval?: number;
  tolerance?: number;
}
export interface SourceRule {
  kind: string;
  value: string;
  outbound: string;
  modifiers: string[];
  line?: number;
}
export interface SourceDns {
  enabled?: boolean;
  servers: string[];
  hosts?: Record<string, string[]>;
  unsupportedFields: string[];
}
export interface SubscriptionDocument {
  version: 2;
  format: SubscriptionFormat;
  parserVersion: string;
  digest: string;
  nodes: NodeConfig[];
  metadata: SubscriptionMetadata;
  diagnostics: ConversionDiagnostic[];
  rejected: number;
  informationEntries: number;
  profile: {
    groups: SourceGroup[];
    rules: SourceRule[];
    dns?: SourceDns;
    sections: { name: string; count: number }[];
    remoteResources: number;
  };
}
export interface SubscriptionParseOptions {
  format?: SubscriptionFormat;
  /** An explicit user override; never guessed from a different URL. */
  vmessAead?: "source" | "enabled" | "legacy";
  /** Only known metadata-shaped URI entries may be excluded, with a diagnostic. */
  excludeInformation?: boolean;
}
export interface SubscriptionSummary {
  format: SubscriptionFormat;
  parserVersion: string;
  digest: string;
  rejected: number;
  informationEntries: number;
  diagnostics: ConversionDiagnostic[];
  groups: number;
  rules: number;
  sections: { name: string; count: number }[];
}
export interface SubscriptionPreview {
  id: string;
  revision: number;
  sourceId?: string;
  expiresAt: string;
  name: string;
  summary: SubscriptionSummary;
  metadata: SubscriptionMetadata;
  nodes: Pick<NodeConfig, "id" | "name" | "type" | "server" | "port">[];
  changes: {
    added: number;
    removed: number;
    updated: number;
    unchanged: number;
  };
  canCommit: boolean;
  requiresReview: boolean;
  unchanged?: boolean;
  migration: "nodes" | "profile";
  profile: {
    supported: boolean;
    blockers: string[];
    groups: number;
    rules: number;
    dnsServer?: string;
  };
}
export const SUBSCRIPTION_LIMITS = {
  bytes: 4 * 1024 * 1024,
  nodes: 5000,
  lines: 50000,
  lineBytes: 64 * 1024,
  diagnostics: 100,
  parseMs: 5000,
  fetchMs: 15000,
} as const;
