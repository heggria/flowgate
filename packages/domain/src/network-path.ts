import type { NetworkState } from "../../contracts/src/index";
/** Ignore counters, expiry, neighbour cache and kernel-created host clones. */
export function networkPath(
  state: NetworkState,
  ownedInterface?: string,
): string {
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
        addresses: [...i.addresses].sort(),
        cidrs: [...(i.cidrs ?? [])].sort(),
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
