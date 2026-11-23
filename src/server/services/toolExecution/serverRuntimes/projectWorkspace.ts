import { PROJECT_WORKSPACE_TOOL } from '@lobechat/builtin-tools';
import type { SourceLineEnding, SourceTextEncoding } from '@lobechat/file-loaders';
import type { FileReadPage } from '@lobechat/prompts';
import {
  FILE_READ_CHARS,
  FILE_READ_DEFAULT_MAX_LINES,
  FILE_READ_MAX_LINES,
  FILE_READ_MIN_LINES,
  readFilePage,
} from '@lobechat/prompts';
import { and, eq, isNull, sql } from 'drizzle-orm';

import { documents, projectFileRevisions, projectWorkspaceFiles } from '@/database/schemas';
import type {
  AgentWriteOutcome,
  WorkspaceDeleteOutcome,
  WorkspaceFileDto,
  WorkspaceProposalDto,
} from '@/server/services/projectWorkspace';
import {
  escapeXmlAttr,
  isRootAgentsMd,
  isWorkspaceEnabled,
  MAX_AGENT_WRITES_PER_RUN,
  normalizeWorkspacePath,
  ProjectWorkspaceStore,
  WorkspaceError,
} from '@/server/services/projectWorkspace';
import type { PatchEdit } from '@/server/services/textFiles/patch';

import type { ToolExecutionContext, ToolExecutionResult } from '../types';
import type { ServerRuntimeRegistration } from './types';

export const WORKSPACE_CHANGE_MARKER_PREFIX = 'ARCKEP_WORKSPACE_CHANGE ';
export const WORKSPACE_PROPOSAL_MARKER_PREFIX = 'ARCKEP_WORKSPACE_PROPOSAL ';

const WRITE_LIMIT_TTL_MS = 30 * 60 * 1000;
const WRITE_LIMIT_REACHED_MESSAGE =
  'Workspace write limit reached (maximum 20 file mutations per response). Summarize completed changes and ask the user before continuing.';

const agentRunMutationCounts = new Map<string, { count: number; ts: number }>();

export const resetProjectWorkspaceWriteLimiterForTests = (): void => {
  agentRunMutationCounts.clear();
};

const pruneExpiredWriteCounters = (nowMs: number): void => {
  for (const [key, entry] of agentRunMutationCounts.entries()) {
    if (nowMs - entry.ts > WRITE_LIMIT_TTL_MS) {
      agentRunMutationCounts.delete(key);
    }
  }
};

const resolveWriteRunKey = (ctx: ToolExecutionContext): string =>
  ctx.operationId || ctx.parentMessageId || `${ctx.userId}:${ctx.topicId ?? 'no-topic'}`;

const checkAndConsumeWriteSlot = (ctx: ToolExecutionContext): ToolExecutionResult | null => {
  const nowMs = Date.now();
  pruneExpiredWriteCounters(nowMs);

  const key = resolveWriteRunKey(ctx);
  const current = agentRunMutationCounts.get(key);
  const count = current?.count ?? 0;

  if (count >= MAX_AGENT_WRITES_PER_RUN) {
    return {
      content: WRITE_LIMIT_REACHED_MESSAGE,
      success: false,
    };
  }

  agentRunMutationCounts.set(key, { count: count + 1, ts: nowMs });
  return null;
};

const validateEntryGuard = (ctx: ToolExecutionContext): ToolExecutionResult | null => {
  if (!isWorkspaceEnabled()) {
    return {
      content: 'Project workspace is currently disabled.',
      success: false,
    };
  }

  if (ctx.dataGuardProtected === true) {
    return {
      content: 'Project workspace is disabled in Data Guard protected mode.',
      success: false,
    };
  }

  if (!ctx.serverDB || !ctx.userId || !ctx.agentId) {
    return {
      content: 'Authenticated project agent context is required.',
      success: false,
    };
  }

  return null;
};

const buildChangeMarkerLine = (params: {
  action: 'created' | 'deleted' | 'restored' | 'updated';
  addedLines: number;
  agentId: string;
  path: string;
  prevRevision: number | null;
  removedLines: number;
  revision: number;
  workspaceFileId: string;
}): string => {
  const payload = {
    workspaceFileId: params.workspaceFileId,
    agentId: params.agentId,
    path: params.path,
    action: params.action,
    prevRevision: params.prevRevision,
    revision: params.revision,
    addedLines: params.addedLines,
    removedLines: params.removedLines,
    authorType: 'agent' as const,
  };
  return `${WORKSPACE_CHANGE_MARKER_PREFIX}${JSON.stringify(payload)}`;
};

