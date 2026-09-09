import Foundation
import Darwin
import SystemConfiguration
struct ProxyChange: Codable { let service: String; let keys: [String]; let before: Data; let applied: Data }
struct RecoveryRecord: Codable { var phase: String; var changes: [ProxyChange]; var operationId: String; var kernelPID: Int32?; var kernelBirth: String? }
final class OwnershipJournal {
    let path: URL
    var record = RecoveryRecord(phase: "idle", changes: [], operationId: "")
    init(directory: URL) throws {
        path = directory.appendingPathComponent("ownership.json")
        if FileManager.default.fileExists(atPath: path.path) { record = try JSONDecoder().decode(RecoveryRecord.self, from: Data(contentsOf: path)) }
    }
    func persist() throws {
        try JSONEncoder().encode(record).write(to: path, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path.path)
        let fd = open(path.path, O_RDONLY); if fd >= 0 { fsync(fd); close(fd) }
        let dir = open(path.deletingLastPathComponent().path, O_RDONLY); if dir >= 0 { fsync(dir); close(dir) }
    }
}
func command(_ executable: String, _ arguments: [String], timeout: TimeInterval = 5) throws -> String {
    let process = Process(); process.executableURL = URL(fileURLWithPath: executable); process.arguments = arguments
    let output = Pipe(); process.standardOutput = output; process.standardError = FileHandle.nullDevice; process.standardInput = FileHandle.nullDevice
    // networksetup replies are bounded. Kernel checks discard all output separately.
    try process.run(); let deadline = Date().addingTimeInterval(timeout)
    while process.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.01) }
    if process.isRunning { process.terminate(); Thread.sleep(forTimeInterval: 0.1); if process.isRunning { kill(process.processIdentifier, SIGKILL) }; process.waitUntilExit(); throw NSError(domain: "系统操作超时，需核实当前状态", code: 10) }
    let data = output.fileHandleForReading.readDataToEndOfFile()
    guard process.terminationStatus == 0, data.count < 1_000_000 else { throw NSError(domain: "系统命令执行失败", code: 11) }
    return String(data: data, encoding: .utf8) ?? ""
}
protocol ProxyTransaction {
    func services() throws -> [String]
    func read(_ id: String) throws -> [String: Any]
    func write(_ id: String, _ config: [String: Any]) throws
    func commit() throws
    func unlock()
}
protocol ProxyBackend { func begin() throws -> ProxyTransaction }
struct MacProxyBackend: ProxyBackend {
    func begin() throws -> ProxyTransaction { try MacProxyTransaction() }
}
final class MacProxyTransaction: ProxyTransaction {
    let prefs: SCPreferences
    init() throws {
        guard let value = SCPreferencesCreate(nil, "FlowGate" as CFString, nil), SCPreferencesLock(value, false) else { throw NSError(domain: "系统网络配置繁忙，需重试", code: 15) }
        prefs = value
    }
    func unlock() { SCPreferencesUnlock(prefs) }
    func services() throws -> [String] {
        guard let values = SCNetworkServiceCopyAll(prefs) as? [SCNetworkService] else { throw NSError(domain: "无可用网络服务", code: 16) }
        return values.compactMap { service in
            guard SCNetworkServiceGetEnabled(service), SCNetworkServiceCopyProtocol(service, kSCNetworkProtocolTypeProxies) != nil, let id = SCNetworkServiceGetServiceID(service) else { return nil }
            return id as String
        }
    }
    func read(_ id: String) throws -> [String: Any] {
        guard let service = SCNetworkServiceCopy(prefs, id as CFString), let proto = SCNetworkServiceCopyProtocol(service, kSCNetworkProtocolTypeProxies) else { throw NSError(domain: "网络服务已不可用", code: 13) }
        return (SCNetworkProtocolGetConfiguration(proto) as? [String: Any]) ?? [:]
    }
    func write(_ id: String, _ config: [String: Any]) throws {
        guard let service = SCNetworkServiceCopy(prefs, id as CFString), let proto = SCNetworkServiceCopyProtocol(service, kSCNetworkProtocolTypeProxies), SCNetworkProtocolSetConfiguration(proto, config as CFDictionary) else { throw NSError(domain: "无法写入网络代理配置", code: 14) }
    }
    func commit() throws { guard SCPreferencesCommitChanges(prefs), SCPreferencesApplyChanges(prefs) else { throw NSError(domain: "系统代理提交未完成，需恢复核实", code: 19) } }
}
final class SystemProxyOwner {
    let journal: OwnershipJournal
    let backend: ProxyBackend
    let groups = [["HTTPEnable", "HTTPProxy", "HTTPPort"], ["HTTPSEnable", "HTTPSProxy", "HTTPSPort"], ["SOCKSEnable", "SOCKSProxy", "SOCKSPort"]]
    init(journal: OwnershipJournal, backend: ProxyBackend = MacProxyBackend()) { self.journal = journal; self.backend = backend }
    func fields(_ value: [String: Any], _ keys: [String]) -> [String: Any] { value.filter { keys.contains($0.key) } }
    func apply(port: Int, operationId: String) throws {
        let prefs = try backend.begin()
        defer { prefs.unlock() }
        let services = try prefs.services()
        var changes = [ProxyChange]()
        for id in services {
            let before = try prefs.read(id)
            if ["HTTPEnable", "HTTPSEnable", "SOCKSEnable", "ProxyAutoConfigEnable", "ProxyAutoDiscoveryEnable"].contains(where: { (before[$0] as? NSNumber)?.boolValue == true }) { throw NSError(domain: "检测到外部系统代理或 PAC；保留现有设置", code: 17) }
            for keys in groups {
                let after: [String: Any] = [keys[0]: 1, keys[1]: "127.0.0.1", keys[2]: port]
                changes.append(ProxyChange(service: id, keys: keys, before: try JSONSerialization.data(withJSONObject: fields(before, keys)), applied: try JSONSerialization.data(withJSONObject: after)))
            }
        }
        guard !changes.isEmpty else { throw NSError(domain: "没有可设置代理的网络服务", code: 18) }
        journal.record = RecoveryRecord(phase: "applying", changes: changes, operationId: operationId); try journal.persist()
        for change in changes { var current = try prefs.read(change.service); let applied = try JSONSerialization.jsonObject(with: change.applied) as! [String: Any]; current.merge(applied) { _, new in new }; try prefs.write(change.service, current) }
        try prefs.commit()
        journal.record.phase = "applied"; try journal.persist()
    }
    func restore(expectedKernel: (Int32, String)? = nil) throws {
        if journal.record.changes.isEmpty { return }
        let prefs = try backend.begin()
        defer { prefs.unlock() }
        if let expected = expectedKernel {
            let latest = try JSONDecoder().decode(RecoveryRecord.self, from: Data(contentsOf: journal.path))
            guard latest.kernelPID == expected.0, latest.kernelBirth == expected.1 else { return }
            journal.record = latest
        }
        var unresolved = [ProxyChange]()
        for change in journal.record.changes.reversed() {
            do {
                var current = try prefs.read(change.service)
                let applied = try JSONSerialization.jsonObject(with: change.applied) as! [String: Any]
                if NSDictionary(dictionary: fields(current, change.keys)).isEqual(to: applied) {
                    let before = try JSONSerialization.jsonObject(with: change.before) as! [String: Any]
                    for key in change.keys { current.removeValue(forKey: key) }
                    current.merge(before) { _, restored in restored }; try prefs.write(change.service, current)
                }
            } catch { unresolved.append(change) }
        }
        try prefs.commit()
        journal.record.changes = unresolved; journal.record.phase = unresolved.isEmpty ? "restored" : "recovery-pending"; try journal.persist()
        if !unresolved.isEmpty { throw NSError(domain: "部分代理设置尚未恢复，请重试", code: 33) }
    }
}
