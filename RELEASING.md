# Release workflow

The public source is at https://github.com/heggria/flowgate. Required GitHub checks are `Static checks` and `macOS verification`; main requires a pull request, an up-to-date branch and both passing checks. Force pushes and deletion are disabled, including for administrators.

Apple certificates/notarization and dependent privileged acceptance are **deferred by the user**. Development packaging and independently signed business updates proceed without them. Do not claim Developer ID, notarization, real privileged TUN/helper acceptance or full application auto-update has passed.

## Verified development delivery

1. Use the pinned runtime from `.node-version` and `npm ci`, then `node scripts/fetch-kernel.mjs`.
2. Run `npm run verify` on macOS arm64. Build output separates fixed shell/native files from `dist/release`. The build uses a fresh staging directory, rejects missing/wrong-architecture kernel files, and seals exact hashes plus source provenance in `dist/build-manifest.json`.
3. `npm run package:mac` verifies that inventory, packages the exact build, records FlowGate's own version/build number and includes license notices. Its default output is a locally runnable ad-hoc development build.
4. `node tests/package.integration.mjs` starts the packaged executable hidden with isolated data and verifies a real proxy request. CI performs this after its behavioral checks, then uploads ZIP, SHA-256 checksum, source archive and provenance.
5. `Publish verified development build` consumes only a successful **push to this repository's main branch**, never a PR or fork. It publishes immutable `dev-<commit>` prereleases with no stable/latest designation. Existing assets are not overwritten. Failed checks produce no release.

Remote CI results, package checks and release artifacts are distinct evidence. A successful old commit does not validate concurrent uncommitted edits. Local builds record `dirty` status; public CI uses a clean checkout.

## Independently signed business delivery

The real [updates branch](https://github.com/heggria/flowgate/tree/updates) contains TUF metadata and digest-addressed Release Set files. `release/trusted-root.json` and HTTPS URLs in `src/desktop/update-config.json` establish the client trust anchor. The first business release uses verified source `75a07d246abac4e3f1c044d525123c6dedb61fb2`.

See [BUSINESS_UPDATES.md](BUSINESS_UPDATES.md) for exact local signing, publication, promotion, revocation, expiry renewal and old/new double-signed root rotation procedures. Root and targets private keys remain outside the build checkout on the operator machine. Only snapshot/timestamp keys are stored in GitHub secrets; the six-hour refresh workflow cannot sign new executable targets. An expired offline authorization fails closed and requires the local signer.

Release manifests declare publisher, platform, component versions, shell/protocol/schema compatibility and the capability catalog. Every artifact is verified before publication and before client activation. Immutable release records and monotonic versions prevent identity reuse and rollback. Authenticated revocations survive failed replacement downloads. Failed candidates are quarantined; bundled recovery remains available. Destructive data migrations are not supported by ordinary dynamic updates.

`node tests/live-update.integration.mjs` is the explicit real-feed acceptance check: HTTPS download, signature verification, activation, real proxy forwarding and restart from the installed verified release. It uses a hidden isolated Electron instance and is not an ordinary PR network dependency.

## Deferred production application delivery

`FLOWGATE_SIGNING_IDENTITY` selects an installed Developer ID. Production packaging invokes `@electron/osx-sign` for nested Electron resources with hardened runtime/JIT entitlement and preserves the native identifiers `com.flowgate.bridge`, `com.flowgate.helper` and `com.flowgate.kernel` under one team. Optional `FLOWGATE_NOTARY_PROFILE` references credentials already in the local keychain and invokes `@electron/notarize`. No secret is accepted in app UI or committed. This path remains unverified with a real certificate/profile.

After signing, install the app, register/approve its helper and perform the outstanding native/network matrix in [ACCEPTANCE.md](ACCEPTANCE.md). Configure the separate Squirrel.Mac HTTPS application feed for full shell/native/Electron upgrades. Business updates do not replace that channel.

Primary references: [TUF JS](https://github.com/theupdateframework/tuf-js), [Electron signing](https://www.electronjs.org/docs/latest/tutorial/code-signing), [osx-sign](https://github.com/electron/osx-sign), [notarize](https://github.com/electron/notarize).

## 0.3 subscription compatibility boundary

Ship subscription conversion in a full application: `packages/contracts/src/compatibility.json` sets shell API 2 and state schema 2, while the wire protocol remains 1. Generated Release Sets require these bounds; do not publish the new renderer/service as compatible with API 1. The schema-1 backup and downgrade restrictions are described in [SUBSCRIPTIONS.md](SUBSCRIPTIONS.md). Keep existing user installations intact when producing development artifacts; use a new `FLOWGATE_PACKAGE_DIR`.
