import Foundation
import Security
import Darwin
final class HelperSession: NSObject, FlowGateHelperProtocol {
    let engine: NetworkEngine
    let queue: DispatchQueue
    let lease: SessionLease
    let generation: UInt64
    var monitor: DispatchSourceTimer?
    init(engine: NetworkEngine, queue: DispatchQueue, lease: SessionLease, generation: UInt64) {
        self.engine = engine; self.queue=queue; self.lease=lease; self.generation=generation
        super.init()
        let timer=DispatchSource.makeTimerSource(queue:queue);timer.schedule(deadline:.now()+1,repeating:1)
        timer.setEventHandler { [weak self] in
            guard let self = self, self.lease.isActive(self.generation) else { return }
            self.engine.reconcile()
        };timer.resume();monitor=timer
    }
    func request(_ data: Data, reply: @escaping (Data) -> Void) { queue.async {
        guard self.lease.isActive(self.generation) else {
            let request = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            reply((try? JSONSerialization.data(withJSONObject: ["id": request?["id"] as? String ?? "", "error": "原生会话已结束"])) ?? Data())
            return
        }
        reply(self.engine.request(data))
    } }
    func cleanup(attempt: Int = 0, completed: @escaping () -> Void) {
        monitor?.cancel()
        queue.async {
            guard self.lease.beginCleanup(self.generation) else { return }
            do {
                if try self.lease.cleanup(self.generation, restore: { try self.engine.stop() }) { completed() }
            }
            catch {
                self.engine.lastError = "会话已结束，系统设置恢复待重试"
                if attempt < 3 { self.queue.asyncAfter(deadline: .now() + Double(attempt + 1)) { self.cleanup(attempt: attempt + 1, completed: completed) } }
            }
        }
    }
}
final class HelperDelegate: NSObject, NSXPCListenerDelegate {
    let engine: NetworkEngine
    var permittedUID: UInt32?
    var active: NSXPCConnection?
    let lease = SessionLease()
    let queue=DispatchQueue(label:"com.flowgate.helper.writer")
    init(engine: NetworkEngine) { self.engine = engine }
    func listener(_ listener: NSXPCListener, shouldAcceptNewConnection connection: NSXPCConnection) -> Bool {
        if let uid = permittedUID, connection.effectiveUserIdentifier != uid { return false }
        let session: HelperSession? = queue.sync {
            guard active == nil, let generation = lease.acquire() else { return nil }
            active = connection
            return HelperSession(engine: engine, queue: queue, lease: lease, generation: generation)
        }
        guard let session = session else { return false }
        connection.exportedInterface = NSXPCInterface(with: FlowGateHelperProtocol.self); connection.exportedObject = session
        connection.invalidationHandler = { [weak self, weak connection] in
            session.cleanup { if self?.active === connection { self?.active = nil } }
        }
        connection.interruptionHandler = { connection.invalidate() }
        connection.resume(); return true
    }
}
@main struct Helper {
    static func main() throws {
        if runKernelWatchdogIfRequested() { return }
        guard geteuid() == 0 else { exit(77) }
        let executable = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
        if CommandLine.arguments.count == 2, ["--local", "--local-recover"].contains(CommandLine.arguments[1]) {
            let trust = try LocalTrust.load()
            guard try codeHash(executable.path) == trust.helper else { exit(78) }
            let kernel = localTools.appendingPathComponent("sing-box")
            try rootOwned(kernel.path)
            guard try codeHash(kernel.path) == trust.kernel else { exit(78) }
            if FileManager.default.fileExists(atPath: localData.path) { try rootOwned(localData.path, directory: true) }
            else { try FileManager.default.createDirectory(at: localData, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700]) }
            let engine = try NetworkEngine(kernelPath: kernel.path, directory: localData, privileged: true)
            if CommandLine.arguments[1] == "--local-recover" { try engine.stop(); return }
            let delegate = HelperDelegate(engine: engine); delegate.permittedUID = trust.uid
            let listener = NSXPCListener(machServiceName: localService)
            listener.setConnectionCodeSigningRequirement(hashRequirement(trust.bridge))
            listener.delegate = delegate; listener.resume()
            withExtendedLifetime(delegate) { RunLoop.current.run() }
            return
        }
        let bundledKernel = executable.deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Resources/app/dist/sing-box")
        guard let team = signingTeam() else { exit(78) }
        let directory=URL(fileURLWithPath:"/Library/Application Support/FlowGate",isDirectory:true)
        try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
        let attributes=try FileManager.default.attributesOfItem(atPath:directory.path)
        guard (attributes[.ownerAccountID] as? NSNumber)?.intValue == 0,
              (attributes[.posixPermissions] as? NSNumber)?.intValue == 0o700,
              attributes[.type] as? FileAttributeType == .typeDirectory else { exit(79) }
        let kernel=directory.appendingPathComponent("sing-box")
        // Copy into root-owned storage before signature validation and execution, avoiding mutable bundle paths.
        try Data(contentsOf:bundledKernel).write(to:kernel,options:.atomic)
        try FileManager.default.setAttributes([.posixPermissions:0o700],ofItemAtPath:kernel.path)
        try verifySignedFile(kernel.path, identifier: "com.flowgate.kernel", team: team)
        let engine = try NetworkEngine(kernelPath: kernel.path, directory: directory, privileged: true)
        let delegate = HelperDelegate(engine: engine)
        let listener = NSXPCListener(machServiceName: "com.flowgate.helper"); listener.setConnectionCodeSigningRequirement(signingRequirement(identifier: "com.flowgate.bridge", team: team)); listener.delegate = delegate; listener.resume()
        withExtendedLifetime(delegate) { RunLoop.current.run() }
    }
}
