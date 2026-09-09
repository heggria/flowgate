import Foundation
final class FixturePreferences: ProxyBackend, ProxyTransaction {
    var values: [String: [String: Any]] = ["wifi": ["ExceptionsList": ["*.local"]]]
    var failCommit = false
    var locked = false
    func begin() throws -> ProxyTransaction { precondition(!locked); locked = true; return self }
    func unlock() { locked = false }
    func services() throws -> [String] { Array(values.keys) }
    func read(_ id: String) throws -> [String: Any] { guard let value = values[id] else { throw NSError(domain: "missing", code: 1) }; return value }
    func write(_ id: String, _ value: [String: Any]) throws { values[id] = value }
    func commit() throws { if failCommit { throw NSError(domain: "commit failed", code: 1) } }
}
@main struct OwnershipTests {
    static func main() throws {
        let directory = URL(fileURLWithPath: CommandLine.arguments[1]); try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let backend = FixturePreferences(); let journal = try OwnershipJournal(directory: directory)
        let owner = SystemProxyOwner(journal: journal, backend: backend)
        backend.values["wifi"]?["ProxyAutoConfigEnable"] = 1
        do { try owner.apply(port: 17890, operationId: "pac"); fatalError("PAC overwritten") } catch { }
        precondition(journal.record.changes.isEmpty)
        backend.values["wifi"]?["ProxyAutoConfigEnable"] = 0
        try owner.apply(port: 17890, operationId: "owned")
        // Another application changes just one member of the HTTP group.
        backend.values["wifi"]?["HTTPPort"] = 9999
        backend.failCommit = true
        do { try owner.restore(); fatalError("failure ignored") } catch { }
        precondition(!journal.record.changes.isEmpty && !backend.locked)
        backend.failCommit = false
        let recovered = try OwnershipJournal(directory: directory)
        try SystemProxyOwner(journal: recovered, backend: backend).restore()
        precondition(backend.values["wifi"]?["HTTPPort"] as? Int == 9999)
        precondition(backend.values["wifi"]?["HTTPProxy"] as? String == "127.0.0.1")
        precondition(backend.values["wifi"]?["HTTPSProxy"] == nil && backend.values["wifi"]?["SOCKSProxy"] == nil)
        precondition(backend.values["wifi"]?["ExceptionsList"] as? [String] == ["*.local"])
        precondition(recovered.record.changes.isEmpty)
        backend.values["wifi"] = [:]
        try SystemProxyOwner(journal: recovered, backend: backend).apply(port: 17890, operationId: "missing-service")
        let applied = backend.values.removeValue(forKey: "wifi")!
        do { try SystemProxyOwner(journal: recovered, backend: backend).restore(); fatalError("missing service ignored") } catch { }
        precondition(recovered.record.phase == "recovery-pending")
        backend.values["wifi"] = applied
        try SystemProxyOwner(journal: recovered, backend: backend).restore()
        precondition(recovered.record.phase == "restored" && backend.values["wifi"]!.isEmpty)
        print("PASS: ownership/PAC/foreign mutation/commit retry/missing service with injected preferences")
    }
}
