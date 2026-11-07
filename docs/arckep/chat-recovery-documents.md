# Server chat recovery and complete document access

Prepared for `arckep/engine`; companion Studio branch `codex/chat-recovery-proxy`.
Deployment and production smoke require owner approval.

## Recovery contract

The server loop passes its assistant placeholder ID and `retryOwner: engine`
through ModelRuntime. Internal authentication plus a valid message ID enables
`x-arckep-retry-owner: engine`. The Studio proxy makes one upstream attempt;
the existing engine loop owns transient retries within the same assistant turn.
Already completed tools and earlier successful model steps are retained.

Only an empty transient attempt may restart. Text, reasoning, images, tool calls,
or reported token usage prohibit blind replay. Partial output and usage are
persisted on the same assistant with an error finish reason. Explicit Stop keeps
its separate interruption semantics. Permanent HTTP 4xx refusals stop, excluding
408/425/429; 402 remains a billing refusal.

The proxy sends heartbeats while waiting for upstream headers too. Native Google
SSE errors are discarded by the installed SDK. For internal engine calls only,
the proxy retains the native error and also places a versioned diagnostic envelope
in `promptFeedback.blockReasonMessage`, with blockReason OTHER. The event must
start with `data:`. The Google provider validates this carrier under the internal
headers gate and converts it to the existing runtime error protocol before safety
feedback handling. Ordinary provider requests do not decode it.

Usage is captured immediately, including usage-only or empty-candidate chunks.
Google requires a real stop/error terminal event; usage followed by EOF remains
a failure and cannot trigger another paid attempt.

## Agent documents

The original stays in the owner-scoped document store. Both read tools accept
`offset`, `limit` (up to 20000 source characters), literal `query`, and `snapshot`.
Results contain exact UTF-16 cursors, `nextOffset`, total length and SHA-256
snapshot. The model chooses which parts to inspect and follows cursors itself
for full-document tasks. Users do not split documents manually. A changed source
returns DOCUMENT_CHANGED so pages from different versions cannot be combined.
The general tool-result truncator does not truncate these already bounded pages.
Ownership and expected-agent checks still run through the existing model/service.

## Verification and limits

Targeted engine tests cover real Google SDK parsing, fragmented SSE using the
actual Python proxy encoder fixture, transient same-turn recovery, permanent
refusals, partial output, standalone usage + EOF/disconnect, and cancellation.
Document tests include real in-memory SQL records, owner isolation, Unicode,
search, arbitrary offsets, changed snapshots and originals over 120000 chars.
Full app/package/type/build checks run in CI.

This change does not establish why the original upstream ReadTimeout occurred.
Provider route and timeouts are unchanged. It fixes error propagation, duplicated
retry ownership and result preservation; it does not promise upstream availability.
Release the Studio proxy before the engine. Legacy callers retain the proxy retry
policy; document access is independent. Do not claim live repair until deployment
and the affected production behavior have been checked.
