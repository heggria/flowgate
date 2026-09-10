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
    var tunInterface: String?
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
        if kernel?.isRunning == true { value["tunInterface"] = tunInterface }
        value["systemProxyOwned"] = privileged && mode == "system" && kernel?.isRunning == true && proxies.isCurrentOwner(operationId: operation ?? "") && proxies.isEffective()
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
        kernel = nil; revision = nil; lastError = nil; tunInterface = nil
        journal.record.phase = "stopped"; journal.record.kernelPID = nil; journal.record.kernelBirth=nil; try journal.persist()
    }
    func validate(_ config: [String: Any], mode: String) throws {
        guard Set(config.keys).isSubset(of: ["log", "dns", "inbounds", "outbounds", "route"]),
              let inbounds = config["inbounds"] as? [[String: Any]], inbounds.count == 1,
              let outbounds = config["outbounds"] as? [[String: Any]], outbounds.count <= 5202 else { throw NSError(domain: "原生配置结构无效", code: 20) }
        let inbound = inbounds[0]
        if mode == "tun" { guard privileged, inbound["type"] as? String == "tun" else { throw NSError(domain: "TUN 需要特权辅助服务", code: 21) } }
        else { guard inbound["type"] as? String == "mixed", inbound["listen"] as? String == "127.0.0.1", let port = inbound["listen_port"] as? Int, (1024...65535).contains(port) else { throw NSError(domain: "只能监听本机非特权端口", code: 22) } }
        func checkKeys(_ object: Any, context: String = "") throws {
            if let map = object as? [String: Any] {
                for (key, value) in map {
                    if key.hasSuffix("_path") || ["output", "cache_file", "execute", "script", "certificate_provider"].contains(key) { throw NSError(domain: "配置包含禁止的文件或执行能力", code: 23) }
                    if key == "path" {
                        let transportURL = context.hasSuffix(".transport") && ["ws", "http", "httpupgrade"].contains(map["type"] as? String ?? "")
                        let dnsURL = context == "dns.servers[]" && map["type"] as? String == "https"
                        guard transportURL || dnsURL else { throw NSError(domain: "配置不允许读取本机文件", code: 23) }
                    }
                    try checkKeys(value, context: context.isEmpty ? key : context + "." + key)
                }
            } else if let array = object as? [Any] { for value in array { try checkKeys(value, context: context + "[]") } }
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
        if mode == "tun" {
            var head: UnsafeMutablePointer<ifaddrs>?
            guard getifaddrs(&head) == 0 else { throw NSError(domain:"无法检查现有接口",code:30) }
            defer { freeifaddrs(head) }
            var names=Set<String>();var cursor=head
            while let item=cursor {names.insert(String(cString:item.pointee.ifa_name));cursor=item.pointee.ifa_next}
            let name = (kernel?.isRunning == true ? tunInterface : nil) ?? (100...999).map {"utun\($0)"}.first {!names.contains($0)}
            guard let name=name else {throw NSError(domain:"没有可用的 TUN 接口",code:31)}
            var inbounds=effective["inbounds"] as! [[String:Any]]
            inbounds[0]["interface_name"]=name;effective["inbounds"]=inbounds
        }
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
            if mode == "system", let inbounds = config["inbounds"] as? [[String: Any]], let port = inbounds.first?["listen_port"] as? Int {
                try proxies.apply(port: port, operationId: op)
                let deadline = Date().addingTimeInterval(2)
                while !proxies.isEffective() && Date() < deadline { Thread.sleep(forTimeInterval: 0.05) }
                guard proxies.isEffective() else { throw NSError(domain: "系统代理未实际生效，已尝试恢复；请检查当前 VPN 或其他网络工具", code: 40) }
            }
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
        let launched = try JSONSerialization.jsonObject(with: Data(contentsOf:path)) as? [String:Any]
        let inbound = (launched?["inbounds"] as? [[String:Any]])?.first
        tunInterface = inbound?["type"] as? String == "tun" ? inbound?["interface_name"] as? String : nil
        do { try startKernelWatchdog(kernel: process.processIdentifier, directory: directory, privileged: privileged) } catch { process.terminate(); throw error }
        journal.record.kernelPID=process.processIdentifier;journal.record.kernelBirth=processBirth(process.processIdentifier);try journal.persist()
        // A live process can still be starting. Do not publish an applied revision
        // or change system proxy settings until the local listeners are ready.
        var ports = [controlPort]
        if inbound?["type"] as? String == "mixed", let port = inbound?["listen_port"] as? Int { ports.append(port) }
        let deadline = ProcessInfo.processInfo.systemUptime + 3
        while process.isRunning && ProcessInfo.processInfo.systemUptime < deadline {
            if ports.allSatisfy(loopbackListenerReady) { return }
            Thread.sleep(forTimeInterval: 0.025)
        }
        throw NSError(domain: process.isRunning ? "内核启动超时，本地监听尚未就绪" : "内核启动失败，可能监听端口冲突", code: 27)
    }
    private func loopbackListenerReady(_ port: Int) -> Bool {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }
        defer { Darwin.close(fd) }
        guard fcntl(fd, F_SETFL, O_NONBLOCK) == 0 else { return false }
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        address.sin_port = UInt16(port).bigEndian
        let result = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        if result == 0 { return true }
        guard errno == EINPROGRESS else { return false }
        var event = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
        guard poll(&event, 1, 25) > 0 else { return false }
        var error: Int32 = 0
        var length = socklen_t(MemoryLayout<Int32>.size)
        return getsockopt(fd, SOL_SOCKET, SO_ERROR, &error, &length) == 0 && error == 0
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