const buildProposalMarkerLine = (proposal: WorkspaceProposalDto): string => {
  const payload = {
    proposalId: proposal.id,
    agentId: proposal.agentId,
    workspaceFileId: proposal.workspaceFileId,
    targetPath: proposal.targetPath,
    proposalType: proposal.proposalType,
    baseRevision: proposal.baseRevision,
    reason: proposal.reason ?? '',
    addedLines: proposal.addedLines,
    removedLines: proposal.removedLines,
    diffPreview: proposal.diffPreview ?? '',
  };
  return `${WORKSPACE_PROPOSAL_MARKER_PREFIX}${JSON.stringify(payload)}`;
};

const formatProposalOutcome = (proposal: WorkspaceProposalDto, diffSummary?: string): string => {
  const lines = [
    `File "${proposal.targetPath}" is protected (AGENTS.md, rules/**, pinned rule, or locked). Active file version was NOT modified; created change proposal "${proposal.id}" (${proposal.proposalType}, +${proposal.addedLines}/-${proposal.removedLines} lines) with status pending_user_approval. Do NOT retry writing the same change — ask or wait for the user to review and apply it.`,
  ];
  if (diffSummary) {
    lines.push(diffSummary);
  }
  lines.push(buildProposalMarkerLine(proposal));
  return lines.join('\n');
};

const formatAgentWriteOutcome = (res: AgentWriteOutcome): ToolExecutionResult => {
  if (res.outcome === 'proposal_created') {
    return {
      content: formatProposalOutcome(res.proposal, res.diffSummary),
      state: { outcome: 'proposal_created', proposal: res.proposal },
      success: true,
    };
  }

  const revTransition =
    res.prevRevision !== null
      ? `v${res.prevRevision} -> v${res.file.currentRevision}`
      : `v${res.file.currentRevision}`;
  const summaryLines = [
    `Workspace file "${res.file.path}" ${res.outcome} (${revTransition}, +${res.addedLines}/-${res.removedLines} lines).`,
  ];
  if (res.diffSummary) {
    summaryLines.push(res.diffSummary);
  }
  summaryLines.push(
    buildChangeMarkerLine({
      action: res.outcome,
      addedLines: res.addedLines,
      agentId: res.file.agentId,
      path: res.file.path,
      prevRevision: res.prevRevision,
      removedLines: res.removedLines,
      revision: res.file.currentRevision,
      workspaceFileId: res.file.id,
    }),
  );

  return {
    content: summaryLines.join('\n'),
    state: {
      addedLines: res.addedLines,
      budget: res.budget,
      file: res.file,
      outcome: res.outcome,
      prevRevision: res.prevRevision,
      removedLines: res.removedLines,
    },
    success: true,
  };
};

const formatDeleteOutcome = (agentId: string, res: WorkspaceDeleteOutcome): ToolExecutionResult => {
  if (res.outcome === 'proposal_created') {
    return {
      content: formatProposalOutcome(res.proposal),
      state: { outcome: 'proposal_created', proposal: res.proposal },
      success: true,
    };
  }

  const content = [
    `Deleted workspace file "${res.path}" (was v${res.revision}).`,
    buildChangeMarkerLine({
      action: 'deleted',
      addedLines: 0,
      agentId,
      path: res.path,
      prevRevision: res.revision,
      removedLines: 0,
      revision: res.revision,
      workspaceFileId: res.workspaceFileId,
    }),
  ].join('\n');

  return {
    content,
    state: {
      budget: res.budget,
      outcome: 'deleted',
      path: res.path,
      revision: res.revision,
      workspaceFileId: res.workspaceFileId,
    },
    success: true,
  };
};

const buildReadPageState = (params: {
  kind?: 'document' | 'text';
  page: FileReadPage;
  path: string;
  revision: number;
  workspaceFileId: string;
}) => ({
  complete: params.page.complete,
  endLine: params.page.endLine,
  endOffset: params.page.endOffset,
  ...(params.kind ? { kind: params.kind } : {}),
  nextOffset: params.page.nextOffset,
  nextStartLine: params.page.nextStartLine,
  path: params.path,
  revision: params.revision,
  startLine: params.page.startLine,
  startOffset: params.page.startOffset,
  totalCharCount: params.page.totalCharCount,
  totalLines: params.page.totalLines,
  workspaceFileId: params.workspaceFileId,
});

