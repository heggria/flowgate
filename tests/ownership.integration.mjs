import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
await mkdir("work", { recursive: true });
const work = await mkdtemp(resolve("work/ownership-"));
execFileSync(
  "/usr/bin/swiftc",
  [
    "-module-cache-path",
    join(work, "module-cache"),
    "native/OwnershipJournal.swift",
    "tests/OwnershipTests.swift",
    "-o",
    join(work, "test"),
  ],
  { stdio: "inherit" },
);
execFileSync(join(work, "test"), [join(work, "data")], { stdio: "inherit" });
// Compile the actual session/delegate code with in-memory dependencies. The
// excluded entry point installs/starts the root service and must never run here.
const helper = await readFile("native/Helper.swift", "utf8");
const entryPoint = helper.indexOf("@main struct Helper {");
assert.ok(entryPoint > 0, "Expected helper installation entry point");
await writeFile(
  join(work, "HelperSessions.swift"),
  helper.slice(0, entryPoint),
);
execFileSync(
  "/usr/bin/swiftc",
  [
    "-module-cache-path",
    join(work, "module-cache"),
    "native/SessionLease.swift",
    join(work, "HelperSessions.swift"),
    "tests/SessionLeaseTests.swift",
    "-o",
    join(work, "session-test"),
  ],
  { stdio: "inherit" },
);
execFileSync(join(work, "session-test"), [], { stdio: "inherit" });
await writeFile(
  "work/ownership-result.json",
  JSON.stringify(
    {
      passed: true,
      at: new Date().toISOString(),
      backend: "injected preferences; does not write real system settings",
      checks: [
        "PAC refusal",
        "foreign partial mutation preserved",
        "unowned fields preserved",
        "commit failure retry",
        "durable recovery after journal reload",
        "missing service retry",
        "old session retries cannot stop new resources",
        "failed cleanup fences new session admission",
        "production helper restores after six consecutive failures without restart",
        "duplicate cleanup and replayed callbacks keep one retry chain",
        "exponential retry delay capped at 30 seconds continues through eighteen failures",
        "stale generations preserve successor resources, monitors and admission fences",
      ],
    },
    null,
    2,
  ),
);
console.log("Ownership/session recovery evidence: work/ownership-result.json");
