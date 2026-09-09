export interface PluginReport {
  id: string;
  name: string;
  installed: boolean;
  running: boolean | null;
  detail: string;
  error?: string;
}
export interface Snapshot {
  systemProxies?: import("../../packages/contracts/src/index").SystemProxyObservation[];
  pacEnabled?: boolean;
  ipv6Routes?: string[];
  capturedAt: string;
  platform: string;
  interfaces: { name: string; addresses: string[]; cidrs?: string[] }[];
  defaultInterface: string | null;
  defaultGateway: string | null;
  proxyEnabled: boolean | null;
  dns: { domain: string; servers: string[] }[];
  routes: string[];
  plugins: PluginReport[];
  warnings: string[];
}
export interface PreviewInput {
  target: string;
  corporateSuffix: string;
}
export interface Decision {
  category: string;
  context: string;
  reason: string;
  dns: string;
  fallback: string;
  applied: false;
}
