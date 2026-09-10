import Foundation
import Security
import Darwin

let localService = "com.flowgate.local.helper"
let localTools = URL(fileURLWithPath: "/Library/PrivilegedHelperTools/com.flowgate.local", isDirectory: true)
let localData = URL(fileURLWithPath: "/Library/Application Support/FlowGateLocal", isDirectory: true)
let localPlist = "/Library/LaunchDaemons/com.flowgate.local.helper.plist"

struct LocalTrust: Codable {
    let version: Int
    let uid: UInt32
    let bridge: String
    let helper: String
    let kernel: String
    static func load() throws -> LocalTrust {
        try rootOwned(localTools.path, directory: true)
        let path = localTools.appendingPathComponent("trust.json")
        try rootOwned(path.path)
        let trust = try JSONDecoder().decode(LocalTrust.self, from: Data(contentsOf: path))
        guard trust.version == 1, trust.uid >= 501,
              [trust.bridge, trust.helper, trust.kernel].allSatisfy({ $0.range(of: "^[a-f0-9]{40}$", options: .regularExpression) != nil }) else {
            throw NSError(domain: "本机辅助服务授权记录无效", code: 60)
        }
        return trust
    }
}

func rootOwned(_ path: String, directory: Bool = false) throws {
    var metadata = stat()
    guard lstat(path, &metadata) == 0, metadata.st_uid == 0,
          metadata.st_mode & 0o022 == 0,
          metadata.st_mode & S_IFMT == (directory ? S_IFDIR : S_IFREG) else {
        throw NSError(domain: "辅助服务文件所有权或权限无效", code: 61)
    }
}

func codeHash(_ path: String) throws -> String {
    var code: SecStaticCode?; var information: CFDictionary?
    guard SecStaticCodeCreateWithPath(URL(fileURLWithPath: path) as CFURL, [], &code) == errSecSuccess,
          let code = code,
          SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSStrictValidate), nil) == errSecSuccess,
          SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &information) == errSecSuccess,
          let dictionary = information as? [String: Any],
          let hash = dictionary[kSecCodeInfoUnique as String] as? Data, hash.count == 20 else {
        throw NSError(domain: "程序签名损坏，请重新构建后安装", code: 62)
    }
    return hash.map { String(format: "%02x", $0) }.joined()
}

func hashRequirement(_ hash: String) -> String { "cdhash H\"\(hash)\"" }

func localInstallationInfo() -> [String: Any] {
    guard FileManager.default.fileExists(atPath: localTools.path) else {
        return ["installed": false, "compatible": false, "message": "免费本机使用：安装时需要一次管理员授权。"]
    }
    do {
        let trust = try LocalTrust.load()
        let compatible = try trust.uid == getuid() && codeHash(CommandLine.arguments[0]) == trust.bridge
        return ["installed": true, "compatible": compatible,
                "message": compatible ? "本机辅助服务已安装，可免费使用系统代理与 TUN。" : "辅助服务与当前用户或版本不一致，请更新授权。"]
    } catch { return ["installed": true, "compatible": false, "message": "辅助服务授权记录损坏，请重新安装。"] }
}
