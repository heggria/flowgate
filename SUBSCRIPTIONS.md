# Subscription conversion

FlowGate 0.3 introduces the version 2 subscription contract. The default imports nodes. The optional full-profile mode previews replacement of routing, groups and DNS before committing. Unsupported profile semantics block that mode as a whole; they do not prevent otherwise valid node-only imports.

## Formats and protocol scope

The registry accepts sing-box JSON, Clash YAML/JSON, SIP008 JSON, plain or base64 URI lists, Quantumult X, Loon, Surge and Shadowrocket text. Format selection can be automatic or explicit. These are format families with a declared subset, not compatibility with every client feature or protocol. The normalized model supports HTTP, SOCKS, Shadowsocks, VMess, VLESS, Trojan, Hysteria2 and TUIC. Each adapter validates its protocol fields, TLS and supported transports; unsupported options produce diagnostics rather than being silently passed through to the kernel.

VMess AEAD follows the source client's explicit setting or documented adapter default. The preview offers a deliberate override for providers whose different endpoints disagree. It never borrows credentials or protocol settings from a different subscription URL. Metadata-shaped URI entries remain visible by default; exclusion is explicit and recorded. Subscription usage/expiry headers are displayed when present.

See the target kernel's [VMess fields](https://sing-box.sagernet.org/configuration/outbound/vmess/), [Shadowsocks methods](https://sing-box.sagernet.org/configuration/outbound/shadowsocks/) and [dial fields](https://sing-box.sagernet.org/configuration/shared/dial/) for the underlying protocol controls. Parser normalization is separately validated before compilation.

## Ownership and commit lifecycle

1. Service requests HTTPS retrieval from the existing subscription extension. Fetches have a 15-second deadline, a 4 MiB body limit, no redirects and sanitized failures. ETag and Last-Modified are persisted privately. Conditional requests are used only when parser version, parse options and migration mode match the previous conversion.
2. The Extension Host starts a bounded worker using the same verified `extension.cjs` artifact. There is no new unsigned executable or arbitrary plugin loading. At most two parser workers run concurrently; parse deadline is five seconds, with limits on memory, nodes, lines and diagnostics. Abort and package disposal terminate and join workers.
3. Adapters emit a normalized document containing nodes, declarative profile data and safe diagnostics. They never execute scripts, install certificates or fetch referenced resources. Source text and subscription URL credentials are absent from renderer snapshots and diagnostics.
4. Service builds a read-only preview and validates the resulting configuration. The preview contains no passwords, UUID credentials, raw source lines or transport secrets. Up to eight previews live in memory for ten minutes. Each token binds the exact parsed result, source, options and a private fingerprint of the starting configuration.
5. Confirmation enters the existing single-writer transaction. Expired, reused, wrong-source or stale previews are rejected. Confirmation reuses the reviewed body without another download. Node identities survive endpoint/credential rotation; duplicate names consume previous identities at most once. Removal of nodes still referenced by the current selection or rules blocks the change.
6. Durable commit uses the existing atomic state writer. Fetch, parse or validation failure retains the last good configuration. A validated HTTP 304 updates subscription metadata without incrementing the network configuration revision. The fingerprint also invalidates concurrent previews after metadata-only changes.

Importing or refreshing does not automatically apply a changed network configuration. The existing desired/applied revision flow remains in charge. A 304 does not falsely make a running configuration appear unapplied.

## Optional full-profile migration

Supported profile elements are static selector and URL-test groups, explicit member references, ordered domain/exact/suffix/keyword, IP CIDR and process-name rules, a final destination, and a single explicit DNS upstream. The preview reports the groups, rules and proposed DNS server. Group selection is persisted through Service and used by the kernel compiler; applying a new selection follows the normal configuration apply flow.

Full-profile confirmation replaces the current groups, routing rules and rule-source associations. Listener ports and system/manual/TUN mode remain local settings. DNS uses FlowGate's existing DNS egress behavior; this is not a promise to reproduce every source client's resolver routing.

Unsupported group strategies, unresolved references, unsupported rule modifiers, GEOIP/GEOSITE/ASN datasets, User-Agent rules, hosts/Fake-IP/multiple DNS selection, scripts, MITM certificates and remote resources prevent full-profile commit. These limitations appear before confirmation. The original nine provider endpoints all supported node import in the recorded live checks, but their complete profiles contain unsupported rules or resources and are not claimed to migrate losslessly.

## Automatic refresh

Refresh defaults to off. A saved source may opt into a 1–168 hour interval. Service owns a sequential scheduler, coalesces overlapping ticks, backs off failed attempts, and cancels work on pause, drain or replacement. Node removals, rejected entries, warnings and full-profile changes require interactive review. A failed background refresh records a safe status and preserves the previous nodes. Local text imports have no remote refresh source.

## Compatibility and data migration

The fixed shell API and state schema are version 2; wire protocol remains version 1. This feature therefore ships in a full 0.3 application, not as a business release for older shells. `compatibility.json` supplies manifest and loader bounds. Incompatible old business releases are rejected before activation.

The admitted state writer backs up schema 1 state to `state-before-schema-2.json` with private permissions before migration. Read-only preflight does not create that backup. Old nodes retain their previous compilation behavior; only validated version 2 normalized nodes activate the newly supported protocol options. Older applications reject schema 2 instead of silently erasing groups or options. Downgrade requires an explicit offline restore of the backup and is not performed automatically.

## Verification

`tests/subscriptions.test.ts` covers adapter failures, quoting/encoding, protocol options, profile atomicity, preview source/revision/fingerprint binding, conditional caching, lifecycle cancellation, schema migration and downgrade gates. `tests/subscription.integration.mjs` runs real HTTPS retrieval, the verified worker and renderer confirmation; it verifies last-good preservation, HTTP 304, stale previews, group forwarding and restart persistence. `tests/protocols.integration.ts` checks seven proxy protocols plus six VMess source formats with actual loopback TCP/UDP traffic.

These tests use isolated hidden instances without changing global network settings. Private provider samples are not committed. Their aggregate parsing/kernel-check evidence does not establish external provider reachability.
