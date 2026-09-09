# Security reporting

For vulnerabilities, use the repository's GitHub private vulnerability reporting feature (Security → Report a vulnerability). Do not post exploit details, tokens, subscriptions, or private diagnostics in public issues. If private reporting is unavailable, request a private contact channel without publishing sensitive details.

FlowGate is currently a development release. Production Apple signing/notarization and privileged network acceptance remain deferred. Built-in extensions are trusted code; this project does not claim a sandbox for arbitrary third-party plugins.

Dependency alerts, reviewed update PRs, secret scanning and push protection complement the verification workflow. An unavailable security scan is treated as a failed check, not evidence that dependencies are safe.
