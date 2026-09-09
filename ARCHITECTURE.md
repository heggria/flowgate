# FlowGate architecture

This document describes implemented foundations, not full completion of the approved plan. See [PLAN_AUDIT.md](PLAN_AUDIT.md) for per-item gaps and evidence.

## Process and release boundaries

Electron Main is the stable supervisor: bootstrap, desktop shell, client broker, process supervisor, native session, release coordinator, trusted loader and recovery UI. It never imports domain or service implementations. Business commands run in a persistent Service Host; parsing and discovery run in a separate Extension Host. Main retains the native session when Service is replaced. Gateway test streams use their own HTTP process, not renderer IPC.

The browser package uses FlowGateClient/ShellPort and static React feature contributions. The registry resolves a dependency DAG, stages contributions, commits atomically and disposes failed activation in reverse order. A single React runtime is bundled for each UI release. Independent Web deployment will require a separately authenticated transport and host; no remote management listener is exposed by the desktop build.

## State and operations

Service is the sole business writer, protected by an exclusive process lock. JSON snapshots are written with fsync and rename; transactions serialize mutations. Configuration uses optimistic revisions. Each operation has an ID and trace ID, pending/succeeded/failed/unknown states. A timeout is unknown, never an automatic replay. Restart reconciliation compares the native operation ID and applied revision. Subscription refresh preserves stable node IDs and rejects removal of the current selected exit. Credentials are omitted from renderer snapshots; configuration exports containing secrets are not exposed to renderer IPC.

Desired configuration and native applied revision are independent. Saving settings does not imply they are active. Auto-connect is opt-in. Native control credentials remain between the helper, stable broker and Service Host; they are never included in public snapshots. Connection telemetry is bounded to 200 records and contains no request bodies.

## Native ownership

Swift Bridge runs from the fixed application and owns a private inherited pipe session. On lease EOF it stops its unprivileged child. An installed XPC helper owns privileged changes and is kept alive independently of replaceable Service. Both XPC directions enforce the official signing team and executable identifier using Foundation's code signing requirement APIs. The helper rejects ad-hoc development clients and copies/validates its kernel into root-owned storage before executing it.

The helper serializes system work, snapshots individual proxy field groups under a SystemConfiguration preferences lock, journals before commit, and restores a group only if current values still match its applied values. Unrelated edits are retained. Kernel process birth identity is journaled before readiness to avoid blindly killing a reused PID during crash recovery. Unexpected kernel exit triggers cleanup. These privileged paths are compiled but still require signed-device fault testing; no machine-wide kill-switch guarantee is made.

Manual mode never edits global network state. System mode uses loopback proxies; TUN delegates route creation to sing-box. External HTTP/SOCKS endpoints are normal nodes. Explicit external interface exits use bound TCP/UDP sockets with a caller-selected DNS resolver. Interface ownership is not inferred from `utun` or a private address. L3 bridge/ICMP and forced-VPN compatibility are not claimed.

## Dynamic updates

Only built-in packages may be updated. Each immutable Release Set pins files and compatibility ranges. TUF verifies online root rotation, timestamp/snapshot/targets metadata, expiration and target hashes. Installed receipts re-verify the target signature from the bundled root and the persisted rotation chain on every load, even offline; changing both a bundle and its manifest does not establish trust. Old installed signed versions can run offline after metadata expiry, but expired candidates cannot be newly activated.

The default official signing algorithm is Ed25519. The integration fixture exposed an Electron/BoringSSL incompatibility with the TUF library's default ECDSA verification path; no signature check is bypassed. Local integration tests use Ed25519 for real Electron updates; a CI workflow is not yet configured. Other signing algorithms need explicit runtime qualification before publication.

Activation preflights a readonly Service instance. UI-only sets keep the existing Service and kernel; service sets drain, release the old writer, start a fresh epoch and rebuild the renderer. UI readiness requires a snapshot handshake. Startup failures quarantine the set and restore compatible previous code without copying an old database. Draft text stays in stable-shell memory across renderer replacement. Current, previous and quarantined IDs persist outside the signed application. Ordinary business updates never modify app.asar or install native dependencies.

Full-app updates use the separate Electron autoUpdater adapter and require a signed feed. The shipped development configuration disables official update access until the source and trust root are configured at release time.

## Future LLM package

The internal package tests independent process startup, mock egress identity, credential scope, streaming cancellation, tool deltas, stream errors, drain and in-memory budget reservations with unknown usage. Namespaced storage and cancellable jobs have basic implementations but are not fully qualified. Host-managed endpoints, durable job recovery, application UI contributions, real upstream egress and gateway Release Set update/rollback remain incomplete. It does not implement provider catalogs, actual model routing, pricing, tool execution or production model credentials. Provider protocol adapters must preserve native fields or declare explicit conversions; requests cannot be replayed after possible upstream effects.

### Continuation implementation
The stable shell now supervises a fixed verification worker and an internal gateway Utility Process. The gateway entry lives inside the verified Release Set; its optional settings contribution is visible only with `FLOWGATE_INTERNAL_TEST=1`. Streams remain direct loopback HTTP traffic and bypass Main. UI-only classification includes the gateway artifact hash. Service replacement drains the gateway, and rollback waits for restoration before reporting completion.

Service owns a coalescing network observer, versioned handoff records and business state. Extension methods share ModuleRuntime activation and cancellation. CapabilityHost tracks service startup, endpoints, streams and durable jobs. NamespacedStorage transactions are serialized within the owning process; this is not a cross-process database or hostile-code sandbox. The scoped HTTP test egress transport has no implicit direct fallback and explicitly rejects unsupported schemes. Remaining incomplete items are maintained in PLAN_AUDIT.md section 8.
