import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync("work", { recursive: true });
const result = spawnSync(
  "npm",
  [
    "audit",
    "--json",
    "--registry=https://registry.npmjs.org",
    "--fetch-retries=1",
    "--fetch-timeout=30000",
  ],
  { encoding: "utf8", timeout: 90000, maxBuffer: 10 * 1024 * 1024 },
);
writeFileSync(
  "work/dependency-audit.json",
  result.stdout ||
    JSON.stringify({ error: result.error?.message || "Empty audit response" }),
);
let report;
try {
  report = JSON.parse(result.stdout);
} catch {
  throw new Error("Dependency audit unavailable: invalid or empty response");
}
if (result.error || report.error || !report.metadata?.vulnerabilities)
  throw new Error(
    "Dependency audit unavailable; this is not a clean vulnerability result",
  );
const counts = report.metadata.vulnerabilities;
console.log(JSON.stringify(counts));
if (counts.high || counts.critical)
  throw new Error(
    "High/critical dependency advisories require review; see work/dependency-audit.json",
  );
if (result.status !== 0 && result.status !== 1)
  throw new Error("Dependency audit process failed");
