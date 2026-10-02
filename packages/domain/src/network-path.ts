import type { NetworkState } from "../../contracts/src/index";
import { cidrOverlap } from "./ip-range";
/** Ignore counters, expiry, neighbour cache and kernel-created host clones. */
export function networkPath(
  state: NetworkState,
  ownedInterface?: string,
  dependentInterfaces: readonly string[] = [],
): string {
  const linkLocal = (value: string) => {
    const [host, prefix, extra] = value.split("/");
    // Only ranges contained within fe80::/10 are harmless peer addresses. A
    // wider/invalid prefix may carry a real conflict and must remain visible.
    return (
      extra === undefined &&
      host.includes(":") &&
      (prefix === undefined ||
        (/^\d+$/.test(prefix) &&
          Number(prefix) >= 10 &&
          Number(prefix) <= 128)) &&
      cidrOverlap(value, "fe80::/10")
    );
  };
  const peerChurn = (name: string) =>
    "platform" in state &&
    state.platform === "darwin" &&
    /^(awdl|llw)\d+$/.test(name) &&
    name !== state.defaultInterface &&
    !dependentInterfaces.includes(name);
  const routes = (lines: string[]) =>
    lines
      .flatMap((line) => {
        const [destination, gateway, flags, iface] = line.trim().split(/\s+/);
        if (
          !iface ||
          iface === ownedInterface ||
          /[LW]/.test(flags) ||
          (flags.includes("H") && !flags.includes("S"))
        )
          return [];
        return [`${destination} ${gateway} ${iface}`];
      })
      .sort();
  return JSON.stringify({
    defaultInterface: state.defaultInterface,
    gateway: state.defaultGateway,
    interfaces: state.interfaces
      .filter((i) => i.name !== ownedInterface)
      .map((i) => ({
        name: i.name,
        // Keep interface existence, routable addresses, configured/default
        // dependencies and all route/DNS/proxy data. Only Darwin's unbound peer
        // link-local privacy rotation is unrelated to the current egress path.
        addresses: i.addresses
          .filter((a) => !peerChurn(i.name) || !linkLocal(a))
          .sort(),
        cidrs: (i.cidrs ?? [])
          .filter((a) => !peerChurn(i.name) || !linkLocal(a))
          .sort(),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    routes: routes(state.routes),
    ipv6: routes(state.ipv6Routes ?? []),
    dns: state.dns
      .map((d) => ({ domain: d.domain, servers: [...d.servers].sort() }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    proxy: [...(state.systemProxies ?? [])].sort((a, b) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b)),
    ),
    proxyEnabled: state.proxyEnabled,
    pac: state.pacEnabled === true,
  });
}
