import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { ReleaseSet } from "../../contracts/src/index";
export function validateRelease(manifest: ReleaseSet) {
  if (
    !manifest ||
    !/^[-\w.]{1,100}$/.test(manifest.id) ||
    !Number.isSafeInteger(manifest.version) ||
    manifest.version < 1 ||
    !["stable", "preview"].includes(manifest.channel) ||
    manifest.protocol !== 1 ||
    !Number.isSafeInteger(manifest.shellApi?.min) ||
    !Number.isSafeInteger(manifest.shellApi?.max) ||
    !Number.isSafeInteger(manifest.schema?.min) ||
    !Number.isSafeInteger(manifest.schema?.max) ||
    manifest.shellApi?.min > 1 ||
    manifest.shellApi?.max < 1 ||
    manifest.schema?.min > 1 ||
    manifest.schema?.max < 1 ||
    manifest.revoked
  )
    throw new Error("版本不兼容或已撤回；可能需要完整应用更新");
  if (manifest.publisher !== undefined && manifest.publisher !== "flowgate")
    throw new Error("非官方发布者");
  if (
    manifest.platforms !== undefined &&
    (!Array.isArray(manifest.platforms) ||
      !manifest.platforms.includes(process.platform + "-" + process.arch))
  )
    throw new Error("版本不支持当前平台");
  if (
    manifest.components &&
    [
      manifest.components.ui,
      manifest.components.service,
      manifest.components.extension,
    ].some(
      (version) =>
        typeof version !== "string" || !/^[\w.+-]{1,80}$/.test(version),
    )
  )
    throw new Error("组件版本无效");
  if (!manifest.files || Object.keys(manifest.files).length > 10000)
    throw new Error("无效文件清单");
  if (
    Object.values(manifest.files).reduce((sum, file) => sum + file.size, 0) >
    128 * 1024 * 1024
  )
    throw new Error("版本包超过大小限制");
  for (const [name, file] of Object.entries(manifest.files)) {
    if (
      !/^[\w./-]+$/.test(name) ||
      name.startsWith("/") ||
      name.split("/").some((p) => !p || p === "." || p === "..") ||
      ![
        ".js",
        ".cjs",
        ".css",
        ".html",
        ".json",
        ".svg",
        ".png",
        ".woff2",
        ".proto",
      ].some((e) => name.endsWith(e)) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      file.size > 32 * 1024 * 1024 ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    )
      throw new Error("禁止的包文件或路径");
  }
  for (const entry of [manifest.ui, manifest.service, manifest.extension])
    if (!manifest.files[entry]) throw new Error("入口未声明");
  const allowed = new Set([
    "builtin.subscription",
    "builtin.network",
    "builtin.rules",
    "internal.gateway-test",
  ]);
  if (
    manifest.releaseNotes !== undefined &&
    (typeof manifest.releaseNotes !== "string" ||
      manifest.releaseNotes.length > 8000)
  )
    throw new Error("发布说明无效");
  const builtins = new Set<string>();
  for (const builtin of manifest.builtins ?? []) {
    if (
      builtins.has(builtin.id) ||
      typeof builtin.version !== "string" ||
      !/^[\w.+-]{1,80}$/.test(builtin.version)
    )
      throw new Error("内置模块版本无效");
    builtins.add(builtin.id);
    const capabilities =
      builtin.id === "internal.gateway-test"
        ? [
            "services",
            "endpoints",
            "streams",
            "egress",
            "credentials",
            "storage",
            "jobs",
            "uiContributions",
            "observability",
            "releaseLifecycle",
          ]
        : [];
    if (
      builtin.capabilities &&
      (!Array.isArray(builtin.capabilities) ||
        builtin.capabilities.some(
          (capability) => !capabilities.includes(capability),
        ))
    )
      throw new Error("模块权限提升需要完整应用更新");
    if (
      builtin.contributions &&
      (!Array.isArray(builtin.contributions) ||
        builtin.contributions.some(
          (kind) =>
            !["route", "command", "settings", "detailPanel"].includes(kind),
        ))
    )
      throw new Error("未知贡献类型");
  }
  if (
    !Array.isArray(manifest.builtins) ||
    manifest.builtins.some((b) => !allowed.has(b.id))
  )
    throw new Error("首版仅更新已内置模块");
}
export async function verifyDirectory(directory: string, manifest: ReleaseSet) {
  validateRelease(manifest);
  const root = await realpath(directory);
  const found = new Set<string>();
  const walk = async (relative: string) => {
    for (const name of await readdir(join(root, relative))) {
      const rel = relative ? relative + "/" + name : name;
      const path = join(root, rel);
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new Error("包中禁止符号链接");
      if (stat.isDirectory()) {
        await walk(rel);
        continue;
      }
      if (!stat.isFile() || !manifest.files[rel])
        throw new Error("包中含未声明文件");
      const actual = await realpath(path);
      if (!actual.startsWith(root + sep)) throw new Error("目录逃逸");
      const expected = manifest.files[rel];
      if (
        stat.size !== expected.size ||
        createHash("sha256")
          .update(await readFile(path))
          .digest("hex") !== expected.sha256
      )
        throw new Error("文件校验失败: " + rel);
      found.add(rel);
    }
  };
  await walk("");
  if (found.size !== Object.keys(manifest.files).length)
    throw new Error("缺少包文件");
  return manifest;
}
