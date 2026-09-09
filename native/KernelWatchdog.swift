import Foundation
import Darwin
// A tiny independent guardian survives SIGKILL of the bridge/helper. Birth IDs
// prevent PID reuse from killing unrelated processes. It never starts a proxy.
func runKernelWatchdogIfRequested() -> Bool {
    let args = CommandLine.arguments
    guard args.count > 1, args[1] == "--watch-kernel" else { return false }
    guard args.count == 8, let owner = Int32(args[2]), let kernel = Int32(args[4]),
          owner > 1, kernel > 1, processBirth(kernel) == args[5] else { return true }
    while processBirth(kernel) == args[5] {
        if processBirth(owner) != args[3] {
            kill(kernel, SIGTERM)
            let deadline = Date().addingTimeInterval(4)
            while processBirth(kernel) == args[5] && Date() < deadline { Thread.sleep(forTimeInterval: 0.05) }
            if processBirth(kernel) == args[5] { kill(kernel, SIGKILL) }
            if args[7] == "privileged", geteuid() == 0 {
                // Recover only the lease we watched. A successor helper may have
                // already installed a different generation of system settings.
                if let journal = try? OwnershipJournal(directory: URL(fileURLWithPath: args[6])),
                   journal.record.kernelPID == kernel, journal.record.kernelBirth == args[5] {
                    try? SystemProxyOwner(journal: journal).restore(expectedKernel: (kernel, args[5]))
                }
            }
            return true
        }
        Thread.sleep(forTimeInterval: 0.25)
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