const formatReadPageSummary = (
  path: string,
  revision: number,
  page: FileReadPage,
  wrappedContent: string,
): string => {
  const hasMore = !page.complete;
  const headerParts = [`File: ${path} (v${revision})`];
  if (page.startLine !== undefined && page.endLine !== undefined) {
    headerParts.push(
      page.totalLines !== undefined
        ? `lines ${page.startLine}-${page.endLine} of ${page.totalLines}`
        : `lines ${page.startLine}-${page.endLine}`,
    );
  } else if (page.totalLines !== undefined) {
    headerParts.push(`${page.totalLines} lines`);
  }
  headerParts.push(`chars ${page.startOffset}-${page.endOffset} of ${page.totalCharCount}`);

  if (hasMore) {
    if (page.nextStartLine !== undefined && page.nextStartLine !== null) {
      headerParts.push(`nextStartLine=${page.nextStartLine}`);
    } else if (page.nextOffset !== null) {
      headerParts.push(`nextOffset=${page.nextOffset}`);
    }
  }
  if (page.totalMatches !== undefined) {
    headerParts.push(`totalMatches=${page.totalMatches}`);
  }

  const lines = [headerParts.join(' | ')];
  if (page.matches && page.matches.length > 0) {
    const matchLines = page.matches
      .slice(0, 20)
      .map((m) => `  L${m.line} (offset ${m.offset}): ${m.preview}`);
    lines.push(`Matches:\n${matchLines.join('\n')}`);
  }
  lines.push(wrappedContent);
  return lines.join('\n');
};

const formatWorkspaceErrorResult = (error: unknown): ToolExecutionResult => {
  if (error instanceof WorkspaceError) {
    const lines = [`Workspace error [${error.code}]: ${error.message}`];
    if (error.details && Object.keys(error.details).length > 0) {
      lines.push(`Details: ${JSON.stringify(error.details)}`);
    }
    if (
      error.code === 'REVISION_CONFLICT' ||
      error.code === 'FILE_ALREADY_EXISTS' ||
      error.code === 'PATCH_FAILED'
    ) {
      lines.push(
        'Call readProjectFile to inspect the latest revision and exact lines before retrying.',
      );
    }
    return {
      content: lines.join('\n'),
      error: {
        code: error.code,
        ...(error.details ? { details: error.details } : {}),
        message: error.message,
      },
      success: false,
    };
  }

  const msg = error instanceof Error ? error.message : String(error);
  return {
    content: `Workspace operation failed: ${msg}`,
    error: { message: msg },
    success: false,
  };
};

const formatFileLine = (f: WorkspaceFileDto): string => {
  const metric = f.lineCount !== null ? `${f.lineCount} lines` : `${f.byteSize} B`;
  const flags: string[] = [`mode=${f.loadMode}`];
  if (f.isProtected) flags.push('protected');
  if (f.kind === 'document') flags.push('document');
  if (f.ragEnabled) flags.push(`rag=${f.indexingStatus}`);
  const summary = f.userSummary ? ` — ${f.userSummary}` : '';
  return `- ${f.path} (id=${f.id}, v${f.currentRevision}, ${metric}, ${flags.join(', ')})${summary}`;
};

