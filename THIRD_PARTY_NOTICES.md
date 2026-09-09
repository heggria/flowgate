# Third-party notices

## sing-box

FlowGate launches the separately downloaded, unmodified sing-box 1.14.0 executable. The executable is not checked into this repository. Its official download and archive SHA-256 are recorded in `vendor/manifest.json`; `npm run setup:kernel` verifies that digest before installation.

- Upstream source for the pinned version: https://github.com/SagerNet/sing-box/tree/v1.14.0
- Upstream license: [licenses/sing-box-LICENSE](licenses/sing-box-LICENSE), reproduced verbatim, including its naming/association condition.
- `packages/service/src/kernel/telemetry.proto` is a reduced, wire-compatible adaptation of the upstream `daemon/started_service.proto`. FlowGate retains only the messages and RPCs it consumes; upstream attribution and terms apply to this file.
- FlowGate is an independent project and does not imply endorsement by SagerNet or sing-box.

Before distributing a bundled binary release, include the applicable upstream notices and corresponding-source materials for the exact bundled versions. This repository's source publication is not a claim that an unsigned development app is ready for public binary distribution.

## JavaScript and Electron dependencies

Dependency versions are locked in `package-lock.json`. Each dependency retains its own license and copyright notices in its installed package. Electron additionally ships its `LICENSE` and `LICENSES.chromium.html`; retain these in binary distributions. FlowGate's GPL license does not replace third-party licenses.
