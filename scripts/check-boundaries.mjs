import { readFile, readdir } from "node:fs/promises";
import { builtinModules } from "node:module";
import { posix, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "@babel/parser";
const builtins = new Set(
  builtinModules.map((name) => name.replace(/^node:/, "")),
);
export function boundaryViolations(path, code) {
  const pure =
    /^(src\/ui\/|packages\/(client|domain)\/)/.test(path) ||
    path === "packages/runtime/src/lifecycle.ts";
  const shell =
    path.startsWith("packages/shell/") || path === "src/desktop/main.ts";
  if (!pure && !shell) return [];
  const failures = [];
  const source = parse(code, {
    sourceType: "unambiguous",
    plugins: ["typescript", ...(path.endsWith("x") ? ["jsx"] : [])],
    createImportExpressions: true,
  });
  const check = (node) => {
    if (!node || node.type !== "StringLiteral") {
      failures.push(path + ": non-literal module loading cannot be checked");
      return;
    }
    const ref = node.value;
    const target = ref.startsWith(".")
      ? posix.normalize(posix.join(posix.dirname(path), ref))
      : ref.replace(/^@flowgate\//, "packages/");
    if (
      pure &&
      (ref.startsWith("node:") ||
        builtins.has(ref) ||
        ref === "electron" ||
        target.startsWith("src/platform/") ||
        (/^packages\/(service|shell|extensions|runtime|release)(\/|$)/.test(
          target,
        ) &&
          !/^packages\/runtime\/src\/lifecycle(?:\.ts)?$/.test(target)))
    )
      failures.push(path + ": forbidden runtime dependency " + ref);
    if (shell && /^packages\/(domain|service|extensions)(\/|$)/.test(target))
      failures.push(path + ": business implementation import " + ref);
  };
  function visit(node) {
    if (
      [
        "ImportDeclaration",
        "ExportNamedDeclaration",
        "ExportAllDeclaration",
      ].includes(node.type) &&
      node.source
    )
      check(node.source);
    if (node.type === "TSExternalModuleReference") check(node.expression);
    if (node.type === "ImportExpression") check(node.source);
    if (
      node.type === "CallExpression" &&
      (node.callee.type === "Import" ||
        (node.callee.type === "Identifier" && node.callee.name === "require"))
    )
      check(node.arguments[0]);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) if (child?.type) visit(child);
      } else if (value?.type) visit(value);
    }
  }
  visit(source);
  return failures;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const failures = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = dir + "/" + entry.name;
      if (entry.isDirectory()) await walk(path);
      else if (/\.[cm]?[jt]sx?$/.test(path))
        failures.push(
          ...boundaryViolations(path, await readFile(path, "utf8")),
        );
    }
  }
  await walk("src");
  await walk("packages");
  if (failures.length) {
    console.error(failures.join("\n"));
    process.exitCode = 1;
  } else console.log("AST dependency boundaries verified");
}
