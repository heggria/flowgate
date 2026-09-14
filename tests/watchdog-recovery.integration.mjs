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
func processBirth(_ pid: Int32) -> String? { CommandLine.arguments[6] == "reused-pid" ? "new-birth" : nil }
func geteuid() -> UInt32 { 0 }
@discardableResult func kill(_ pid: Int32, _ signal: Int32) -> Int32 { fatalError("Never signal exited/reused PIDs") }
struct Record { var kernelPID: Int32? = 999992; var kernelBirth: String? = "old-birth" }
class OwnershipJournal {
 var record = Record()
 init(directory: URL) throws { if CommandLine.arguments[6] == "new-generation" { record.kernelPID = 999993; record.kernelBirth = "new-birth" } }
}
struct SystemProxyOwner {
 init(journal: OwnershipJournal) {}
 func restore(expectedKernel: (Int32, String)) throws { precondition(expectedKernel.0 == 999992 && expectedKernel.1 == "old-birth"); restored = true }
}
@main struct Probe { static func main() { precondition(runKernelWatchdogIfRequested()); print(restored ? "restored" : "untouched") } }
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
  "PASS production watchdog: exited kernel recovery, PID reuse safety, successor ownership and manual isolation (injected backend)",
);
