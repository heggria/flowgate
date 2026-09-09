# FlowGate

Read REQUIREMENTS.md and work/STATE.md. The user approved the full architecture implementation on 2026-09-09. Codex is the confirmed visual reference.

## Boundaries

Stable shell imports contracts and release verification, never business implementations. Browser code imports no Node/Electron. Domain code has no native commands. Service owns all business writes. Helper owns kernel/system mutation and durable recovery. Builtin capability packages are trusted, not a security sandbox.

## Checks

npm run typecheck; npm test; npm run build; npm run test:e2e. Tests use isolated data and never change global routes/DNS/proxy settings. Real packet forwarding is a separate acceptance check. Never claim simulated connectivity as actual.

## Safety and continuity

All isolated Electron tests (FLOWGATE_TEST_DATA) run hidden and non-focusable by default. Never use native UI activation for automated tests. FLOWGATE_TEST_VISIBLE=1 is an explicit manual debugging opt-in only; do not set it during routine verification. Preserve this behavior for window recreation, reloads and recovery.
Preserve external network settings with ownership-aware recovery. No subscription secrets in logs. Keep evidence in ignored work/. Update work/STATE.md after milestones. Do not overwrite unrelated local changes.

## Publishing

Main is protected: use a feature branch and pull request, wait for both required checks, then merge. Never disable protection or force-push main. Keep signing keys outside the repository and build workspace; only snapshot/timestamp roles belong in automated refresh jobs.
