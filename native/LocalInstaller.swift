import Foundation
import CryptoKit
import Darwin

// This executable is launched only by an explicit administrator authorization.
// All privileged destinations are fixed; approved source bytes are hashed before
// authorization, copied once, then checked again inside root-owned staging.
@main struct LocalInstaller {
    static func main() {
        do { try run(); print("ok") }
        catch { fputs("\((error as NSError).domain)\n", stderr); exit(1) }
    }
    static func run() throws {
        guard geteuid() == 0 else { throw NSError(domain: "需要 macOS 管理员授权", code: 70) }
        umask(0o077)
        let args = CommandLine.arguments
        guard args.count >= 2, ["install", "uninstall"].contains(args[1]) else { throw NSError(domain: "无效安装操作", code: 71) }
        let fm = FileManager.default
        // Reject symlinked or user-writable parents before touching root state.
        for parent in ["/Library", "/Library/PrivilegedHelperTools", "/Library/LaunchDaemons", "/Library/Application Support"] {
            if !fm.fileExists(atPath: parent) { try fm.createDirectory(atPath: parent, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o755]) }
            try rootOwned(parent, directory: true)
        }
        // Serialize administrators across multiple application versions/processes.
        // Keep this empty lock inode stable even after uninstall (unlinking a
        // locked inode could allow another installer to lock a different inode).
        let lock = open("/Library/PrivilegedHelperTools/.flowgate-local.lock", O_RDWR | O_CREAT | O_NOFOLLOW, 0o600)
        guard lock >= 0 else { throw NSError(domain: "无法取得辅助服务维护锁", code: 76) }
        defer { close(lock) }
        var lockInfo = stat()
        guard fstat(lock, &lockInfo) == 0, lockInfo.st_uid == 0,
              lockInfo.st_mode & S_IFMT == S_IFREG, lockInfo.st_mode & 0o077 == 0,
              flock(lock, LOCK_EX | LOCK_NB) == 0 else {
            throw NSError(domain: "辅助服务正在由另一个安装程序维护，或维护锁权限无效", code: 77)
        }
        if fm.fileExists(atPath: localPlist) { try rootOwned(localPlist) }
        if fm.fileExists(atPath: localData.path) { try rootOwned(localData.path, directory: true) }
        if fm.fileExists(atPath: localTools.path) {
            let old = try LocalTrust.load()
            let helper = localTools.appendingPathComponent("flowgate-helper").path
            try rootOwned(helper)
            guard try codeHash(helper) == old.helper else { throw NSError(domain: "已安装辅助服务校验失败，停止操作", code: 72) }
        }
        if args[1] == "uninstall" {
            guard args.count == 2 else { throw NSError(domain: "无效卸载参数", code: 73) }
            try unloadAndRecover()
            if fm.fileExists(atPath: localPlist) { try rootOwned(localPlist); try fm.removeItem(atPath: localPlist) }
            if fm.fileExists(atPath: localTools.path) { try fm.removeItem(at: localTools) }
            // Recovery journal is deliberately kept until successful recovery.
            if fm.fileExists(atPath: localData.path) { try fm.removeItem(at: localData) }
            return
        }
        guard args.count == 7, let uid = UInt32(args[3]), uid >= 501,
              args[4...6].allSatisfy({ $0.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil }) else {
            throw NSError(domain: "无效安装参数", code: 74)
        }
        let stage = localTools.deletingLastPathComponent().appendingPathComponent(".flowgate-" + UUID().uuidString)
        try fm.createDirectory(at: stage, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o755])
        defer { try? fm.removeItem(at: stage) }
        let names = ["flowgate-bridge", "flowgate-helper", "sing-box"]
        var hashes = [String]()
        for (index, name) in names.enumerated() {
            let bytes = try Data(contentsOf: URL(fileURLWithPath: args[2]).appendingPathComponent(name))
            let digest = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
            guard digest == args[4 + index] else { throw NSError(domain: "授权期间程序发生变化，请重新安装", code: 75) }
            let target = stage.appendingPathComponent(name)
            try bytes.write(to: target, options: .atomic)
            try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: target.path)
            hashes.append(try codeHash(target.path))
        }
        let trust = LocalTrust(version: 1, uid: uid, bridge: hashes[0], helper: hashes[1], kernel: hashes[2])
        let trustPath = stage.appendingPathComponent("trust.json")
        try JSONEncoder().encode(trust).write(to: trustPath)
        try fm.setAttributes([.posixPermissions: 0o644], ofItemAtPath: trustPath.path)
        let backup = localTools.deletingLastPathComponent().appendingPathComponent(".flowgate-backup-" + UUID().uuidString)
        let previousPlist = try? Data(contentsOf: URL(fileURLWithPath: localPlist))
        try unloadAndRecover()
        let hadPrevious = fm.fileExists(atPath: localTools.path)
        if hadPrevious { try fm.moveItem(at: localTools, to: backup) }
        do {
            try fm.moveItem(at: stage, to: localTools)
            let plist: [String: Any] = ["Label": localService,
                "ProgramArguments": [localTools.appendingPathComponent("flowgate-helper").path, "--local"],
                "MachServices": [localService: true], "RunAtLoad": true,
                "ProcessType": "Interactive", "ExitTimeOut": 10]
            try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0).write(to: URL(fileURLWithPath: localPlist), options: .atomic)
            try fm.setAttributes([.posixPermissions: 0o644], ofItemAtPath: localPlist)
            _ = try command("/bin/launchctl", ["bootstrap", "system", localPlist], timeout: 15)
            if hadPrevious { try fm.removeItem(at: backup) }
        } catch {
            try? fm.removeItem(at: localTools)
            if hadPrevious { try? fm.moveItem(at: backup, to: localTools) }
            if let previousPlist = previousPlist {
                try? previousPlist.write(to: URL(fileURLWithPath: localPlist), options: .atomic)
                try? fm.setAttributes([.posixPermissions: 0o644], ofItemAtPath: localPlist)
                _ = try? command("/bin/launchctl", ["bootstrap", "system", localPlist])
            } else { try? fm.removeItem(atPath: localPlist) }
            throw error
        }
    }
    static func unloadAndRecover() throws {
        if (try? command("/bin/launchctl", ["print", "system/" + localService])) != nil {
            _ = try command("/bin/launchctl", ["bootout", "system/" + localService], timeout: 20)
        }
        if FileManager.default.fileExists(atPath: localTools.path) {
            _ = try command(localTools.appendingPathComponent("flowgate-helper").path, ["--local-recover"], timeout: 20)
        }
    }
}
