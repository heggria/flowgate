# Contributing to FlowGate

Use macOS Apple Silicon, Node from `.node-version`, npm 11, and Xcode Command Line Tools. Run `npm ci` and `npm run setup:kernel`, then `npm run verify`. Static architecture/infrastructure checks are also available with `node scripts/check-boundaries.mjs` and `node --test tests/infrastructure.test.mjs`.

Work on a branch and submit a pull request. The protected `main` branch requires passing `Static checks` and `macOS verification` checks. Single-maintainer work does not require a second person's approval. Never force-push main. Preserve other contributors' uncommitted work.

Format changed JavaScript/TypeScript, JSON, CSS and YAML files with the repository's Prettier version. CI checks changed files so this work does not silently reformat unrelated historical code. Run `node scripts/check-format.mjs <base-commit-sha>` after committing.

Tests use isolated data, loopback fixtures and hidden Electron windows. Do not activate native UI during automation or modify the host's global network configuration. `FLOWGATE_TEST_VISIBLE=1` is for deliberate manual debugging only.

A build creates an isolated output with a SHA-256 inventory and replaces dist only after success. Packaging verifies the inventory and application version. If an interrupted build leaves `work/build.lock`, read its `owner.json` and verify that PID has exited before removing the lock; do not remove a live build's lock.

Describe the behavior change, the tests run, and any unverified limits in the PR. Credentials, subscriptions, signing keys and raw user diagnostics must never enter commits or CI artifacts. Apple signing/notarization and dependent privileged acceptance are currently deferred; development artifacts must remain clearly labeled.
