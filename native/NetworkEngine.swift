import Foundation
import Darwin
final class NetworkEngine {
    let kernelPath: String
    let directory: URL
    let privileged: Bool
    let controlPort: Int
    let apiSecret=UUID().uuidString+UUID().uuidString
    let journal: OwnershipJournal
    let proxies: SystemProxyOwner
    var kernel: Process?
    var revision: Int?
    var operation: String?
    var mode = "manual"
    var lastError: String?
    init(kernelPath: String, directory: URL, privileged: Bool) throws {
        self.controlPort=try availableLoopbackPort()
        self.kernelPath = kernelPath; self.directory = directory; self.privileged = privileged
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        journal = try OwnershipJournal(directory: directory); proxies = SystemProxyOwner(journal: journal)
        if privileged {
            try proxies.restore()
            if let pid=journal.record.kernelPID, let birth=journal.record.kernelBirth, processBirth(pid)==birth {
                kill(pid,SIGTERM)
                let deadline=Date().addingTimeInterval(3)
                while processBirth(pid)==birth && Date()<deadline {Thread.sleep(forTimeInterval:0.02)}
                if processBirth(pid)==birth {kill(pid,SIGKILL)}
            }
            journal.record.kernelPID=nil;journal.record.kernelBirth=nil;try journal.persist()
        }
    }
    func reconcile() {
        if let p=kernel, !p.isRunning, revision != nil {
            if privileged {do {try proxies.restore()}catch {lastError="内核已退出，系统配置恢复待重试";return}}
            kernel=nil;revision=nil;lastError="内核意外退出，已恢复本应用拥有的设置"
        }
    }
    func state() -> [String: Any] {
        reconcile()
        var value: [String: Any] = ["status": kernel?.isRunning == true ? "running" : lastError == nil ? "stopped" : "failed", "systemControl": privileged, "version": "1.14.0"]
        if let process = kernel, process.isRunning { value["pid"] = process.processIdentifier; value["appliedRevision"] = revision }
        value["operationId"] = operation
        value["systemProxyOwned"] = privileged && mode == "system" && kernel?.isRunning == true && proxies.isCurrentOwner(operationId: operation ?? "")
        value["message"] = lastError ?? (privileged ? "系统辅助服务已连接" : "手动代理可用；系统代理与 TUN 需要批准特权辅助服务")
        return value
    }
    func stop() throws {
        // Undo global settings while the owned endpoint still exists.
        if privileged { try proxies.restore() }
        if let p = kernel, p.isRunning {
            p.terminate(); let deadline = Date().addingTimeInterval(4)
            while p.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.02) }
            if p.isRunning { kill(p.processIdentifier, SIGKILL); p.waitUntilExit() }
        }
        kernel = nil; revision = nil; lastError = nil
        journal.record.phase = "stopped"; journal.record.kernelPID = nil; journal.record.kernelBirth=nil; try journal.persist()
    }
    func validate(_ config: [String: Any], mode: String) throws {
        guard Set(config.keys).isSubset(of: ["log", "dns", "inbounds", "outbounds", "route"]),
              let inbounds = config["inbounds"] as? [[String: Any]], inbounds.count == 1,
              let outbounds = config["outbounds"] as? [[String: Any]], outbounds.count <= 5002 else { throw NSError(domain: "原生配置结构无效", code: 20) }
        let inbound = inbounds[0]
        if mode == "tun" { guard privileged, inbound["type"] as? String == "tun" else { throw NSError(domain: "TUN 需要特权辅助服务", code: 21) } }
        else { guard inbound["type"] as? String == "mixed", inbound["listen"] as? String == "127.0.0.1", let port = inbound["listen_port"] as? Int, (1024...65535).contains(port) else { throw NSError(domain: "只能监听本机非特权端口", code: 22) } }
        func checkKeys(_ object: Any) throws {
            if let map = object as? [String: Any] {
                for (key, value) in map {
                    if key.hasSuffix("_path") || ["output", "cache_file", "execute", "script", "certificate_provider"].contains(key) { throw NSError(domain: "配置包含禁止的文件或执行能力", code: 23) }
                    try checkKeys(value)
                }
            } else if let array = object as? [Any] { for value in array { try checkKeys(value) } }
        }
        try checkKeys(config)
    }
    func apply(_ payload: [String: Any]) throws {
        guard let config = payload["config"] as? [String: Any], let rev = payload["revision"] as? Int, let op = payload["operationId"] as? String else { throw NSError(domain: "无效原生请求", code: 24) }
        let mode = payload["mode"] as? String ?? "manual"
        guard ["manual", "system", "tun"].contains(mode), mode == "manual" || privileged else { throw NSError(domain: "请先安装并批准系统辅助服务", code: 25) }
        if operation == op && kernel?.isRunning == true { return }
        try validate(config, mode: mode)
        guard FileManager.default.isExecutableFile(atPath: kernelPath) else { throw NSError(domain: "未找到已验证的 sing-box 内核", code: 26) }
        var effective=config
        effective["services"]=[["type":"api","listen":"127.0.0.1","listen_port":controlPort,"secret":apiSecret,"dashboard":false,"access_control_allow_origin":["flowgate://local"]]]
        let candidate = directory.appendingPathComponent("candidate.json")
        try JSONSerialization.data(withJSONObject: effective).write(to: candidate, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: candidate.path)
        _ = try command(kernelPath, ["check", "-c", candidate.path], timeout: 8)
        let active = directory.appendingPathComponent("active.json")
        let previous = try? Data(contentsOf: active)
        let oldRevision = revision; let oldMode=self.mode; let oldOperation=operation; let hadKernel = kernel?.isRunning == true
        try stop()
        do {
            try Data(contentsOf: candidate).write(to: active, options: .atomic)
            try launch(active); revision = rev; operation = op; self.mode=mode; lastError = nil
            if mode == "system", let inbounds = config["inbounds"] as? [[String: Any]], let port = inbounds.first?["listen_port"] as? Int { try proxies.apply(port: port, operationId: op) }
            journal.record.phase = "running"; journal.record.operationId = op; journal.record.kernelPID = kernel?.processIdentifier; journal.record.kernelBirth=kernel.map {processBirth($0.processIdentifier)} ?? nil; try journal.persist()
        } catch {
            try? stop()
            if hadKernel, let previous = previous { try previous.write(to: active, options: .atomic); try launch(active); revision = oldRevision; self.mode=oldMode;operation=oldOperation
                if oldMode=="system",let previousConfig=try JSONSerialization.jsonObject(with:previous) as? [String:Any],let inbounds=previousConfig["inbounds"] as? [[String:Any]],let port=inbounds.first?["listen_port"] as? Int {try proxies.apply(port:port,operationId:oldOperation ?? "rollback")}
            }
            lastError = "新配置应用失败；已尝试保留之前的内核配置"
            throw error
        }
    }
    private func launch(_ path: URL) throws {
        let process = Process(); process.executableURL = URL(fileURLWithPath: kernelPath); process.arguments = ["run", "-c", path.path]
        process.standardInput = FileHandle.nullDevice; process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.nullDevice
        try process.run(); kernel = process;
        do { try startKernelWatchdog(kernel: process.processIdentifier, directory: directory, privileged: privileged) } catch { process.terminate(); throw error }; journal.record.kernelPID=process.processIdentifier;journal.record.kernelBirth=processBirth(process.processIdentifier);try journal.persist();Thread.sleep(forTimeInterval: 0.25)
        guard process.isRunning else { throw NSError(domain: "内核启动失败，可能监听端口冲突", code: 27) }
    }
    func request(_ data: Data) -> Data {
        var id = ""
        do {
            guard data.count <= 8 * 1024 * 1024, let request = try JSONSerialization.jsonObject(with: data) as? [String: Any], let requestId = request["id"] as? String, let method = request["method"] as? String else { throw NSError(domain: "无效请求", code: 28) }
            id = requestId
            if method=="control" {
                let control:Any=kernel?.isRunning==true ? ["endpoint":"127.0.0.1:\(controlPort)","secret":apiSecret] : NSNull()
                return try JSONSerialization.data(withJSONObject:["id":id,"result":control])
            }
            switch method { case "status": break; case "apply": try apply(request["payload"] as? [String: Any] ?? [:]); case "stop": try stop();operation=(request["payload"] as? [String:Any])?["operationId"] as? String; default: throw NSError(domain: "不支持的原生操作", code: 29) }
            return try JSONSerialization.data(withJSONObject: ["id": id, "result": state()])
        } catch { return try! JSONSerialization.data(withJSONObject: ["id": id, "error": (error as NSError).domain]) }
    }
}
