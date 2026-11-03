# Chat reliability: causal fixes from the weekly dialogue audit

Status: source changes under review, not deployed. Base: deployed engine commit `b6f34c931aff8971688b46d8da56bf6eb3bab8cc`. User-facing integration and full investigation live in Image Studio `docs/CHAT_ROOT_CAUSES_2026_11_03.md` and `docs/plans/chat-reliability-2026-11-03.md`.

## Context publication

Automatic compression captures exact source IDs before the model call, consumes both text and multipart text, rejects an empty/error/aborted response, and publishes the summary with its source links in one database transaction. Messages added during generation and previous compressed groups remain visible. No provider call runs inside the transaction. Topic/session attribution reaches the runtime initializer. The interactive placeholder/finalize interface remains compatible, while empty finalization is rejected.

Archive snapshots omit only persisted outputs of `lobe-topic-reference/getTopicContext`: these are derived views of the same history and must not recursively include themselves. Other tool results, original messages, owner/topic boundaries and snapshot pagination remain. Use a real `db.select().from(messagePlugins)` subquery inside the relational `where`; raw plugin columns can be remapped to the outer message alias by Drizzle. The regression exercises emitted SQL with PGlite.

## Stop and errors

State and events use Redis together when configured, including local execution mode. Stop and its control event are written atomically. Late step completion preserves cancellation. Blocking stream subscribers use their own Redis connection; interruption reaches in-flight model and compression calls and aborts retry waits. A user cancellation must remain distinct from a resumable client-tool pause, including when replaying older events. Reported usage and partial output survive cancellation; already accepted external paid tool jobs are not automatically resubmitted or assumed cancelled.

Provider HTTP status survives stream normalization and precedes generic retryable provider types. The final message keeps a safe structured error and status so the initial stream and reopening history share the same cause. Do not reconstruct an old failure from today's balance. Preserve HTTPException status at the actual OpenAPI application boundary.

Verified Studio REST and browser bridge provisioning now use the same private Better Auth signup with Drizzle transactions enabled. User and credential become visible together; account-write failure rolls both back. The public auth configuration is unchanged. User initialization and verification mail run after commit, and this private signup creates no session or secondary-storage entry. A conflict is re-read and the derived credential must still verify: an existing email or orphan account is never enough. Post-commit effects are logged but not an outbox; process failure can still lose analytics/mail delivery. Tests use a fresh PostgreSQL cluster and separate Node processes, including rollback of the first concurrent writer.

## Tool availability

Manual mode removes tool discovery, so it must directly expose already configured/selected tools that still pass existing availability rules. Other deferred candidates stay unavailable, auto mode retains lazy discovery, and explicit exclusions are applied to defaults too. Test real generated functions, schemas and system instructions, rather than just lists of IDs. The memory instruction names the actual `lobe-user-memory` manifest.

An empty persisted `system_role` does not imply the generic inbox prompt: `mergeDefaultConfig` inserts the shared Arckep prompt before the inbox fallback. Inactive tools initially provide only discovery metadata; their schemas and full instructions appear after activation. That mechanism was verified offline and does not explain why a particular model chose not to activate a calculator. No new search quotas, compulsory-tool keyword rules, paid probes or user settings changes are included.

## File delivery and model instructions

The E2B gateway returns a JSON file payload, but chat uploads it and returns a download link. The schema adapter now describes this final contract for existing installs. PNG/JPEG results from this exact connector also enter the owned-file vision pipeline; models without vision retain the download link. Storage failures and oversized/invalid file payloads return an explicit missing-file result instead of leaking raw base64 into model context. Other connectors retain their existing delivery behavior.

Calculator discovery distinguishes arithmetic/units from code-and-file execution. Its full instructions distinguish the mathjs calculate/evaluate APIs from symbolic nerdamer. Search guidance accounts for repeated model input costs and agrees with the need_content schema. These are verified contract corrections, not proof that model reasoning is now reliable; the controlled model comparison has not run.

Direct HTML artifacts are streamed model text, not a tool-produced file with a validation result. There is currently no execution/check step that returns SyntaxError to the model before final delivery. A future explicit write/validate artifact tool can provide that feedback; extra prohibitions or a client warning do not close this gap.

## Validation and boundaries

Targeted regression tests cover real multipart protocol events, transaction rollback, archived derived results, generated tool manifests, inter-process Redis cancellation, resumable pauses, partial responses and persisted failures. Tests use one Vitest worker, PGlite or an isolated Unix-socket Redis instance; no production data is written.

Shared `node_modules` can resolve workspace packages from another checkout. Tests of changed packages must import this checkout's source or use explicit local aliases; a green test against the borrowed checkout is not evidence for the patch. Full type checking, builds and complete test suites belong in CI. Codegraph's LobeChat index tracks a different branch, so its partial result is supplemented by direct callers/schema review.

Detailed commands, before/after regressions and current results: private `/var/tmp/chat-audit-20261103/`. Old damaged groups, refunds, production configuration and services are unchanged. Release needs a separate owner instruction.

## CI in the fork

The fork initially reported Actions enabled but had no registered workflows or runs. Reapplying the repository Actions setting registered inherited workflows; only Test CI is enabled, while inherited release, messaging and AI workflows remain disabled. The web engine no longer contains the Electron app targeted by upstream CI, so CI now checks/builds the actual web engine. Full type checking and suites currently expose failures; do not describe the PR as release-ready until these are assessed. The optional manual baseline_ref input runs typecheck/build on an explicit base commit to distinguish prior failures from changes. Shared node_modules and a passing targeted test are not a substitute for that comparison.

The initial full typecheck produced incompatible SQL types from two copies of the same Drizzle version: a transitive mysql2 peer selected Node 25 types while the root used Node 24 types. A single workspace Node 24 type override removes that split; runtime package versions/integrity are unchanged. Isolated frozen-lock validation passes. The full head/baseline CI remains the authority for remaining errors. Use an explicit `-R gmen1057/lobehub` or repository API path for GitHub operations: gh can otherwise select the upstream parent of this fork.
