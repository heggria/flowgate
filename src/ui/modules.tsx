import { client } from "../../packages/client/src/index";
import { ConnectionDetails } from "./features/ConnectionDetails";
import { RuleSources } from "./features/RuleSources";
import { GatewaySettings } from "./features/GatewaySettings";
import type { ComponentType } from "react";
import type {
  AppSnapshot,
  Configuration,
  FlowRecord,
} from "../../packages/contracts/src/index";
import type { RuntimeModule } from "../../packages/runtime/src/lifecycle";
import { Traffic } from "./features/Traffic";
import { RoutePreview } from "./features/RoutePreview";
import { Overview } from "./features/Overview";
import { Nodes } from "./features/Nodes";
import { Rules } from "./features/Rules";
import { Network } from "./features/Network";
import { Activity } from "./features/Activity";
import { Settings } from "./features/Settings";
import { Extensions } from "./features/Extensions";
export interface DetailPanelContribution {
  id: string;
  Component: ComponentType<{ flow: FlowRecord; configuration: Configuration }>;
}
export interface CommandContribution {
  id: string;
  label: string;
  execute(context: {
    navigate: (id: string) => void;
    snapshot: AppSnapshot;
  }): Promise<unknown>;
}
export interface FeatureProps {
  detailPanels?: DetailPanelContribution[];
  settingsContributions?: ComponentType<FeatureProps>[];
  snapshot: AppSnapshot;
  save: (c: Configuration, options?: { local?: boolean }) => Promise<boolean>;
  run: (action: () => Promise<unknown>) => Promise<void>;
  navigate: (id: string) => void;
  busy: boolean;
}
export interface RouteContribution {
  id: string;
  label: string;
  icon: string;
  Component: ComponentType<FeatureProps>;
}
function NodesPage(p: FeatureProps) {
  return (
    <Nodes
      config={p.snapshot.configuration}
      run={p.run}
      measurements={p.snapshot.nodeMeasurements}
      save={p.save}
      running={p.snapshot.kernel.status === "running"}
      appliedRevision={p.snapshot.kernel.appliedRevision}
    />
  );
}
function RulesPage(p: FeatureProps) {
  return (
    <>
      <Rules config={p.snapshot.configuration} save={p.save} />
      <RuleSources {...p} />
      <RoutePreview />
    </>
  );
}
function SettingsPage(p: FeatureProps) {
  return (
    <>
      <Settings config={p.snapshot.configuration} save={p.save} run={p.run} />
      {p.settingsContributions?.map((Component, index) => (
        <Component key={index} {...p} />
      ))}
    </>
  );
}
function ConnectionsPage(p: FeatureProps) {
  return (
    <>
      <h1>连接</h1>
      <Traffic
        traffic={p.snapshot.traffic}
        configuration={p.snapshot.configuration}
        detailPanels={p.detailPanels}
      />
    </>
  );
}
const contributions: RouteContribution[] = [
  { id: "overview", label: "概览", icon: "⌁", Component: Overview },
  { id: "connections", label: "连接", icon: "", Component: ConnectionsPage },
  { id: "nodes", label: "节点与订阅", icon: "◈", Component: NodesPage },
  { id: "rules", label: "分流规则", icon: "⑂", Component: RulesPage },
  { id: "network", label: "网络环境", icon: "◎", Component: Network },
  { id: "activity", label: "操作记录", icon: "≡", Component: Activity },
  { id: "extensions", label: "扩展", icon: "", Component: Extensions },
  { id: "settings", label: "设置", icon: "⚙", Component: SettingsPage },
];
export const modules: RuntimeModule[] = contributions.map((route) => ({
  manifest: {
    id: route.id,
    version: "1.0.0",
    api: 1,
    dependencies: [],
    capabilities: ["uiContributions"],
  },
  async activate(context) {
    context.contribute({ id: route.id, kind: "route", value: route });
  },
}));

modules.push({
  manifest: {
    id: "internal.gateway-settings",
    version: "1.0.0",
    api: 1,
    dependencies: ["settings"],
    capabilities: ["uiContributions"],
  },
  async activate(context) {
    context.contribute({
      id: "internal.gateway-settings",
      kind: "settings",
      value: GatewaySettings,
    });
  },
});

modules.push({
  manifest: {
    id: "workspace.commands",
    version: "1.0.0",
    api: 1,
    dependencies: ["overview"],
    capabilities: ["uiContributions"],
  },
  async activate(context) {
    context.contribute({
      id: "refresh-network",
      kind: "command",
      value: {
        id: "refresh-network",
        label: "刷新网络状态",
        execute: () => client.request("network.refresh"),
      } satisfies CommandContribution,
    });
    context.contribute({
      id: "apply-configuration",
      kind: "command",
      value: {
        id: "apply-configuration",
        label: "应用当前配置",
        execute: () => client.request("proxy.connect", {}, crypto.randomUUID()),
      } satisfies CommandContribution,
    });
    context.contribute({
      id: "connection-details",
      kind: "detailPanel",
      value: {
        id: "connection-details",
        Component: ConnectionDetails,
      } satisfies DetailPanelContribution,
    });
  },
});
