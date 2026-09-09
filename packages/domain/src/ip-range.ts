/** Numeric ranges keep overlap checks independent of textual IPv6 spelling. */
function address(value: string): { value: bigint; bits: number } | undefined {
  value = value.split("%")[0];
  if (!value.includes(":")) {
    const parts = value.split(".");
    if (
      parts.length !== 4 ||
      parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)
    )
      return;
    return {
      value: parts.reduce((n, p) => (n << 8n) | BigInt(p), 0n),
      bits: 32,
    };
  }
  if (value.includes(".")) {
    const index = value.lastIndexOf(":"),
      tail = address(value.slice(index + 1));
    if (!tail || tail.bits !== 32) return;
    value =
      value.slice(0, index + 1) +
      (tail.value >> 16n).toString(16) +
      ":" +
      (tail.value & 65535n).toString(16);
  }
  const halves = value.split("::");
  if (halves.length > 2) return;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return;
  const parts = [...left, ...Array(missing).fill("0"), ...right];
  if (parts.some((p) => !/^[\da-f]{1,4}$/i.test(p))) return;
  return {
    value: parts.reduce((n, p) => (n << 16n) | BigInt("0x" + p), 0n),
    bits: 128,
  };
}
export function cidrOverlap(a: string, b: string): boolean {
  const parse = (input: string) => {
    const parts = input.split("/"),
      ip = address(parts[0]);
    if (!ip || parts.length > 2) return;
    const prefix =
      parts.length === 1
        ? ip.bits
        : /^\d+$/.test(parts[1])
          ? Number(parts[1])
          : -1;
    if (prefix < 0 || prefix > ip.bits) return;
    const shift = BigInt(ip.bits - prefix),
      start = (ip.value >> shift) << shift;
    return { bits: ip.bits, start, end: start + (1n << shift) - 1n };
  };
  const x = parse(a),
    y = parse(b);
  return (
    !!x && !!y && x.bits === y.bits && x.start <= y.end && y.start <= x.end
  );
}
export const tunAddresses = ["172.29.0.1/30", "fdfe:dcba:9876::1/126"];
