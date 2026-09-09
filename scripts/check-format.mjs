import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
const base = process.argv[2];
if (!base || !/^[a-f0-9]{40}$/.test(base))
  throw new Error("Provide the 40-character base commit for the format check");
const files = execFileSync(
  "git",
  ["diff", "--name-only", "--diff-filter=ACMR", base, "HEAD", "-z"],
  { encoding: "utf8" },
)
  .split("\0")
  .filter(
    (file) =>
      /\.(?:[cm]?[jt]sx?|json|css|ya?ml)$/.test(file) &&
      !["package-lock.json", "vendor/manifest.json"].includes(file),
  );
if (files.length)
  execFileSync(
    process.execPath,
    [resolve("node_modules/prettier/bin/prettier.cjs"), "--check", ...files],
    { stdio: "inherit" },
  );
else console.log("No changed formattable files");
