import { cidrOverlap, tunAddresses } from "./ip-range";
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
    if (
      kernel.status === "running" &&
      external.interface === kernel.tunInterface
    )
      issues.push({
        id: "own-tunnel:" + external.id,
        severity: "blocked",
        message: `${external.name} 指向本应用拥有的 TUN 接口，会形成出口循环。`,
      });
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
    kernel.systemProxyOwned !== true
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
  if (c.settings.mode === "tun") {
    for (const iface of observed.interfaces) {
      if (kernel.status === "running" && iface.name === kernel.tunInterface)
        continue;
      const ranges = iface.cidrs?.length ? iface.cidrs : iface.addresses;
      if (
        ranges.some((range) =>
          tunAddresses.some((tun) => cidrOverlap(range, tun)),
        )
      )
        issues.push({
          id: "tun-address:" + iface.name,
          severity: "blocked",
          message: `TUN 地址与 ${iface.name} 的现有网段重叠。请使用手动代理模式，或先在所属应用中解决地址冲突。`,
        });
    }
  }
  if (c.settings.mode === "tun") {
    for (const line of [...observed.routes, ...(observed.ipv6Routes ?? [])]) {
      const [destination, , flags, iface] = line.trim().split(/\s+/);
      if (
        !iface ||
        iface === kernel.tunInterface ||
        /[LW]/.test(flags) ||
        destination === "default"
      )
        continue;
      const [host, prefix] = destination.split("/");
      const ipv6 = host.includes(":");
      const parts = host.split(".");
      const bits =
        prefix === undefined ? (ipv6 ? 128 : parts.length * 8) : Number(prefix);
      if (bits <= 1 || !Number.isInteger(bits)) continue; // Default and split-default routes do not claim interface addresses.
      const cidr = ipv6
        ? destination
        : [...parts, ...Array(Math.max(0, 4 - parts.length)).fill("0")].join(
            ".",
          ) +
          "/" +
          bits;
      if (tunAddresses.some((tun) => cidrOverlap(tun, cidr)))
        issues.push({
          id: "tun-route:" + iface + ":" + destination,
          severity: "blocked",
          message: `TUN 地址与 ${iface} 的现有路由网段 ${destination} 重叠。请使用手动代理模式或先解决网段冲突。`,
        });
    }
  }
  return issues;
}
