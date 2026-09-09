import type {
  Configuration,
  FlowRecord,
} from "../../../packages/contracts/src/index";
import { outboundName } from "../format";
export function ConnectionDetails({
  flow,
  configuration,
}: {
  flow: FlowRecord;
  configuration: Configuration;
}) {
  const name =
    configuration.nodes.find((node) => node.id === flow.outbound)?.name ??
    configuration.externalNetworks?.find(
      (network) => network.id === flow.outbound,
    )?.name ??
    outboundName(flow.outbound);
  return (
    <dl>
      <dt>目标</dt>
      <dd>{flow.target}</dd>
      <dt>协议</dt>
      <dd>{flow.protocol.toUpperCase()}</dd>
      <dt>匹配规则</dt>
      <dd>{flow.rule || "默认规则"}</dd>
      <dt>出口</dt>
      <dd>{name}</dd>
      <dt>状态</dt>
      <dd>{flow.state === "active" ? "活跃" : "已结束"}</dd>
    </dl>
  );
}
