import Foundation
import ServiceManagement
import Darwin
@main struct Bridge {
    static func main() throws {
        if runKernelWatchdogIfRequested() { return }
        let arguments = CommandLine.arguments
        guard arguments.count == 3 else { exit(64) }
        let engine = try NetworkEngine(kernelPath: arguments[1], directory: URL(fileURLWithPath: arguments[2], isDirectory: true), privileged: false)
        var connection: NSXPCConnection?
        var helperEstablished = false
        func helperRequest(_ data: Data) -> Data? {
            guard let team = signingTeam() else { return nil }
            if connection == nil {
                let client = NSXPCConnection(machServiceName: "com.flowgate.helper", options: .privileged)
                client.setCodeSigningRequirement(signingRequirement(identifier: "com.flowgate.helper", team: team))
                client.remoteObjectInterface = NSXPCInterface(with: FlowGateHelperProtocol.self)
                client.resume(); connection = client
            }
            let semaphore = DispatchSemaphore(value: 0)
            var response: Data?
            let proxy = connection?.remoteObjectProxyWithErrorHandler { _ in semaphore.signal() } as? FlowGateHelperProtocol
            proxy?.request(data) { result in response = result; semaphore.signal() }
            if semaphore.wait(timeout: .now() + 12) == .timedOut || response == nil { connection?.invalidate(); connection = nil; return nil }
            return response
        }
        defer { connection?.invalidate(); try? engine.stop() }
        while let line = readLine() {
            guard let data = line.data(using: .utf8) else { continue }
            var response: Data
            let request = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            let method = request?["method"] as? String
            if method == "helper.install" {
                do { try SMAppService.daemon(plistName: "com.flowgate.helper.plist").register(); response = try JSONSerialization.data(withJSONObject: ["id": request?["id"] ?? "", "result": engine.state()]) }
                catch { response = try! JSONSerialization.data(withJSONObject: ["id": request?["id"] ?? "", "error": "辅助服务注册需要已签名应用及系统设置批准：\(error.localizedDescription)"]) }
            } else if let remote = helperRequest(data) { helperEstablished = true; response = remote }
            else if helperEstablished {
                response = try! JSONSerialization.data(withJSONObject: ["id": request?["id"] ?? "", "error": "辅助服务会话失联，系统状态未知；暂停写入并等待恢复"])
            }
            else if let mode = (request?["payload"] as? [String: Any])?["mode"] as? String, mode != "manual" {
                response = try! JSONSerialization.data(withJSONObject: ["id": request?["id"] ?? "", "error": "特权辅助服务不可用，系统写入未执行"])
            } else { response = engine.request(data) }
            if let text = String(data: response, encoding: .utf8) { print(text); fflush(stdout) }
        }
    }
}