const tryReadParsedDocumentPage = async (
  ctx: ToolExecutionContext,
  args: {
    maxLines?: number;
    offset?: number;
    path?: string;
    query?: string;
    revision?: number;
    startLine?: number;
    workspaceFileId?: string;
  },
): Promise<ToolExecutionResult | null> => {
  const db = ctx.serverDB as any;
  if (typeof db?.select !== 'function' || !ctx.userId || !ctx.agentId) return null;

  let row;
  if (args.workspaceFileId) {
    const rows = await db
      .select()
      .from(projectWorkspaceFiles)
      .where(
        and(
          eq(projectWorkspaceFiles.id, args.workspaceFileId),
          eq(projectWorkspaceFiles.agentId, ctx.agentId),
          eq(projectWorkspaceFiles.userId, ctx.userId),
          args.revision === undefined ? isNull(projectWorkspaceFiles.deletedAt) : undefined,
        ),
      )
      .limit(1);
    row = rows[0];
  } else if (args.path) {
    const normalizedPath = normalizeWorkspacePath(args.path);
    const rows = await db
      .select()
      .from(projectWorkspaceFiles)
      .where(
        and(
          eq(projectWorkspaceFiles.agentId, ctx.agentId),
          eq(projectWorkspaceFiles.userId, ctx.userId),
          args.revision === undefined ? isNull(projectWorkspaceFiles.deletedAt) : undefined,
          sql`lower(${projectWorkspaceFiles.path}) = lower(${normalizedPath})`,
        ),
      )
      .limit(1);
    row = rows[0];
  }

  if (!row || row.kind !== 'document') return null;

  let targetFileId: string = row.currentFileId;
  let targetRevision: number = row.currentRevision;

  if (args.revision !== undefined) {
    const [revRow] = await db
      .select()
      .from(projectFileRevisions)
      .where(
        and(
          eq(projectFileRevisions.workspaceFileId, row.id),
          eq(projectFileRevisions.revision, args.revision),
        ),
      )
      .limit(1);
    if (!revRow) return null;
    targetFileId = revRow.fileId;
    targetRevision = revRow.revision;
  }

  const [doc] = await db
    .select({ content: documents.content })
    .from(documents)
    .where(and(eq(documents.fileId, targetFileId), eq(documents.userId, ctx.userId)))
    .limit(1);

  if (!doc || typeof doc.content !== 'string' || doc.content.length === 0) {
    return null;
  }

  const useOffsetMode =
    args.offset !== undefined && args.startLine === undefined && args.maxLines === undefined;
  const clampedMaxLines =
    args.maxLines !== undefined
      ? Math.min(FILE_READ_MAX_LINES, Math.max(FILE_READ_MIN_LINES, Math.floor(args.maxLines)))
      : FILE_READ_DEFAULT_MAX_LINES;

  const page = readFilePage(
    doc.content,
    useOffsetMode
      ? { offset: args.offset, query: args.query }
      : {
          maxLines: clampedMaxLines,
          query: args.query,
          startLine: args.startLine ?? 1,
        },
    FILE_READ_CHARS,
  );

  const safeBody = page.content.replaceAll(/<\/\s*project_file\s*>/gi, '&lt;/project_file&gt;');
  const escapedPath = escapeXmlAttr(row.path);
  const wrappedContent = `<project_file path="${escapedPath}" revision="${targetRevision}" encoding="utf-8" trust="untrusted_workspace_data">\n${safeBody}\n</project_file>`;

  return {
    content: formatReadPageSummary(row.path, targetRevision, page, wrappedContent),
    state: buildReadPageState({
      kind: 'document',
      page,
      path: row.path,
      revision: targetRevision,
      workspaceFileId: row.id,
    }),
    success: true,
  };
};

