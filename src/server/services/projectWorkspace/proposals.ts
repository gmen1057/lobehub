import type { LobeChatDatabase, Transaction } from '@lobechat/database';
import { structuredPatch } from 'diff';
import { and, desc, eq, sql } from 'drizzle-orm';

import type { ProjectFileProposalItem } from '@/database/schemas';
import { projectFileProposals } from '@/database/schemas';

import type { WorkspaceProposalDto, WorkspaceProposalStatus, WorkspaceProposalType } from './paths';
import { WorkspaceError } from './paths';

const MAX_DIFF_PREVIEW_CHARS = 2000;
const MAX_PROPOSAL_REASON_CHARS = 500;

export function countTextLines(text: string): number {
  if (!text) return 0;
  let count = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 && i < text.length - 1) {
      count++;
    }
  }
  return count;
}

export function computeUnifiedDiff(
  filePath: string,
  oldText: string,
  newText: string,
  fromLabel = 'before',
  toLabel = 'after',
): { addedLines: number; patch: string; removedLines: number } {
  const normalizedOld = oldText.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const normalizedNew = newText.replaceAll('\r\n', '\n').replaceAll('\r', '\n');

  const structured = structuredPatch(
    filePath,
    filePath,
    normalizedOld,
    normalizedNew,
    fromLabel,
    toLabel,
    { context: 3 },
  );

  let addedLines = 0;
  let removedLines = 0;
  const outputLines: string[] = [];

  for (const hunk of structured.hunks) {
    outputLines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    for (const line of hunk.lines) {
      outputLines.push(line);
      if (line.startsWith('+')) {
        addedLines++;
      } else if (line.startsWith('-')) {
        removedLines++;
      }
    }
  }

  return {
    addedLines,
    patch: outputLines.join('\n'),
    removedLines,
  };
}

export function truncateDiffPreview(patch: string, maxChars = MAX_DIFF_PREVIEW_CHARS): string {
  if (!patch) return '';
  if (patch.length <= maxChars) return patch;
  const suffix = '\n... (truncated)';
  const cut = Math.max(0, maxChars - suffix.length);
  return `${patch.slice(0, cut)}${suffix}`;
}

export function sanitizeProposalReason(reason?: string | null): string | null {
  if (!reason || typeof reason !== 'string') return null;
  const cleaned = reason
    .normalize('NFC')
    .replaceAll(/[\r\n\t]/g, ' ')
    .replaceAll(/\p{Cf}/gu, '')
    .replaceAll(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  return cleaned.length <= MAX_PROPOSAL_REASON_CHARS
    ? cleaned
    : cleaned.slice(0, MAX_PROPOSAL_REASON_CHARS).trimEnd();
}

export function toWorkspaceProposalDto(row: ProjectFileProposalItem): WorkspaceProposalDto {
  const addedLines = row.diffStats?.addedLines ?? 0;
  const removedLines = row.diffStats?.removedLines ?? 0;
  return {
    addedLines,
    agentId: row.agentId,
    baseRevision: row.baseRevision ?? null,
    createdAt: row.createdAt.toISOString(),
    diffPreview: row.diffPreview ?? null,
    diffStats: row.diffStats ?? null,
    id: row.id,
    messageId: row.messageId ?? null,
    proposalType: row.proposalType as WorkspaceProposalType,
    proposedFileId: row.proposedFileId ?? null,
    reason: row.reason ?? null,
    removedLines,
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
    status: row.status as WorkspaceProposalStatus,
    targetPath: row.targetPath,
    topicId: row.topicId ?? null,
    workspaceFileId: row.workspaceFileId ?? null,
  };
}

export async function insertWorkspaceProposal(
  tx: Transaction,
  params: {
    addedLines: number;
    agentId: string;
    baseRevision: number | null;
    diffPreview: string | null;
    messageId?: string | null;
    proposalType: WorkspaceProposalType;
    proposedFileId?: string | null;
    reason?: string | null;
    removedLines: number;
    targetPath: string;
    topicId?: string | null;
    userId: string;
    workspaceFileId?: string | null;
  },
): Promise<WorkspaceProposalDto> {
  const [inserted] = await tx
    .insert(projectFileProposals)
    .values({
      agentId: params.agentId,
      baseRevision: params.baseRevision,
      diffPreview: params.diffPreview ? truncateDiffPreview(params.diffPreview) : null,
      diffStats: {
        addedLines: params.addedLines,
        removedLines: params.removedLines,
      },
      messageId: params.messageId ?? null,
      proposalType: params.proposalType,
      proposedFileId: params.proposedFileId ?? null,
      reason: sanitizeProposalReason(params.reason),
      status: 'pending',
      targetPath: params.targetPath,
      topicId: params.topicId ?? null,
      userId: params.userId,
      workspaceFileId: params.workspaceFileId ?? null,
    })
    .returning();

  return toWorkspaceProposalDto(inserted!);
}

export async function listPendingProposalsForAgent(
  db: LobeChatDatabase,
  userId: string,
  agentId: string,
): Promise<WorkspaceProposalDto[]> {
  const rows = await db
    .select()
    .from(projectFileProposals)
    .where(
      and(
        eq(projectFileProposals.userId, userId),
        eq(projectFileProposals.agentId, agentId),
        eq(projectFileProposals.status, 'pending'),
      ),
    )
    .orderBy(desc(projectFileProposals.createdAt));

  return rows.map(toWorkspaceProposalDto);
}

export async function lockWorkspaceProposalForUpdate(
  tx: Transaction,
  userId: string,
  agentId: string,
  proposalId: string,
): Promise<ProjectFileProposalItem> {
  const rows = await tx
    .select()
    .from(projectFileProposals)
    .where(
      and(
        eq(projectFileProposals.id, proposalId),
        eq(projectFileProposals.userId, userId),
        eq(projectFileProposals.agentId, agentId),
      ),
    )
    .for('update');

  const proposal = rows[0];
  if (!proposal) {
    throw new WorkspaceError('PROPOSAL_NOT_FOUND', 'Workspace proposal not found', 404);
  }
  return proposal;
}

export function resolveNonPendingProposalErrorCode(
  status: string,
): 'PROPOSAL_EXPIRED' | 'PROPOSAL_NOT_PENDING' | 'PROPOSAL_SUPERSEDED' {
  if (status === 'superseded') return 'PROPOSAL_SUPERSEDED';
  if (status === 'expired') return 'PROPOSAL_EXPIRED';
  return 'PROPOSAL_NOT_PENDING';
}

export async function rejectWorkspaceProposal(
  db: LobeChatDatabase,
  userId: string,
  agentId: string,
  proposalId: string,
): Promise<{ proposal: WorkspaceProposalDto }> {
  return db.transaction(async (tx) => {
    const proposal = await lockWorkspaceProposalForUpdate(tx, userId, agentId, proposalId);

    if (proposal.status === 'rejected') {
      return { proposal: toWorkspaceProposalDto(proposal) };
    }

    if (proposal.status !== 'pending') {
      throw new WorkspaceError(
        resolveNonPendingProposalErrorCode(proposal.status),
        `Cannot reject proposal in status "${proposal.status}"`,
        409,
        { proposalId: proposal.id, proposalStatus: proposal.status, status: proposal.status },
      );
    }

    const [updated] = await tx
      .update(projectFileProposals)
      .set({
        resolvedAt: sql`now()`,
        status: 'rejected',
      })
      .where(eq(projectFileProposals.id, proposal.id))
      .returning();

    return { proposal: toWorkspaceProposalDto(updated!) };
  });
}
