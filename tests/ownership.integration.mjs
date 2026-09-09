import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
const work = await mkdtemp(resolve("work/ownership-"));
execFileSync(
  "/usr/bin/swiftc",
  [
    "native/OwnershipJournal.swift",
    "tests/OwnershipTests.swift",
    "-o",
    join(work, "test"),
  ],
  { stdio: "inherit" },
);
execFileSync(join(work, "test"), [join(work, "data")], { stdio: "inherit" });
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
      ],
    },
    null,
    2,
  ),
);
