const routes = new Set([
  "overview",
  "connections",
  "nodes",
  "rules",
  "network",
  "activity",
  "settings",
]);
export function deepLinkRoute(input: string): string | undefined {
  if (
    typeof input !== "string" ||
    input.length > 256 ||
    !/^flowgate:\/\/open\/[a-z]+$/.test(input)
  )
    return;
  try {
    const url = new URL(input);
    if (
      url.protocol !== "flowgate:" ||
      url.hostname !== "open" ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash
    )
      return;
    const route = url.pathname.slice(1);
    return routes.has(route) ? route : undefined;
  } catch {
    return;
  }
}
