import { mkdir, writeFile, copyFile, chmod } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
if (process.platform !== "darwin" || process.arch !== "arm64")
  throw new Error("macOS arm64 required");
const name = "sing-box-1.14.0-darwin-arm64";
const response = await fetch(
  `https://github.com/SagerNet/sing-box/releases/download/v1.14.0/${name}.tar.gz`,
  { signal: AbortSignal.timeout(120000) },
);
if (!response.ok) throw new Error("Kernel download failed");
const bytes = Buffer.from(await response.arrayBuffer());
if (
  createHash("sha256").update(bytes).digest("hex") !==
  "a150c94012ff768b7261939cd236b9c8554127f45137230295d23a5660225cc9"
)
  throw new Error("Kernel checksum mismatch");
await mkdir("work/kernel-download", { recursive: true });
await mkdir("vendor", { recursive: true });
await writeFile("work/kernel-download/kernel.tar.gz", bytes);
execFileSync("/usr/bin/tar", [
  "-xzf",
  "work/kernel-download/kernel.tar.gz",
  "-C",
  "work/kernel-download",
  `${name}/sing-box`,
]);
await copyFile(`work/kernel-download/${name}/sing-box`, "vendor/sing-box");
await chmod("vendor/sing-box", 0o755);
