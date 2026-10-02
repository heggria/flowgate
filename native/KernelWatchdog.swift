import Foundation
import Darwin
// A tiny independent guardian survives SIGKILL of the bridge/helper. Birth IDs
// prevent PID reuse from killing unrelated processes. It never starts a proxy.
func runKernelWatchdogIfRequested(recoveryWait: (TimeInterval) -> Void = { Thread.sleep(forTimeInterval: $0) }) -> Bool {
    let args = CommandLine.arguments
    guard args.count > 1, args[1] == "--watch-kernel" else { return false }
    guard args.count == 8, let owner = Int32(args[2]), let kernel = Int32(args[4]),
          owner > 1, kernel > 1 else { return true }
    while processBirth(kernel) == args[5] {
        if processBirth(owner) != args[3] {
            kill(kernel, SIGTERM)
            let deadline = Date().addingTimeInterval(4)
            while processBirth(kernel) == args[5] && Date() < deadline { Thread.sleep(forTimeInterval: 0.05) }
            if processBirth(kernel) == args[5] { kill(kernel, SIGKILL) }
            break
        }
        Thread.sleep(forTimeInterval: 0.25)
    }
    // The kernel may have exited before this watchdog started, or while its
    // owner was dying. Restore in both cases, under the journal generation lock.
    // A replacement kernel with the same PID must never be terminated here.
    if args[7] == "privileged", geteuid() == 0 {
        var delay: TimeInterval = 1
        // The helper can be dead, so its in-process SessionCleanup cannot retry
        // a transient preference lock/commit failure. Keep this orphan recovery
        // bounded (eight attempts, 91s total backoff), and reload each generation.
        for attempt in 0..<8 {
            do {
                let journal = try OwnershipJournal(directory: URL(fileURLWithPath: args[6]))
                guard journal.record.kernelPID == kernel, journal.record.kernelBirth == args[5] else { return true }
                // restore also compares the latest journal under the preferences
                // lock; a successor arriving after the read must remain untouched.
                try SystemProxyOwner(journal: journal).restore(expectedKernel: (kernel, args[5]))
                return true
            } catch {
                if attempt == 7 {
                    FileHandle.standardError.write(Data("FlowGate watchdog: owned system recovery remains pending\n".utf8))
                    break
                }
                recoveryWait(delay)
                delay = min(delay * 2, 30)
            }
        }
    }
    return true
}
func startKernelWatchdog(kernel: Int32, directory: URL, privileged: Bool) throws {
    guard let ownerBirth = processBirth(getpid()), let kernelBirth = processBirth(kernel) else { throw NSError(domain: "无法建立内核恢复租约", code: 38) }
    let watcher = Process()
    watcher.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
    watcher.arguments = ["--watch-kernel", String(getpid()), ownerBirth, String(kernel), kernelBirth, directory.path, privileged ? "privileged" : "manual"]
    watcher.standardInput = FileHandle.nullDevice; watcher.standardOutput = FileHandle.nullDevice; watcher.standardError = FileHandle.nullDevice
    try watcher.run()
}
