# Chat reliability: causal fixes from the weekly dialogue audit

Status: source changes under review, not deployed. Base: deployed engine commit `b6f34c931aff8971688b46d8da56bf6eb3bab8cc`. User-facing integration and full investigation live in Image Studio `docs/CHAT_ROOT_CAUSES_2026_11_03.md` and `docs/plans/chat-reliability-2026-11-03.md`.

## Context publication

Automatic compression captures exact source IDs before the model call, consumes both text and multipart text, rejects an empty/error/aborted response, and publishes the summary with its source links in one database transaction. Messages added during generation and previous compressed groups remain visible. No provider call runs inside the transaction. Topic/session attribution reaches the runtime initializer. The interactive placeholder/finalize interface remains compatible, while empty finalization is rejected.

Archive snapshots omit only persisted outputs of `lobe-topic-reference/getTopicContext`: these are derived views of the same history and must not recursively include themselves. Other tool results, original messages, owner/topic boundaries and snapshot pagination remain. Use a real `db.select().from(messagePlugins)` subquery inside the relational `where`; raw plugin columns can be remapped to the outer message alias by Drizzle. The regression exercises emitted SQL with PGlite.

## Stop and errors

State and events use Redis together when configured, including local execution mode. Stop and its control event are written atomically. Late step completion preserves cancellation. Blocking stream subscribers use their own Redis connection; interruption reaches in-flight model and compression calls and aborts retry waits. A user cancellation must remain distinct from a resumable client-tool pause, including when replaying older events. Reported usage and partial output survive cancellation; already accepted external paid tool jobs are not automatically resubmitted or assumed cancelled.

Provider HTTP status survives stream normalization and precedes generic retryable provider types. The final message keeps a safe structured error and status so the initial stream and reopening history share the same cause. Do not reconstruct an old failure from today's balance. Preserve HTTPException status at the actual OpenAPI application boundary.

First-login atomicity remains open. BetterAuth's outer `runWithTransaction` does not provide database atomicity when the Drizzle adapter has transactions disabled. Merely enabling them globally would put user-create hooks, analytics and other external effects inside that transaction. A complete solution needs a narrow user+credential transaction and post-commit effects; a process-local promise map is not that solution.

## Tool availability

Manual mode removes tool discovery, so it must directly expose already configured/selected tools that still pass existing availability rules. Other deferred candidates stay unavailable, auto mode retains lazy discovery, and explicit exclusions are applied to defaults too. Test real generated functions, schemas and system instructions, rather than just lists of IDs. The memory instruction names the actual `lobe-user-memory` manifest.

An empty persisted `system_role` does not imply the generic inbox prompt: `mergeDefaultConfig` inserts the shared Arckep prompt before the inbox fallback. Inactive tools initially provide only discovery metadata; their schemas and full instructions appear after activation. That mechanism was verified offline and does not explain why a particular model chose not to activate a calculator. No new search quotas, compulsory-tool keyword rules, paid probes or user settings changes are included.

## Validation and boundaries

Targeted regression tests cover real multipart protocol events, transaction rollback, archived derived results, generated tool manifests, inter-process Redis cancellation, resumable pauses, partial responses and persisted failures. Tests use one Vitest worker, PGlite or an isolated Unix-socket Redis instance; no production data is written.

Shared `node_modules` can resolve workspace packages from another checkout. Tests of changed packages must import this checkout's source or use explicit local aliases; a green test against the borrowed checkout is not evidence for the patch. Full type checking, builds and complete test suites belong in CI. Codegraph's LobeChat index tracks a different branch, so its partial result is supplemented by direct callers/schema review.

Detailed commands, before/after regressions and current results: private `/var/tmp/chat-audit-20261103/`. Old damaged groups, refunds, production configuration and services are unchanged. Release needs a separate owner instruction.
