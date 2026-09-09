# FlowGate
Read REQUIREMENTS.md and work/STATE.md. The user approved the full architecture implementation on 2026-09-09. Codex is the confirmed visual reference.
## Boundaries
Stable shell imports contracts and release verification, never business implementations. Browser code imports no Node/Electron. Domain code has no native commands. Service owns all business writes. Helper owns kernel/system mutation and durable recovery. Builtin capability packages are trusted, not a security sandbox.
## Checks
npm run typecheck; npm test; npm run build; npm run test:e2e. Tests use isolated data and never change global routes/DNS/proxy settings. Real packet forwarding is a separate acceptance check. Never claim simulated connectivity as actual.
## Safety and continuity
Preserve external network settings with ownership-aware recovery. No subscription secrets in logs. Keep evidence in ignored work/. Update work/STATE.md after milestones. Do not overwrite unrelated local changes.
