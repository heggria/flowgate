import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
const directory = mkdtempSync(resolve("work/watchdog-recovery-"));
const source = join(directory, "Probe.swift");
writeFileSync(
  source,
  `import Foundation
var restored = false
var attempts = 0
var loads = 0
var waits: [TimeInterval] = []
func processBirth(_ pid: Int32) -> String? { CommandLine.arguments[6] == "reused-pid" ? "new-birth" : nil }
func geteuid() -> UInt32 { 0 }
@discardableResult func kill(_ pid: Int32, _ signal: Int32) -> Int32 { fatalError("Never signal exited/reused PIDs") }
struct Record { var kernelPID: Int32? = 999992; var kernelBirth: String? = "old-birth" }
class OwnershipJournal {
 var record = Record()
 init(directory: URL) throws { loads += 1; if CommandLine.arguments[6] == "journal-transient" && loads < 3 { throw NSError(domain: "injected read contention", code: 1) }; if CommandLine.arguments[6] == "new-generation" || (CommandLine.arguments[6] == "successor-after-failure" && loads > 1) { record.kernelPID = 999993; record.kernelBirth = "new-birth" } }
}
struct SystemProxyOwner {
 init(journal: OwnershipJournal) {}
 func restore(expectedKernel: (Int32, String)) throws { precondition(expectedKernel.0 == 999992 && expectedKernel.1 == "old-birth"); attempts += 1; if ["transient-failure", "successor-after-failure"].contains(CommandLine.arguments[6]) && attempts == 1 || CommandLine.arguments[6] == "permanent-failure" { throw NSError(domain: "injected lock contention", code: 15) }; restored = true }
}
@main struct Probe { static func main() { precondition(runKernelWatchdogIfRequested(recoveryWait: { waits.append($0) }));
 let scenario = CommandLine.arguments[6]
 if scenario == "transient-failure" { precondition(attempts == 2 && waits == [1]) }
 if scenario == "journal-transient" { precondition(loads == 3 && attempts == 1 && waits == [1, 2]) }
 if scenario == "successor-after-failure" { precondition(attempts == 1 && waits == [1]) }
 if scenario == "permanent-failure" { precondition(attempts == 8 && waits == [1, 2, 4, 8, 16, 30, 30]) }
 print(restored ? "restored" : "untouched") } }
`,
);
execFileSync("/usr/bin/swiftc", [
  "native/KernelWatchdog.swift",
  source,
  "-o",
  join(directory, "probe"),
]);
for (const [scenario, mode, expected] of [
  ["already-exited", "privileged", "restored"],
  ["transient-failure", "privileged", "restored"],
  ["journal-transient", "privileged", "restored"],
  ["successor-after-failure", "privileged", "untouched"],
  ["permanent-failure", "privileged", "untouched"],
  ["reused-pid", "privileged", "restored"],
  ["new-generation", "privileged", "untouched"],
  ["already-exited", "manual", "untouched"],
])
  assert.equal(
    execFileSync(
      join(directory, "probe"),
      [
        "--watch-kernel",
        "999991",
        "owner-birth",
        "999992",
        "old-birth",
        scenario,
        mode,
      ],
      { encoding: "utf8" },
    ).trim(),
    expected,
  );
console.log(
  "PASS production watchdog: exited kernel recovery, PID reuse safety, successor ownership, transient lock/read retry, bounded permanent failure and manual isolation (injected backend)",
);
