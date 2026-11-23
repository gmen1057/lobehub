/* eslint-disable unicorn/text-encoding-identifier-case */
import type { SourceLineEnding, SourceTextEncoding } from '@lobechat/file-loaders';
import { z } from 'zod';

import type {
  WorkspaceBudgetSummary,
  WorkspaceFileDto,
  WorkspaceFileKind,
  WorkspaceLoadMode,
  WorkspaceProposalDto,
  WorkspaceRevisionDto,
} from '@/server/services/projectWorkspace';

export type {
  WorkspaceBudgetSummary,
  WorkspaceFileDto,
  WorkspaceFileKind,
  WorkspaceLoadMode,
  WorkspaceProposalDto,
  WorkspaceRevisionDto,
} from '@/server/services/projectWorkspace';

const optionalPositiveIntQuery = z.preprocess(
  (value) => (value === '' || value === undefined ? undefined : value),
  z.coerce.number().int().min(1).optional(),
);

const requiredPositiveIntQuery = z.string().min(1).pipe(z.coerce.number().int().min(1));

// ==================== Param Schemas ====================

export const AgentWorkspaceParamSchema = z.object({
  agentId: z.string().min(1, 'Agent ID is required'),
});

export type AgentWorkspaceParam = z.infer<typeof AgentWorkspaceParamSchema>;

export const AgentWorkspaceFileParamSchema = z.object({
  agentId: z.string().min(1, 'Agent ID is required'),
  workspaceFileId: z.string().min(1, 'Workspace file ID is required'),
});

export type AgentWorkspaceFileParam = z.infer<typeof AgentWorkspaceFileParamSchema>;

export const AgentWorkspaceProposalParamSchema = z.object({
  agentId: z.string().min(1, 'Agent ID is required'),
  proposalId: z.string().min(1, 'Proposal ID is required'),
});

export type AgentWorkspaceProposalParam = z.infer<typeof AgentWorkspaceProposalParamSchema>;

// ==================== Query Schemas ====================

export const GetWorkspaceFileDetailQuerySchema = z.object({
  includeContent: z.enum(['0', '1', 'true', 'false']).optional(),
  revision: optionalPositiveIntQuery,
});

export type GetWorkspaceFileDetailQuery = z.infer<typeof GetWorkspaceFileDetailQuerySchema>;

export const DeleteWorkspaceFileQuerySchema = z.object({
  baseRevision: optionalPositiveIntQuery,
});

export type DeleteWorkspaceFileQuery = z.infer<typeof DeleteWorkspaceFileQuerySchema>;

export const WorkspaceDiffQuerySchema = z.object({
  fromRevision: requiredPositiveIntQuery,
  toRevision: requiredPositiveIntQuery,
});

export type WorkspaceDiffQuery = z.infer<typeof WorkspaceDiffQuerySchema>;

// ==================== Request Body Schemas ====================

export interface PutWorkspaceTextRequest {
  baseRevision?: number | null;
  changeNote?: string | null;
  content: string;
  encoding?: SourceTextEncoding | null;
  isProtected?: boolean | null;
  lineEnding?: SourceLineEnding | null;
  loadMode?: WorkspaceLoadMode | null;
  path: string;
  userSummary?: string | null;
}

export const PutWorkspaceTextSchema = z.object({
  baseRevision: z.number().int().min(0).nullish(),
  changeNote: z.string().nullish(),
  content: z.string(),
  encoding: z.enum(['utf-8', 'utf-8-bom', 'windows-1251']).nullish(),
  isProtected: z.boolean().nullish(),
  lineEnding: z.enum(['LF', 'CRLF']).nullish(),
  loadMode: z.enum(['always', 'on_demand', 'disabled']).nullish(),
  path: z.string(),
  userSummary: z.string().nullish(),
});

export interface RegisterWorkspaceFileRequest {
  baseRevision?: number | null;
  enableRag?: boolean | null;
  fileId: string;
  kind: WorkspaceFileKind;
  loadMode?: WorkspaceLoadMode | null;
  mimeType: string;
  path: string;
  userSummary?: string | null;
}

export const RegisterWorkspaceFileSchema = z.object({
  baseRevision: z.number().int().min(0).nullish(),
  enableRag: z.boolean().nullish(),
  fileId: z.string().min(1, 'fileId is required'),
  kind: z.enum(['text', 'document']),
  loadMode: z.enum(['always', 'on_demand', 'disabled']).nullish(),
  mimeType: z.string().min(1, 'mimeType is required'),
  path: z.string(),
  userSummary: z.string().nullish(),
});

export interface UpdateWorkspaceFileMetadataRequest {
  baseRevision?: number | null;
  isProtected?: boolean | null;
  loadMode?: WorkspaceLoadMode | null;
  path?: string;
  ragEnabled?: boolean | null;
  userSummary?: string | null;
}

export const UpdateWorkspaceFileMetadataSchema = z.object({
  baseRevision: z.number().int().min(1).nullish(),
  isProtected: z.boolean().nullish(),
  loadMode: z.enum(['always', 'on_demand', 'disabled']).nullish(),
  path: z.string().optional(),
  ragEnabled: z.boolean().nullish(),
  userSummary: z.string().nullish(),
});

export const DeleteWorkspaceFileBodySchema = z.object({
  baseRevision: z.number().int().min(1).nullish(),
});

export type DeleteWorkspaceFileBody = z.infer<typeof DeleteWorkspaceFileBodySchema>;

export interface RollbackWorkspaceFileRequest {
  baseRevision?: number | null;
  targetRevision: number;
}

export const RollbackWorkspaceFileSchema = z.object({
  baseRevision: z.number().int().min(1).nullish(),
  targetRevision: z.number().int().min(1),
});

// ==================== Response Types ====================

export interface WorkspaceOverviewResponse {
  budget: WorkspaceBudgetSummary;
  files: WorkspaceFileDto[];
  instructionFile: WorkspaceFileDto | null;
  pendingProposals: WorkspaceProposalDto[];
  workspaceEnabled: boolean;
}

export interface WorkspaceFileDetailResponse {
  content: string | null;
  downloadUrl: string;
  file: WorkspaceFileDto;
  revision: number;
}

export interface WorkspaceWriteResponse {
  budget: WorkspaceBudgetSummary;
  deleted: boolean;
  file: WorkspaceFileDto | null;
}

export interface WorkspaceDeleteResponse {
  budget: WorkspaceBudgetSummary;
  deleted: true;
  revision: number;
}

export interface WorkspaceRevisionsResponse {
  revisions: WorkspaceRevisionDto[];
}

export interface WorkspaceDiffResponse {
  addedLines: number;
  fromRevision: number;
  patch: string;
  path: string;
  removedLines: number;
  toRevision: number;
}

export interface WorkspaceRollbackResponse {
  budget: WorkspaceBudgetSummary;
  file: WorkspaceFileDto;
}

export interface WorkspaceApplyProposalResponse {
  alreadyApplied: boolean;
  budget: WorkspaceBudgetSummary;
  file: WorkspaceFileDto | null;
  proposal: WorkspaceProposalDto;
}

export interface WorkspaceRejectProposalResponse {
  proposal: WorkspaceProposalDto;
}
