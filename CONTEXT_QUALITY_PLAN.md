Owner: codex
Status: done
Branch: codex/fix-context-quality

# Automatic context management after leo-n incident

User approved implementation and, on 2026-09-16, commit/push and deployment. Keep unpublished source work in this worktree.

Implementation, commit/push and deployment completed on 2026-09-16. Code commit: c96007af14429c4ec609d6ddd73d985886efd610. Full release build passed; 424 targeted tests passed. Production BUILD\_ID: PkK60p1eEhfSDdEWtHZ1x. Handoff, smoke evidence and limitations: CONTEXT\_QUALITY\_REVIEW\.md. GitHub CI did not start in the fork and is not claimed green.

1. Bound file injection across attachment history and agent knowledge; retain IDs and original access.
2. Extend existing readKnowledge with bounded pages, literal search and explicit coverage/cursors, shared by client/server execution. Enable retrieval for attachments without manual KB setup.
3. Preserve source references when summarizing and account for attachment/tool content in compression. Keep the current user turn intact.
4. Verify large VCF, relevant data at EOF, complete sequential reads, missing/unauthorized files, tool availability and regression suites.
5. Document exact limits and completed rollout. No production DB/schema/application-configuration changes; only LobeChat build artifacts and deployment markers were updated, then its service restarted.

Codegraph MCP is not available in this session; trace callers and both execution paths manually. Financial reservation across provider requests requires a durable operation-level ledger; do not represent a context fix as implementing that contract.
