Owner: codex
Status: in-progress
Branch: codex/fix-context-quality

# Automatic context management after leo-n incident

User approved implementation and, on 2026-09-16, commit/push and deployment. Keep unpublished source work in this worktree.

Implementation and targeted verification completed. Release build, commit/push and deployment are not performed; handoff and limitations: CONTEXT\_QUALITY\_REVIEW\.md. The isolated smoke build was intentionally stopped after SPA/Next compilation during static generation; it is not release verification.

1. Bound file injection across attachment history and agent knowledge; retain IDs and original access.
2. Extend existing readKnowledge with bounded pages, literal search and explicit coverage/cursors, shared by client/server execution. Enable retrieval for attachments without manual KB setup.
3. Preserve source references when summarizing and account for attachment/tool content in compression. Keep the current user turn intact.
4. Verify large VCF, relevant data at EOF, complete sequential reads, missing/unauthorized files, tool availability and regression suites.
5. Document exact limits and pending rollout. No production DB/config/source changes.

Codegraph MCP is not available in this session; trace callers and both execution paths manually. Financial reservation across provider requests requires a durable operation-level ledger; do not represent a context fix as implementing that contract.
