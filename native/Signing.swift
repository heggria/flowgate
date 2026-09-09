import Foundation
import Security
func signingTeam() -> String? {
    var own: SecCode?; var code: SecStaticCode?; var info: CFDictionary?
    guard SecCodeCopySelf([], &own) == errSecSuccess, let own = own,
          SecCodeCopyStaticCode(own, [], &code) == errSecSuccess, let code = code,
          SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
          let dictionary = info as? [String: Any], let team = dictionary[kSecCodeInfoTeamIdentifier as String] as? String,
          team.range(of: "^[A-Z0-9]{10}$", options: .regularExpression) != nil else { return nil }
    return team
}
func signingRequirement(identifier: String, team: String) -> String { "anchor apple generic and identifier \"\(identifier)\" and certificate leaf[subject.OU] = \"\(team)\"" }
func verifySignedFile(_ path: String, identifier: String, team: String) throws {
    var code: SecStaticCode?; var requirement: SecRequirement?
    guard SecStaticCodeCreateWithPath(URL(fileURLWithPath: path) as CFURL, [], &code) == errSecSuccess,
          SecRequirementCreateWithString(signingRequirement(identifier: identifier, team: team) as CFString, [], &requirement) == errSecSuccess,
          let code = code, let requirement = requirement,
          SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSStrictValidate), requirement) == errSecSuccess else { throw NSError(domain: "固定内核签名校验失败", code: 30) }
}
