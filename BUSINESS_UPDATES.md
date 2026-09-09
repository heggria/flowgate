# Business update operations

The public [`updates` branch](https://github.com/heggria/flowgate/tree/updates) serves signed business Release Sets. Protected `main` embeds `release/trusted-root.json` and the HTTPS URLs. This channel replaces verified UI/service/extension code; it does not replace Electron, the native helper or kernel. Apple signing/notarization and the separate full application feed remain deferred. A channel named `stable` does not mean the application has passed those deferred acceptance checks.

## Trust and key custody

The publisher uses `@tufjs/models` with four distinct Ed25519 roles. The public anchor is the only key material committed to the source. Private keys are stored outside all checkouts in a mode-0700 directory, with mode-0600 files. On the initial operator machine, this is `~/Library/Application Support/FlowGate Release Signing/keys`. Root and targets keys remain local; they are **not physically offline**. Back them up separately in protected storage. Losing both the root key and its backup prevents normal root rotation. Do not copy this folder into build artifacts, chat or Git.

Only `FLOWGATE_TUF_SNAPSHOT_KEY` and `FLOWGATE_TUF_TIMESTAMP_KEY` are GitHub Actions secrets. The refresh job writes temporary mode-0600 files, removes them on exit, and cannot authorize new code or extend targets authorization. Root expires after 365 days, targets after 30 days, snapshot after 7 days, timestamp after 1 day. Refresh runs every six hours and can be dispatched manually. It warns when targets have fewer than 7 days or root fewer than 30 days; expiration causes failure, never a silently trusted update. Operators must renew targets before 30 days and root before a year. Check Actions failures; public-repository scheduled jobs can also be disabled by GitHub after prolonged inactivity.

## Prepare and publish a release

Use a clean checkout of a commit whose required CI checks have passed. Build that checkout, then generate a unique Release Set:

```sh
npm ci
node scripts/fetch-kernel.mjs
npm run build
node scripts/manifest.mjs business-<commit> <increasing-integer> preview
```

The build inventory must report that exact commit and `dirty: false`. Keep the manifest and inventory with release evidence. Version integers increase globally across both channels. The publisher verifies every artifact against the manifest, permanently reserves release IDs, retains immutable release records, and refuses rollback or reused IDs.

In a separate checkout of the public updates branch, fast-forward before preparing any signing operation. From the source checkout, invoke:

```sh
git -C /path/to/updates pull --ff-only
node --import tsx scripts/tuf-cli.mjs publish /path/to/updates /outside/keys /path/to/new-output /path/to/clean-build/dist/release /path/to/manifest.json
```

`new-output` and its sibling `.request` must not already exist. The core explicitly prepares a signing request, validates/signs targets, and finalizes it against the current baseline. The local CLI performs those steps together; the core APIs also support separate offline signing stations. Output contains only public metadata and targets. Review the manifest and expected version before publishing:

```sh
cp -R /path/to/new-output/metadata/. /path/to/updates/metadata/
cp -R /path/to/new-output/targets/. /path/to/updates/targets/
git -C /path/to/updates add metadata targets
git -C /path/to/updates commit -m 'Publish business release <id>'
git -C /path/to/updates push origin HEAD:updates
```

The single Git commit is the public commit point. Never force-push. If a concurrent refresh makes the push non-fast-forward, discard the unpublished operation in a fresh checkout of the latest updates branch and prepare/sign/finalize again; do not merge or rebase signed metadata. Existing versioned metadata and digest-prefixed artifacts remain immutable.

## Promotion, revocation and renewal

Each operation takes a fresh output directory and is published using the same copy/commit/push procedure above:

```sh
node --import tsx scripts/tuf-cli.mjs promote /path/to/updates /outside/keys /path/to/promoted <release-id>
node --import tsx scripts/tuf-cli.mjs revoke /path/to/updates /outside/keys /path/to/revoked <release-id>
node --import tsx scripts/tuf-cli.mjs renew-targets /path/to/updates /outside/keys /path/to/renewed
```

Promotion retains the same code and version. Revocation is permanent and removes affected channel pointers; publish a newer replacement to restore an available channel. The client retains revoked IDs even when no replacement can be downloaded. Already running code is not silently interrupted; the next activation/load refuses revoked code. Roll back a bad candidate through the application's bundled recovery, then publish corrected code at a higher version. Never decrease signed versions.

## Root and role rotation

Rotate all four roles locally using the old root key. The new key directory must not exist; its parent must exist outside the checkout. This creates a consecutive root signed by both old and new root keys, renews targets with the new key, and finalizes with the new online keys:

```sh
node --import tsx scripts/tuf-cli.mjs rotate /path/to/updates /outside/keys /path/to/rotated /outside/new-keys
```

Retain the original trusted anchor and all versioned roots. After reviewing and publishing the new metadata, replace the two GitHub online secrets from the new private files with `gh secret set NAME < /outside/new-keys/<role>.pem`, then manually dispatch refresh and confirm success. Keep the old key backup until the transition has been verified; use the new directory for all subsequent signing. The CLI preserves the original anchor in the new key directory so the full chain remains verified.

Tests exercise role isolation, stale baselines, immutable records, promotion, renewal, revocation, old/new root signatures and actual `tuf-js` download across rotation. `tests/live-update.integration.mjs` is an explicit network acceptance test for the configured real feed; it runs a hidden isolated Electron instance, activates the downloaded release and verifies real proxy forwarding. It is intentionally outside ordinary PR CI, so forks and unrelated PRs do not depend on the live feed.