export const projectWorkspaceRuntime: ServerRuntimeRegistration = {
  factory: (baseContext) => ({
    async deleteProjectFile(rawArgs: unknown, callContext?: ToolExecutionContext) {
      const ctx: ToolExecutionContext = { ...baseContext, ...callContext };
      const guard = validateEntryGuard(ctx);
      if (guard) return guard;

      const args = (rawArgs ?? {}) as {
        baseRevision?: number;
        path?: string;
        reason?: string;
        workspaceFileId?: string;
      };

      if (
        ctx.agentId === 'inbox' &&
        typeof args.path === 'string' &&
        isRootAgentsMd(args.path.trim())
      ) {
        return {
          content:
            'Workspace error [INBOX_INSTRUCTION_FORBIDDEN]: Inbox agent cannot modify root AGENTS.md instructions.',
          error: { code: 'INBOX_INSTRUCTION_FORBIDDEN', message: 'Forbidden on inbox' },
          success: false,
        };
      }

      const limitError = checkAndConsumeWriteSlot(ctx);
      if (limitError) return limitError;

      try {
        const store = new ProjectWorkspaceStore(ctx.serverDB!, ctx.userId!);
        const res = await store.deleteWorkspaceFile(
          ctx.agentId!,
          { path: args.path, workspaceFileId: args.workspaceFileId },
          {
            actor: 'agent',
            baseRevision: args.baseRevision,
            messageId: ctx.messageId ?? ctx.parentMessageId,
            reason: args.reason,
            topicId: ctx.topicId,
          },
        );
        return formatDeleteOutcome(ctx.agentId!, res);
      } catch (error) {
        return formatWorkspaceErrorResult(error);
      }
    },

    async listProjectFiles(rawArgs: unknown, callContext?: ToolExecutionContext) {
      const ctx: ToolExecutionContext = { ...baseContext, ...callContext };
      const guard = validateEntryGuard(ctx);
      if (guard) return guard;

      const args = (rawArgs ?? {}) as { folder?: string; includeDisabled?: boolean };
      try {
        const store = new ProjectWorkspaceStore(ctx.serverDB!, ctx.userId!);
        const overview = await store.getWorkspaceOverview(ctx.agentId!);

        const normalizedFolder = args.folder?.trim().replaceAll(/^\/+|\/+$/g, '') ?? '';
        const folderLower = normalizedFolder.toLowerCase();

        const filtered = overview.files.filter((file) => {
          if (!args.includeDisabled && file.loadMode === 'disabled') return false;
          if (folderLower) {
            const pathLower = file.path.toLowerCase();
            return pathLower === folderLower || pathLower.startsWith(`${folderLower}/`);
          }
          return true;
        });

        const budgetLine = `Pinned rules budget: ${overview.budget.pinnedTokens}/${overview.budget.hardMaxTokens} tokens (${overview.budget.pinnedChars}/${overview.budget.hardMaxChars} chars); active files: ${overview.budget.activeFilesCount}/${overview.budget.maxFilesCount}.`;
        const content =
          filtered.length === 0
            ? `No matching files in project workspace.\n${budgetLine}`
            : [
                `Project workspace files (${filtered.length}):`,
                ...filtered.map(formatFileLine),
                budgetLine,
              ].join('\n');

        return {
          content,
          state: { budget: overview.budget, files: filtered },
          success: true,
        };
      } catch (error) {
        return formatWorkspaceErrorResult(error);
      }
    },

    async patchProjectFile(rawArgs: unknown, callContext?: ToolExecutionContext) {
      const ctx: ToolExecutionContext = { ...baseContext, ...callContext };
      const guard = validateEntryGuard(ctx);
      if (guard) return guard;

      const args = (rawArgs ?? {}) as {
        baseRevision?: number;
        changeNote?: string;
        edits?: PatchEdit[];
        path?: string;
        reason?: string;
        workspaceFileId?: string;
      };

      if (
        ctx.agentId === 'inbox' &&
        typeof args.path === 'string' &&
        isRootAgentsMd(args.path.trim())
      ) {
        return {
          content:
            'Workspace error [INBOX_INSTRUCTION_FORBIDDEN]: Inbox agent cannot modify root AGENTS.md instructions.',
          error: { code: 'INBOX_INSTRUCTION_FORBIDDEN', message: 'Forbidden on inbox' },
          success: false,
        };
      }

      const limitError = checkAndConsumeWriteSlot(ctx);
      if (limitError) return limitError;

      if (typeof args.baseRevision !== 'number' || !Number.isFinite(args.baseRevision)) {
        return {
          content:
            'Workspace error [INVALID_REVISION]: baseRevision is required for patchProjectFile.',
          error: { code: 'INVALID_REVISION', message: 'baseRevision is required' },
          success: false,
        };
      }

      try {
        const store = new ProjectWorkspaceStore(ctx.serverDB!, ctx.userId!);
        const res = await store.patchAgentTextFile(ctx.agentId!, {
          actor: 'agent',
          baseRevision: args.baseRevision,
          changeNote: args.changeNote ?? null,
          edits: Array.isArray(args.edits) ? args.edits : [],
          messageId: ctx.messageId ?? ctx.parentMessageId ?? null,
          path: args.path,
          reason: args.reason ?? null,
          topicId: ctx.topicId ?? null,
          workspaceFileId: args.workspaceFileId,
        });
        return formatAgentWriteOutcome(res);
      } catch (error) {
        return formatWorkspaceErrorResult(error);
      }
    },

    async readProjectFile(rawArgs: unknown, callContext?: ToolExecutionContext) {
      const ctx: ToolExecutionContext = { ...baseContext, ...callContext };
      const guard = validateEntryGuard(ctx);
      if (guard) return guard;

      const args = (rawArgs ?? {}) as {
        maxLines?: number;
        offset?: number;
        path?: string;
        query?: string;
        revision?: number;
        startLine?: number;
        workspaceFileId?: string;
      };

      try {
        const store = new ProjectWorkspaceStore(ctx.serverDB!, ctx.userId!);
        const res = await store.readProjectFilePage(ctx.agentId!, {
          maxLines: args.maxLines,
          offset: args.offset,
          path: args.path,
          query: args.query,
          revision: args.revision,
          startLine: args.startLine,
          workspaceFileId: args.workspaceFileId,
        });

        return {
          content: formatReadPageSummary(res.file.path, res.revision, res.page, res.wrappedContent),
          state: buildReadPageState({
            page: res.page,
            path: res.file.path,
            revision: res.revision,
            workspaceFileId: res.file.id,
          }),
          success: true,
        };
      } catch (error) {
        if (error instanceof WorkspaceError && error.code === 'INVALID_OPERATION') {
          try {
            const docFallback = await tryReadParsedDocumentPage(ctx, args);
            if (docFallback) return docFallback;
          } catch (docError) {
            return formatWorkspaceErrorResult(docError);
          }
        }
        return formatWorkspaceErrorResult(error);
      }
    },

    async searchProjectFiles(rawArgs: unknown, callContext?: ToolExecutionContext) {
      const ctx: ToolExecutionContext = { ...baseContext, ...callContext };
      const guard = validateEntryGuard(ctx);
      if (guard) return guard;

      const args = (rawArgs ?? {}) as { limit?: number; pathPrefix?: string; query?: string };
      try {
        const store = new ProjectWorkspaceStore(ctx.serverDB!, ctx.userId!);
        const res = await store.searchProjectFiles(ctx.agentId!, {
          limit: args.limit,
          pathPrefix: args.pathPrefix,
          query: args.query ?? '',
        });

        const content =
          res.totalMatchesReturned === 0
            ? `No matches found for "${args.query ?? ''}" in project text files.`
            : `Found ${res.totalMatchesReturned} match(es)${res.truncated ? ' (truncated)' : ''}:\n${res.formatted}`;

        return {
          content,
          state: {
            matches: res.matches,
            totalMatchesReturned: res.totalMatchesReturned,
            truncated: res.truncated,
          },
          success: true,
        };
      } catch (error) {
        return formatWorkspaceErrorResult(error);
      }
    },

    async writeProjectFile(rawArgs: unknown, callContext?: ToolExecutionContext) {
      const ctx: ToolExecutionContext = { ...baseContext, ...callContext };
      const guard = validateEntryGuard(ctx);
      if (guard) return guard;

      const args = (rawArgs ?? {}) as {
        baseRevision?: number;
        changeNote?: string;
        content?: string;
        encoding?: SourceTextEncoding;
        lineEnding?: SourceLineEnding;
        path?: string;
        reason?: string;
      };

      if (
        ctx.agentId === 'inbox' &&
        typeof args.path === 'string' &&
        isRootAgentsMd(args.path.trim())
      ) {
        return {
          content:
            'Workspace error [INBOX_INSTRUCTION_FORBIDDEN]: Inbox agent cannot store root AGENTS.md instructions.',
          error: { code: 'INBOX_INSTRUCTION_FORBIDDEN', message: 'Forbidden on inbox' },
          success: false,
        };
      }

      const limitError = checkAndConsumeWriteSlot(ctx);
      if (limitError) return limitError;

      try {
        const store = new ProjectWorkspaceStore(ctx.serverDB!, ctx.userId!);
        // Note: userSummary is strictly omitted so agent cannot inject text into <project_workspace_index> (H-1)
        const res = await store.writeAgentTextFile(ctx.agentId!, {
          actor: 'agent',
          baseRevision: args.baseRevision ?? null,
          changeNote: args.changeNote ?? null,
          content: typeof args.content === 'string' ? args.content : '',
          encoding: args.encoding,
          lineEnding: args.lineEnding,
          messageId: ctx.messageId ?? ctx.parentMessageId ?? null,
          path: typeof args.path === 'string' ? args.path : '',
          reason: args.reason ?? null,
          topicId: ctx.topicId ?? null,
        });
        return formatAgentWriteOutcome(res);
      } catch (error) {
        return formatWorkspaceErrorResult(error);
      }
    },
  }),
  identifier: PROJECT_WORKSPACE_TOOL,
};
