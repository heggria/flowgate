import Foundation
import Security
import Darwin
final class HelperSession: NSObject, FlowGateHelperProtocol {
    let engine: NetworkEngine
    let queue: DispatchQueue
    var monitor: DispatchSourceTimer?
    init(engine: NetworkEngine, queue: DispatchQueue) {
        self.engine = engine; self.queue=queue
        super.init()
        let timer=DispatchSource.makeTimerSource(queue:queue);timer.schedule(deadline:.now()+1,repeating:1)
        timer.setEventHandler { [weak self] in self?.engine.reconcile() };timer.resume();monitor=timer
    }
    func request(_ data: Data, reply: @escaping (Data) -> Void) { queue.async { reply(self.engine.request(data)) } }
    func cleanup(attempt: Int = 0) {
        monitor?.cancel()
        queue.async {
            do { try self.engine.stop() }
            catch {
                self.engine.lastError = "会话已结束，系统设置恢复待重试"
                if attempt < 3 { self.queue.asyncAfter(deadline: .now() + Double(attempt + 1)) { self.cleanup(attempt: attempt + 1) } }
            }
        }
    }
}
final class HelperDelegate: NSObject, NSXPCListenerDelegate {
    let engine: NetworkEngine
    var active: NSXPCConnection?
    let queue=DispatchQueue(label:"com.flowgate.helper.writer")
    init(engine: NetworkEngine) { self.engine = engine }
    func listener(_ listener: NSXPCListener, shouldAcceptNewConnection connection: NSXPCConnection) -> Bool {
        guard active == nil else { return false }
        let session = HelperSession(engine: engine, queue: queue)
        connection.exportedInterface = NSXPCInterface(with: FlowGateHelperProtocol.self); connection.exportedObject = session
        active = connection
        connection.invalidationHandler = { [weak self] in session.cleanup(); self?.active = nil }
        connection.interruptionHandler = { connection.invalidate() }
        connection.resume(); return true
    }
}
@main struct Helper {
    static func main() throws {
        if runKernelWatchdogIfRequested() { return }
        guard geteuid() == 0 else { exit(77) }
        let executable = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
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
