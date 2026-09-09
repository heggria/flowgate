export function normalizedHost(host: string) {
  const address =
    host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  try {
    return new URL(`http://${address}/`).hostname
      .toLowerCase()
      .replace(/\.$/, "");
  } catch {
    return host.toLowerCase().replace(/\.$/, "");
  }
}
export function isLoopbackHost(host: string) {
  const value = normalizedHost(host);
  return (
    value === "localhost" ||
    value.endsWith(".localhost") ||
    value.startsWith("127.") ||
    value === "0.0.0.0" ||
    value === "[::1]" ||
    value === "[::]" ||
    /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(value)
  );
}
