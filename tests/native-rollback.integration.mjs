import assert from "node:assert/strict";
import { createServer } from "node:net";
import { writeFile, mkdtemp } from "node:fs/promises";
import { resolve, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
const listener = createServer((s) => s.end());
await new Promise((r) => listener.listen(0, "127.0.0.1", r));
const port = listener.address().port;
const root = await mkdtemp(resolve("work/native-rollback-"));
await writeFile(
  join(root, "Probe.swift"),
  `import Foundation
import Darwin
final class Process {
 static var nextPID: Int32 = 900000
 static var live = Set<Int32>()
 var executableURL: URL?; var arguments: [String]?; var standardInput: Any?; var standardOutput: Any?; var standardError: Any?
 var processIdentifier: Int32 = 0
 var isRunning: Bool { Self.live.contains(processIdentifier) }
 func run() throws { Self.nextPID += 1; processIdentifier = Self.nextPID; Self.live.insert(processIdentifier) }
 func terminate() { Self.live.remove(processIdentifier) }
 func waitUntilExit() { Self.live.remove(processIdentifier) }
}
struct Record {var kernelPID: Int32?;var kernelBirth: String?;var phase="stopped";var operationId: String?}
class OwnershipJournal {var record=Record();init(directory:URL)throws{};func persist()throws{}}
class SystemProxyOwner {
 static var failApply=false;static var failRestore=false
 init(journal:OwnershipJournal){}
 func restore()throws{if Self.failRestore{throw NSError(domain:"fixture restore failure",code:1)}}
 func apply(port:Int,operationId:String)throws{if Self.failApply{Self.failRestore=CommandLine.arguments[2] == "cleanup-failure";if CommandLine.arguments[2] == "healthy-rollback"{Self.failApply=false};throw NSError(domain:"fixture apply failure",code:2)}}
 func isCurrentOwner(operationId:String)->Bool{true};func isEffective()->Bool{true}
}
@discardableResult func kill(_ pid:Int32,_ signal:Int32)->Int32{fatalError("Unexpected real signal in injected fixture")}
func processBirth(_ pid:Int32)->String?{nil}
func availableLoopbackPort()throws->Int{${port}}
func command(_ path:String,_ args:[String],timeout:Double=0)throws->String{""}
func startKernelWatchdog(kernel:Int32,directory:URL,privileged:Bool)throws{}
@main struct Probe {static func main()throws{
 let engine=try NetworkEngine(kernelPath:"/usr/bin/true",directory:URL(fileURLWithPath:CommandLine.arguments[1]),privileged:true)
 let config:[String:Any] = ["inbounds":[["type":"mixed","listen":"127.0.0.1","listen_port":${port}]],"outbounds":[]]
 try engine.apply(["config":config,"revision":1,"operationId":"old","mode":"system"])
 SystemProxyOwner.failApply=true
 do{try engine.apply(["config":config,"revision":2,"operationId":"new","mode":"system"])}catch{}
 print("live kernels after failed rollback: \\(Process.live.count)")
 print("state: \\(engine.state()["status"] ?? "none")")
 SystemProxyOwner.failRestore=false;try engine.stop()
 print("live kernels after explicit stop: \\(Process.live.count)")
}}
`,
);
try {
  await exec("/usr/bin/swiftc", [
    "native/NetworkEngine.swift",
    join(root, "Probe.swift"),
    "-o",
    join(root, "probe"),
  ]);
  for (const [scenario, count, status] of [
    ["cleanup-failure", 1, "unknown"],
    ["rollback-failure", 0, "failed"],
    ["healthy-rollback", 1, "running"],
  ]) {
    const r = await exec(join(root, "probe"), [join(root, scenario), scenario]);
    assert.match(
      r.stdout,
      new RegExp("live kernels after failed rollback: " + count),
    );
    assert.match(r.stdout, new RegExp("state: " + status));
    assert.match(r.stdout, /live kernels after explicit stop: 0/);
  }
  console.log(
    "PASS production native rollback: failed cleanup retains one recoverable process; failed rollback leaves none; healthy rollback still runs (injected processes and system backend)",
  );
} finally {
  await new Promise((r) => listener.close(r));
}
