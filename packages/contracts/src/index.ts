export const PROTOCOL = 1;
export type Lifecycle =
  "starting" | "ready" | "draining" | "stopped" | "failed";
export interface TraceContext {
  operationId: string;
  traceId: string;
  releaseSet: string;
  serviceVersion: string;
  epoch: number;
  configRevision: number;
  pluginInstance?: string;
  shellVersion?: string;
  protocolVersion?: number;
  schemaVersion?: number;
  hostVersion?: string;
  serviceEpoch?: number;
  kernelVersion?: string;
  moduleVersions?: Record<string, string>;
}
export interface RpcRequest {
  protocol: 1;
  id: string;
  epoch: number;
  session: string;
  method: string;
  payload?: unknown;
  operationId?: string;
  context?: TraceContext;
}
export interface RpcResponse {
  protocol: 1;
  id: string;
  epoch: number;
  result?: unknown;
  error?: { code: string; message: string; outcome: "failed" | "unknown" };
}
export interface NodeConfig {
  id: string;
  name: string;
  type:
    | "http"
    | "socks"
    | "shadowsocks"
    | "trojan"
    | "vless"
    | "vmess"
    | "hysteria2"
    | "tuic";
  server: string;
  port: number;
  options: Record<string, unknown>;
  /** Only normalized v2 nodes may enable newly admitted outbound options. */
  optionsVersion?: 2;
  sourceId?: string;
}
export interface Rule {
  sourceId?: string;
  id: string;
  kind:
    "domain_suffix" | "domain" | "domain_keyword" | "ip_cidr" | "process_name";
  value: string;
  outbound: string;
}
export interface Subscription {
  id: string;
  name: string;
  url: string;
  updatedAt?: string;
  count: number;
  error?: string;
  conversion?: import("./subscriptions").SubscriptionSummary;
  metadata?: import("./subscriptions").SubscriptionMetadata;
  parseOptions?: import("./subscriptions").SubscriptionParseOptions;
  etag?: string;
  lastModified?: string;
  refreshHours?: number;
  migration?: "nodes" | "profile";
  /** Derived for redacted UI snapshots. */
  canRefresh?: boolean;
}
export interface ProxyGroup {
  id: string;
  name: string;
  sourceId: string;
  type: "selector" | "urltest";
  members: string[];
  selected?: string;
  url?: string;
  interval?: number;
  tolerance?: number;
}
export interface Settings {
  mode: "manual" | "system" | "tun";
  listenPort: number;
  selectedNode: string;
  finalOutbound: string;
  dnsServer: string;
  autoConnect: boolean;
}
export interface ExternalNetwork {
  id: string;
  name: string;
  interface: string;
  dnsServer: string;
}
export interface RuleSource {
  id: string;
  name: string;
  url: string;
  format: "sing-box-json" | "domain-list";
  outbound: string;
  count: number;
  updatedAt?: string;
  error?: string;
}
export interface Configuration {
  schema: 1 | 2;
  revision: number;
  nodes: NodeConfig[];
  groups?: ProxyGroup[];
  subscriptions: Subscription[];
  ruleSources?: RuleSource[];
  externalNetworks?: ExternalNetwork[];
  rules: Rule[];
  settings: Settings;
}
export interface Operation {
  context?: TraceContext;
  id: string;
  traceId: string;
  kind: string;
  state: "pending" | "succeeded" | "failed" | "unknown";
  revision: number;
  startedAt: string;
  completedAt?: string;
  message?: string;
}
export interface KernelState {
  status: "stopped" | "starting" | "running" | "failed" | "unknown";
  pid?: number;
  appliedRevision?: number;
  operationId?: string;
  message?: string;
  systemControl: boolean;
  systemProxyOwned?: boolean;
  tunInterface?: string;
  version?: string;
}
export interface SystemProxyObservation {
  kind: "http" | "https" | "socks";
  host: string;
  port: number;
}
export interface NetworkState {
  systemProxies?: SystemProxyObservation[];
  pacEnabled?: boolean;
  ipv6Routes?: string[];
  capturedAt: string;
  defaultInterface: string | null;
  defaultGateway: string | null;
  proxyEnabled: boolean | null;
  interfaces: { name: string; addresses: string[]; cidrs?: string[] }[];
  dns: { domain: string; servers: string[] }[];
  routes: string[];
  warnings: string[];
  plugins: {
    id: string;
    name: string;
    installed: boolean;
    running: boolean | null;
    detail: string;
  }[];
}
export interface FlowRecord {
  id: string;
  target: string;
  protocol: string;
  outbound: string;
  rule: string;
  upload: number;
  download: number;
  state: "active" | "closed";
}
export interface TrafficSample {
  at: number;
  uploadRate: number | null;
  downloadRate: number | null;
}
export interface TrafficSnapshot {
  sampledAt?: number;
  uploadRate?: number | null;
  downloadRate?: number | null;
  history?: TrafficSample[];
  activeConnections?: number;
  available: boolean;
  upload: number;
  download: number;
  flows: FlowRecord[];
}
export interface AppSnapshot {
  extensionRevision?: number;
  extensions?: import("./extensions").ExtensionState[];
  protocol: 1;
  epoch: number;
  releaseSet: string;
  serviceVersion?: string;
  lifecycle: Lifecycle;
  configuration: Configuration;
  traffic?: TrafficSnapshot;
  kernel: KernelState;
  operations: Operation[];
  network: NetworkState | null;
  nodeMeasurements?: {
    id: string;
    state: "running" | "succeeded" | "failed";
    delayMs?: number;
    measuredAt?: string;
    message?: string;
  }[];
  networkConflicts?: {
    id: string;
    severity: "blocked" | "warning";
    message: string;
  }[];
  modules: { id: string; name: string; version: string; status: Lifecycle }[];
}
export interface FlowGateClient {
  cancel(operationId: string): Promise<{ requested: boolean }>;
  request<T = unknown>(
    method: string,
    payload?: unknown,
    operationId?: string,
  ): Promise<T>;
  subscribe(listener: (snapshot: AppSnapshot) => void): () => void;
}
export type AppearanceSource = "system" | "light" | "dark";
export interface NativeAppearance {
  source: AppearanceSource;
  dark: boolean;
  highContrast: boolean;
  reducedTransparency: boolean;
  differentiateWithoutColor: boolean;
}
export interface ShellPort {
  onAppearance?: (listener: (value: NativeAppearance) => void) => () => void;
  setReleaseHandler?: (handler: () => Promise<void>) => () => void;
  prepareRelease?: () => Promise<void>;
  onNavigate?: (listener: (route: string) => void) => () => void;
  version: string;
  platform: string;
  request(
    method:
      | "appearance.get"
      | "appearance.set"
      | "release.status"
      | "release.check"
      | "release.activate"
      | "window.reload"
      | "app.quit"
      | "application.check"
      | "gateway.status"
      | "diagnostics.trace"
      | "gateway.start"
      | "gateway.stop"
      | "ui.ready"
      | "ui.context"
      | "ui.trace"
      | "ui.draft.get"
      | "ui.draft.set"
      | "helper.install"
      | "recovery.status"
      | "recovery.disconnect"
      | "recovery.restore",
    payload?: unknown,
  ): Promise<unknown>;
}
export interface NativePort {
  control?(): Promise<{ endpoint: string; secret: string } | null>;
  status(): Promise<KernelState>;
  apply(
    config: unknown,
    revision: number,
    operationId: string,
    mode?: Settings["mode"],
  ): Promise<KernelState>;
  stop(operationId: string): Promise<KernelState>;
}
export interface CapabilityManifest {
  id: string;
  version: string;
  api: 1;
  dependencies: string[];
  capabilities: (
    | "services"
    | "endpoints"
    | "streams"
    | "egress"
    | "credentials"
    | "storage"
    | "jobs"
    | "uiContributions"
    | "observability"
    | "releaseLifecycle"
  )[];
}
export interface ServiceLifecycle {
  prepare(signal: AbortSignal): Promise<void>;
  start(): Promise<void>;
  health(): Promise<boolean>;
  drain(deadline: number): Promise<void>;
  stop(): Promise<void>;
}
export interface ReleaseSet {
  catalogVersion?: 1;
  id: string;
  version: number;
  channel: "stable" | "preview";
  publisher?: "flowgate";
  platforms?: string[];
  components?: { ui: string; service: string; extension: string };
  shellApi: { min: number; max: number };
  protocol: 1;
  schema: { min: number; max: number };
  ui: string;
  service: string;
  extension: string;
  builtins: {
    id: string;
    version: string;
    capabilities?: CapabilityManifest["capabilities"];
    permissions?: string[];
    contributions?: string[];
  }[];
  releaseNotes?: string;
  files: Record<string, { sha256: string; size: number }>;
  revoked?: boolean;
}
export function assertRequest(value: unknown): asserts value is RpcRequest {
  const v = value as RpcRequest;
  if (
    !v ||
    v.protocol !== 1 ||
    typeof v.id !== "string" ||
    v.id.length > 100 ||
    !Number.isSafeInteger(v.epoch) ||
    typeof v.session !== "string" ||
    typeof v.method !== "string" ||
    v.method.length > 80 ||
    (v.operationId !== undefined && !/^[\w-]{1,100}$/.test(v.operationId))
  )
    throw new Error("Invalid request envelope");
}
