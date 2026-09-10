# Free local development and use on macOS

FlowGate can use manual proxy, system proxy and TUN on the developer's own Mac without an Apple Developer membership or Developer ID certificate. The local package uses ad-hoc signatures and an administrator-approved local helper. This does not provide Apple notarization or a Developer ID distribution identity.

## Build and run

Use the versions in `.node-version` and `package.json` on Apple Silicon macOS. Install Apple's Command Line Tools, then run `npm ci`, `npm run setup:kernel`, and `npm run build`. `npm start` launches the development application. To build a standalone app, set `FLOWGATE_PACKAGE_DIR` to a new output path and run `npm run package:mac`.

In Settings under **网络接入**, select **安装系统辅助服务**. Approve the macOS administrator dialog locally. FlowGate verifies the real helper connection before reporting installation success. No Apple account or paid certificate is used. Disconnect the proxy before updating or uninstalling the helper.

The approved bridge code hash is tied to this build and user. After rebuilding native components, use **更新辅助服务** to approve the new build. Installing a different build replaces the previously approved local build. Other local users and unapproved bridge binaries are rejected.

## Modes and coexistence

- Manual: configure the consuming app with FlowGate's HTTP/SOCKS address. It works without installing the helper.
- System: changes supported macOS network-service proxy settings. Applications must honor system proxy settings. An active VPN with a virtual primary interface can override those settings; FlowGate rejects that situation instead of claiming global success. Disconnect that VPN to use independent system proxy mode, or use manual proxy for coexistence. Successful system-proxy application also requires the effective global HTTP/HTTPS/SOCKS settings to match; otherwise the operation restores its owned changes.
- TUN: creates a dedicated virtual interface and routes packets through sing-box. The native engine chooses an unused interface. Existing VPNs and default routes can affect behavior; validate the desired combination with actual traffic.

Stopping restores only the settings still owned by FlowGate. A client disconnect releases the helper lease. A separate watchdog recovers owned settings and kernel processes when the helper crashes. Tests using `FLOWGATE_TEST_DATA` cannot install system helpers and never connect to them; standalone `NativeSession` also disables system helpers by default.

## Installed files and uninstall

- `/Library/PrivilegedHelperTools/com.flowgate.local/`: root-owned bridge/helper/kernel copies and the approved code hashes/user ID.
- `/Library/LaunchDaemons/com.flowgate.local.helper.plist`: root launch daemon and XPC service.
- `/Library/Application Support/FlowGateLocal/`: root-private runtime state and recovery journal.

**卸载辅助服务** requests administrator authorization, unloads the daemon, recovers network state using the verified installed helper, and removes these files only after successful recovery. An empty root-only `.flowgate-local.lock` in `/Library/PrivilegedHelperTools` remains to serialize concurrent installers; it contains no executable or user data. User subscriptions and app settings are retained. Manual proxy remains available.

## Security model and limitations

Installation hashes the selected binaries before authorization, copies them to root-owned staging, checks their SHA-256 digests and code signatures, and atomically replaces the installed service. Root paths reject symlinks and group/world-writable ownership. Bootstrap failure restores the prior installation when possible. XPC uses exact code-hash requirements in both directions, plus the administrator-approved user ID. The helper validates configurations and does not accept arbitrary shell commands or caller-selected kernel executables.

No system security protection is disabled. Ad-hoc signing plus local administrator approval is intended for local development/use. The existing Apple-signed distribution path remains available separately. Local installation must not be described as notarized distribution or complete macOS 27 certification.

References: [Apple code-signing requirements](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements/), [launchd jobs](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html).
