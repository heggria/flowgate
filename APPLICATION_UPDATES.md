# Full application update preparation

FlowGate uses Electron `autoUpdater` with `serverType: "json"`. This channel replaces the complete application; business Release Sets remain a separate TUF channel. The production application feed is currently empty. The preparation command below writes local artifacts and does not upload them or change that setting.

## Version and directory format

The static directory contains `currentRelease` and a matching `releases[].version` entry with an `updateTo` payload. Squirrel compares `currentRelease` with `CFBundleShortVersionString` (`app.getVersion()`), not the CI build number. Increase the numeric application version before publishing an update to existing users. Merely incrementing `CFBundleVersion` will not offer an update. FlowGate's preparation command requires the previously distributed version and rejects equal, older or prerelease-style version strings.

Sources: [Squirrel static JSON format](https://github.com/Squirrel/Squirrel.Mac#update-file-json-format), [Electron autoUpdater](https://www.electronjs.org/docs/latest/api/auto-updater).

## Prepare a signed candidate

1. Finish the release gates in RELEASE_READINESS.md, choose a new numeric application version, and build the exact clean candidate.
2. Package with the existing `FLOWGATE_SIGNING_IDENTITY` and `FLOWGATE_NOTARY_PROFILE` settings. Keep key material out of the workspace. The current packaging path signs native and Electron resources, notarizes and staples the application.
3. Run the package acceptance checks against that exact app. Set the following values to the selected app, previous distributed version, intended permanent HTTPS ZIP URL and release notes file. The paths and URL below are examples, not a published release:

```sh
FLOWGATE_PACKAGE_DIR=/absolute/path/FlowGate.app \
FLOWGATE_APPLICATION_PREVIOUS_VERSION=0.3.2 \
FLOWGATE_APPLICATION_ARCHIVE_URL=https://downloads.example.com/FlowGate-0.3.3-macos-arm64.zip \
FLOWGATE_APPLICATION_NOTES_FILE=/absolute/path/release-notes.md \
FLOWGATE_APPLICATION_RELEASE_DIR=/absolute/path/new-release-directory \
npm run prepare:application-release
```

Preparation requires an existing source commit, a clean sealed inventory, matching bundle version/identifier, valid complete code signatures, a Developer ID identity, matching native signing teams, a valid stapled notarization ticket and a successful Gatekeeper assessment. It refuses an existing output directory. If artifact creation fails, only the newly reserved output directory is removed.

Successful output contains the application ZIP, `releases.json`, exact-commit source archive, provenance and `SHA256SUMS`. The directory records the ZIP's actual digest and size. The provenance explicitly records `published: false`; artifact creation is not publication, an installation test, or proof that the intended URL is live. Development archives continue to use the existing separate command.

## Delivery and acceptance

Upload the immutable ZIP/source/provenance/checksums to the selected release location, verify the hosted ZIP bytes, then publish the static directory last. Set `applicationFeed` in `src/desktop/update-config.json` to that directory's HTTPS URL for the application versions intended to use it. Existing applications built with an empty feed first need manual installation of a feed-enabled build. Use a separate arm64 directory; x64/universal distribution has not been implemented.

On an isolated Mac with the previous signed version installed, verify no-update, newer-version download, interrupted download/retry, signature failure, application exit/next-start installation, retained user configuration, and helper reapproval/reinstallation when required. Verify both old and new versions against the same signing identity and exercise real forwarding after installation. These signed-download/install gates remain unverified until suitable credentials and a real feed are available.

## Automated checks and limits

`npm run test:application-feed` checks metadata input/version ordering, then runs the real bundled Squirrel parser inside a copied, ad-hoc-signed Electron fixture with a unique application identity and isolated data. It opens no windows. Local HTTP permission exists only in that disposable fixture. The test covers the generated same-version directory, invalid JSON, missing download URL and recovery on the next check; it asserts that no update is offered or downloaded. Its result is `work/application-feed-result.json`. The native part also runs in `verify` on macOS.

This is native protocol evidence, not Developer ID, notarized distribution, a successful update download, or an install/rollback test. The preparation command's development-package rejection has been checked; its successful production-signing path still requires real credentials.
