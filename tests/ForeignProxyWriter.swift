import Foundation
import SystemConfiguration
import Darwin

// Real independent SCPreferences writer for the guarded disposable CI runner.
// It does not use FlowGate's ownership or recovery implementation.
@main struct ForeignProxyWriter {
    static func main() {
        do { try run() }
        catch { fputs("\((error as NSError).domain)\n", stderr); exit(1) }
    }
    static func run() throws {
        let env = ProcessInfo.processInfo.environment
        guard geteuid() == 0, env["FLOWGATE_PRIVILEGED_CI"] == "1",
              env["GITHUB_ACTIONS"] == "true", env["RUNNER_ENVIRONMENT"] == "github-hosted" else {
            throw NSError(domain: "Disposable privileged CI required", code: 1)
        }
        let args = CommandLine.arguments
        guard args.count >= 3, ["capture", "takeover", "verify", "restore"].contains(args[1]),
              let prefs = SCPreferencesCreate(nil, "FlowGate independent CI writer" as CFString, nil),
              SCPreferencesLock(prefs, true) else { throw NSError(domain: "Invalid proxy transaction", code: 2) }
        defer { SCPreferencesUnlock(prefs) }
        guard let services = SCNetworkServiceCopyAll(prefs) as? [SCNetworkService] else {
            throw NSError(domain: "No network services", code: 3)
        }
        var protocols = [String: SCNetworkProtocol]()
        for service in services where SCNetworkServiceGetEnabled(service) {
            if let id = SCNetworkServiceGetServiceID(service),
               let proto = SCNetworkServiceCopyProtocol(service, kSCNetworkProtocolTypeProxies) {
                protocols[id as String] = proto
            }
        }
        guard !protocols.isEmpty else { throw NSError(domain: "No proxy protocols", code: 4) }
        let file = URL(fileURLWithPath: args[2])
        if args[1] == "capture" {
            let values = protocols.mapValues { (SCNetworkProtocolGetConfiguration($0) as? [String: Any]) ?? [:] }
            try PropertyListSerialization.data(fromPropertyList: values, format: .binary, options: 0).write(to: file, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
            print("captured")
            return
        }
        guard let original = try PropertyListSerialization.propertyList(from: Data(contentsOf: file), format: nil) as? [String: [String: Any]],
              Set(original.keys) == Set(protocols.keys) else { throw NSError(domain: "Service set changed", code: 5) }
        let port = args.count == 4 ? Int(args[3]) : nil
        if ["takeover", "verify"].contains(args[1]) {
            guard let port = port, (1024...65535).contains(port) else { throw NSError(domain: "Invalid fixture port", code: 6) }
        }
        for (id, proto) in protocols {
            let current = (SCNetworkProtocolGetConfiguration(proto) as? [String: Any]) ?? [:]
            var value = args[1] == "takeover" ? current : original[id]!
            if args[1] != "restore" {
                value["HTTPEnable"] = 1; value["HTTPProxy"] = "127.0.0.1"; value["HTTPPort"] = port!
            }
            if args[1] == "verify" {
                guard NSDictionary(dictionary: current).isEqual(to: value) else {
                    throw NSError(domain: "Foreign HTTP or original unowned fields were overwritten", code: 7)
                }
            } else if !SCNetworkProtocolSetConfiguration(proto, value as CFDictionary) {
                throw NSError(domain: "Cannot write fixture proxy settings", code: 8)
            }
        }
        if args[1] != "verify" {
            guard SCPreferencesCommitChanges(prefs), SCPreferencesApplyChanges(prefs) else {
                throw NSError(domain: "Cannot apply fixture proxy settings", code: 9)
            }
        }
        print("ok")
    }
}
