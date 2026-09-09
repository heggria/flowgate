import Foundation
import Darwin
func processBirth(_ pid: Int32) -> String? {
    var info = kinfo_proc(); var size = MemoryLayout<kinfo_proc>.stride
    var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
    guard sysctl(&mib, UInt32(mib.count), &info, &size, nil, 0) == 0, size > 0 else { return nil }
    return "\(info.kp_proc.p_starttime.tv_sec):\(info.kp_proc.p_starttime.tv_usec)"
}
func availableLoopbackPort() throws -> Int {
    let fd=socket(AF_INET,SOCK_STREAM,0)
    guard fd>=0 else {throw NSError(domain:"无法分配控制端口",code:35)}
    defer {close(fd)}
    var address=sockaddr_in();address.sin_len=UInt8(MemoryLayout<sockaddr_in>.size);address.sin_family=sa_family_t(AF_INET);address.sin_addr.s_addr=inet_addr("127.0.0.1");address.sin_port=0
    let bound=withUnsafePointer(to:&address){pointer in pointer.withMemoryRebound(to:sockaddr.self,capacity:1){Darwin.bind(fd,$0,socklen_t(MemoryLayout<sockaddr_in>.size))}}
    guard bound==0 else {throw NSError(domain:"控制端口不可用",code:36)}
    var length=socklen_t(MemoryLayout<sockaddr_in>.size)
    let result=withUnsafeMutablePointer(to:&address){pointer in pointer.withMemoryRebound(to:sockaddr.self,capacity:1){getsockname(fd,$0,&length)}}
    guard result==0 else {throw NSError(domain:"读取控制端口失败",code:37)}
    return Int(UInt16(bigEndian:address.sin_port))
}
