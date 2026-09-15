// Independent peer fixture: a real second kernel, with only a dedicated /32 route.
// Configuration validation is unprivileged; running it is restricted to the CI guard.
export function independentTUNConfiguration(port: number) {
  return {
    log: { level: "warn" },
    inbounds: [
      {
        type: "tun",
        tag: "peer-in",
        interface_name: "utun",
        address: ["172.30.0.1/30"],
        auto_route: true,
        strict_route: true,
        route_address: ["198.18.0.89/32"],
      },
    ],
    outbounds: [
      {
        type: "http",
        tag: "peer-out",
        server: "127.0.0.1",
        server_port: port,
        bind_interface: "lo0",
      },
    ],
    route: { auto_detect_interface: true, final: "peer-out" },
  };
}
