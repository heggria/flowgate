import type {
  Configuration,
  KernelState,
  NetworkState,
} from "../../contracts/src/index";
export interface NetworkConflict {
  id: string;
  severity: "blocked" | "warning";
  message: string;
}
export function networkConflicts(
  c: Configuration,
  observed: NetworkState | null,
  kernel: KernelState,
): NetworkConflict[] {
  if (!observed) return [];
  const issues: NetworkConflict[] = [];
  const interfaces = new Set(observed.interfaces.map((i) => i.name));
  for (const external of c.externalNetworks ?? []) {
    if (!interfaces.has(external.interface))
      issues.push({
        id: "interface:" + external.id,
        severity: "blocked",
        message: `${external.name} 的接口 ${external.interface} 已消失；该出口将连接失败，请恢复接口或修改规则。`,
      });
  }
  if (
    c.settings.mode === "system" &&
    observed.proxyEnabled &&
    !kernel.systemControl
  )
    issues.push({
      id: "existing-proxy",
      severity: "blocked",
      message:
        "系统已启用其他代理或 PAC。请先在所属应用中关闭接管，或使用手动代理模式。",
    });
  if (
    c.settings.mode === "tun" &&
    observed.defaultInterface?.startsWith("utun")
  )
    issues.push({
      id: "tunnel-default",
      severity: "warning",
      message:
        "默认出口为隧道接口。无法仅凭接口确认强制 VPN 策略；TUN 接管前需要验证路由和 DNS 共存。",
    });
  return issues;
}
