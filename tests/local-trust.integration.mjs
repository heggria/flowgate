import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
const directory = mkdtempSync(resolve("work/local-trust-"));
try {
  const source = join(directory, "Check.swift");
  writeFileSync(
    source,
    `import Foundation
@main struct Check {
 static func main() throws {
  let hash = try codeHash("/usr/bin/true")
  precondition(hash.count == 40)
  try rootOwned("/usr/bin/true")
  var rejected = false
  do { try rootOwned(CommandLine.arguments[1]) } catch { rejected = true }
  precondition(rejected, "user-controlled code cannot be root trust")
  let bytes = try Data(contentsOf: URL(fileURLWithPath: "/usr/bin/true"))
  var altered = bytes; altered[0] ^= 1
  let path = CommandLine.arguments[1] + "/altered"
  try altered.write(to: URL(fileURLWithPath: path))
  rejected = false
  do { _ = try codeHash(path) } catch { rejected = true }
  precondition(rejected, "modified executable must be rejected")
  let engine = try NetworkEngine(kernelPath: "/usr/bin/true", directory: URL(fileURLWithPath: CommandLine.arguments[1]), privileged: false)
  var config: [String: Any] = ["inbounds": [["type": "mixed", "listen": "127.0.0.1", "listen_port": 18989]], "outbounds": [["type": "direct"]]]
  config["dns"] = ["servers": [["type": "https", "server": "example.test", "path": "/dns-query"]]]
  try engine.validate(config, mode: "manual")
  config["outbounds"] = [["type": "vmess", "transport": ["type": "ws", "path": "/websocket"]]]
  try engine.validate(config, mode: "manual")
  config["route"] = ["rule_set": [["type": "local", "path": "/etc/master.passwd"]]]
  rejected = false
  do { try engine.validate(config, mode: "manual") } catch { rejected = true }
  precondition(rejected, "privileged configuration cannot read arbitrary files")
  var proxies: [String: Any] = [:]
  for prefix in ["HTTP", "HTTPS", "SOCKS"] { proxies[prefix + "Enable"] = 1; proxies[prefix + "Proxy"] = "127.0.0.1"; proxies[prefix + "Port"] = 18989 }
  precondition(effectiveProxyMatches(proxies, port: 18989))
  precondition(!effectiveProxyMatches([:], port: 18989), "stored preferences are not proof of effective proxy")
  proxies["HTTPSPort"] = 12345
  precondition(!effectiveProxyMatches(proxies, port: 18989), "foreign endpoint cannot be reported owned")
  proxies["HTTPSPort"] = 18989; proxies["ProxyAutoConfigEnable"] = 1
  precondition(!effectiveProxyMatches(proxies, port: 18989), "PAC overrides cannot be reported owned")
  print("trust checks passed")
 }
}`,
  );
  execFileSync("/usr/bin/swiftc", [
    "native/LocalTrust.swift",
    "native/NetworkEngine.swift",
    "native/OwnershipJournal.swift",
    "native/KernelWatchdog.swift",
    "native/ProcessIdentity.swift",
    source,
    "-o",
    join(directory, "check"),
  ]);
  assert.match(
    execFileSync(join(directory, "check"), [directory], { encoding: "utf8" }),
    /passed/,
  );
  const installer = spawnSync("dist/flowgate-local-installer", ["install"], {
    encoding: "utf8",
  });
  assert.equal(installer.status, 1);
  assert.match(installer.stderr, /管理员授权/);
  console.log(
    "Root ownership, modified signature and unauthorized installer checks passed",
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
