import { readFile, readdir } from "node:fs/promises";
const failures = [];
async function walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = dir + "/" + e.name;
    if (e.isDirectory()) await walk(p);
    else if (/\.[jt]sx?$/.test(p)) {
      const code = await readFile(p, "utf8");
      const imports = [
        ...code.matchAll(/(?:from\s*|import\s*\()['"]([^'"]+)/g),
      ].map((m) => m[1]);
      if (
        p.startsWith("src/ui") ||
        p.startsWith("packages/client") ||
        p.startsWith("packages/domain")
      )
        for (const ref of imports)
          if (
            ref.startsWith("node:") ||
            ["electron", "fs", "path", "child_process"].includes(ref) ||
            ref.includes("/platform/")
          )
            failures.push(p + ": " + ref);
      if (p.startsWith("packages/shell") || p === "src/desktop/main.ts")
        for (const ref of imports)
          if (
            ["/domain/", "/service/", "/extensions/"].some((x) =>
              ref.includes(x),
            )
          )
            failures.push(p + ": " + ref);
    }
  }
}
await walk("src");
await walk("packages");
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("Dependency boundaries verified");
