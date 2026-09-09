import AppKit
import Foundation

// Observe activation only; never activate an application or capture user input.
func report(_ pid: pid_t?) {
    print(pid ?? 0)
    fflush(stdout)
}
let workspace = NSWorkspace.shared
let observer = workspace.notificationCenter.addObserver(
    forName: NSWorkspace.didActivateApplicationNotification,
    object: nil,
    queue: .main
) { notification in
    report((notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)?.processIdentifier)
}
report(workspace.frontmostApplication?.processIdentifier)
RunLoop.main.run()
