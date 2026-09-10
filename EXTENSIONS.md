# Built-in extension management

The **扩展** navigation item manages the first-version, trusted, built-in packages. It is not a marketplace or an arbitrary Node.js plugin loader. The internal streaming gateway remains an internal acceptance fixture; this page does not advertise it as a delivered model product.

## Ownership and boundaries

| Layer | Responsibility |
|---|---|
| Contracts | `builtin-catalog.json` defines package identities, descriptions, dependencies, access declarations, command contributions and versions. |
| Renderer | Displays Service snapshots; sends `extensions.setEnabled` / `extensions.restart` with a revision and operation ID. It cannot load code or mutate local files. |
| Service | Sole durable writer for `extensionPreferences` and `extensionRevision` in the existing atomic state envelope. These do not change the network configuration revision or require a proxy reapply. |
| Stable Main | Authorizes the window and command, supervises the verified Extension entry, and forwards the constrained capability request. It imports no extension implementations. |
| Extension Host | Validates descriptor/implementation identity, owns runtime instances, runs activation and cleanup, and reports actual state. It does not persist user preferences. |
| Release system | Verifies exact Release Set files and approved package/access declarations. New identities or increased access outside the fixed loader's list require a full app update. |

Each package owns an `ExtensionRuntime` backed by the shared `ModuleRuntime`. Dependencies are resolved by `ExtensionManager`, and only confirmed ready dependencies satisfy local activation. Contribution IDs must match the package descriptor. The manager serializes state transitions while ordinary calls execute independently.

The three required packages are subscription parsing, rule-set parsing and system network discovery. The optional Tailscale and GUI.for.SingBox diagnostics are separately registered packages. Their state describes FlowGate's diagnostic capability, not whether the external application is connected. They use read-only interfaces; disabling them does not stop those applications.

## Lifecycle and persistence

1. A fresh host starts required packages only. It does not briefly activate a previously disabled optional diagnostic.
2. Service reads and validates durable preferences, then configures the host in dependency order.
3. An enable/disable request enters the existing single-writer transaction queue. Core-package removal, unknown IDs, invalid states, stale revisions and unsatisfied dependencies are rejected below the UI.
4. The host stops admitting calls to the selected package, propagates cancellation, waits for its active calls and runs cleanup. Sibling packages and the native kernel remain running.
5. Only successful runtime transition commits preferences and the independent extension revision. Activation failure attempts to restore the prior admitted set. Persistence failure restores the previous desired set rather than recording a successful toggle.
6. Unconfirmed cleanup leaves a failed instance. The manager refuses to start a second generation beside it; recovery requires restarting the host. Cleanup errors are no longer swallowed as successful stops.
7. Once a lifecycle transaction is admitted, canceling the client wait does not undo its possible commit. The operation ID and subsequent snapshot provide the result, consistent with other side-effecting operations.

Required packages cannot be disabled through IPC even if the UI is bypassed. Dependency failures never silently disable other packages. A Service or Extension restart re-applies persisted preferences. Failed host restarts exhaust a finite budget while keeping the workspace usable; the Extensions page can request an explicit host restart. This aborts in-flight extension tasks and preserves the existing proxy kernel. Initial failure before the Service is available still uses the fixed recovery shell.

Package instance identity includes package ID, host epoch and activation generation. Activation, calls, draining/cleanup and failure events use the same diagnostic trace with Release Set and module version. The page filters these events per package. Observed state is read from the host; a bounded status request reports unavailable instead of showing an old ready state indefinitely.

## Updates

The page exposes the existing signed update channel, candidate package versions, release notes, compatibility result, revocation warning and recent update stages. Settings uses the same `ReleaseUpdates` component. No per-package control can bypass `ReleaseManager` or install an unverified URL.

`scripts/manifest.mjs` reads the shared catalog when emitting a `catalogVersion: 1` Release Set. The fixed verifier checks known IDs, the complete catalog and access limits. The launched host compares its package versions and declarations with the authenticated manifest. Legacy manifests without a catalog version remain supported by the existing release format; they cannot introduce unknown package identities.

This is exact-combination deployment: updating an extension may replace the Extension/Service host and rebuild the UI. There is no production HMR or arbitrary dynamic React component injection. Preferences survive UI-only updates, Service updates and compatible failed-update rollback. Full app/native updates and the production update publisher still have the separate requirements in `RELEASING.md` and `ACCEPTANCE.md`.

## Adding an official package

Add its descriptor and a matching `RuntimeModule`, declare dependencies and contributions, and provide a bounded cleanup path. The Service and UI consume the catalog generically; do not add brand-specific branches there. Expose additional stable capabilities only through a deliberate contract/loader change. Package identity/access additions ship in a full application release so the stable loader can approve them. Parser format additions within an existing approved package can use ordinary signed business releases.

For a future service package, continue to use `CapabilityHost` / supervised verified entries and its drain contract; do not spawn untracked processes from the UI or treat a complete Node process as a hostile-code sandbox. The optional model gateway and third-party plugin installation remain outside this first-version product scope.

## Verification

`tests/extensions.test.ts` covers targeted cancellation/cleanup, core and dependency enforcement, failed activation and retry, cleanup failure preventing a second instance, persistent preferences and catalog access rejection. `tests/extensions.integration.mjs` covers normal navigation, details/trace/filtering, actual proxy forwarding during disable and host crashes, restart-budget exhaustion with manual recovery, app restart persistence, re-enable, offline update behavior and narrow layout.

`tests/update.integration.mjs` uses the complete catalog and verifies disabled preferences across signed UI/Service updates and failed startup rollback; its UI variant also checks the candidate details. These tests are included in `npm run verify`; focused execution is `npm run test:extensions`. To run the identical lifecycle and actual-forwarding suite against a packaged application, set `FLOWGATE_TEST_EXECUTABLE` to its `Contents/MacOS/FlowGate` executable and run `node tests/extensions.integration.mjs`; it still uses isolated test data and temporary listeners.

## Subscription package 2.0

The subscription package now contains a format registry and bounded parser workers loading the already verified Extension artifact. Runtime disposal terminates outstanding workers. New formats do not gain filesystem, script, certificate or remote-resource execution rights. Fetch/parse version 2 is a contract boundary coordinated with shell API 2 and schema 2 in the full 0.3 application. Subsequent compatible adapter improvements can use signed business updates. See [SUBSCRIPTIONS.md](SUBSCRIPTIONS.md) for supported semantics and failure behavior.
