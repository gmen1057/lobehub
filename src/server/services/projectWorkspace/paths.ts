/* eslint-disable unicorn/text-encoding-identifier-case */
export type WorkspaceHttpStatus = 400 | 403 | 404 | 409 | 413 | 415 | 422;

export type WorkspaceErrorCode =
  | 'AGENT_NOT_FOUND'
  | 'BINARY_CONTENT'
  | 'DOCUMENT_CANNOT_BE_PINNED'
  | 'FILE_ALREADY_EXISTS'
  | 'FILE_NOT_FOUND'
  | 'FILE_TOO_LARGE'
  | 'FORBIDDEN'
  | 'INBOX_INSTRUCTION_FORBIDDEN'
  | 'INVALID_ENCODING'
  | 'INVALID_LOAD_MODE'
  | 'INVALID_OPERATION'
  | 'INVALID_PATCH'
  | 'INVALID_PATH'
  | 'INVALID_REVISION'
  | 'INVALID_SUMMARY'
  | 'MALWARE_SIGNATURE'
  | 'PATCH_FAILED'
  | 'PINNED_BUDGET_EXCEEDED'
  | 'PROPOSAL_NOT_FOUND'
  | 'PROTECTED_FILE'
  | 'QUOTA_EXCEEDED'
  | 'REVISION_CONFLICT'
  | 'UNSUPPORTED_DOCUMENT_EXTENSION'
  | 'UNSUPPORTED_TEXT_EXTENSION'
  | 'WORKSPACE_DISABLED';

export type WorkspaceFileKind = 'document' | 'text';
export type WorkspaceLoadMode = 'always' | 'disabled' | 'on_demand';
export type WorkspaceCreatedBy = 'agent' | 'migration' | 'sandbox' | 'user';
export type WorkspaceUpdatedBy =
  'agent' | 'migration' | 'proposal_approved' | 'rollback' | 'sandbox' | 'user';
export type WorkspaceIndexingStatus = 'error' | 'indexing' | 'none' | 'ready';
export type WorkspaceDataGuardStatus = 'scrubbed' | 'unmasked';
export type WorkspaceProposalType = 'create_pinned' | 'delete' | 'edit';
export type WorkspaceProposalStatus = 'applied' | 'pending' | 'rejected' | 'superseded';

export interface WorkspaceFileDto {
  agentId: string;
  byteSize: number;
  charCount: number | null;
  createdAt: string;
  createdBy: WorkspaceCreatedBy;
  currentFileId: string;
  currentRevision: number;
  dataGuardStatus: WorkspaceDataGuardStatus;
  encoding: 'utf-8' | 'utf-8-bom' | 'windows-1251' | null;
  estimatedTokens: number;
  id: string;
  indexingError: string | null;
  indexingStatus: WorkspaceIndexingStatus;
  isProtected: boolean;
  kind: WorkspaceFileKind;
  lineCount: number | null;
  lineEnding: 'CRLF' | 'LF' | null;
  loadMode: WorkspaceLoadMode;
  loadPriority: number;
  mimeType: string;
  path: string;
  ragEnabled: boolean;
  updatedAt: string;
  updatedBy: WorkspaceUpdatedBy;
  userSummary: string | null;
}

export interface WorkspaceBudgetSummary {
  activeBytes: number;
  activeFilesCount: number;
  hardMaxChars: number;
  hardMaxTokens: number;
  maxActiveBytes: number;
  maxFilesCount: number;
  pinnedChars: number;
  pinnedTokens: number;
  softWarnTokens: number;
}

export interface WorkspaceRevisionDto {
  authorType: string;
  byteSize: number;
  changeNote: string | null;
  createdAt: string;
  diffStats: { addedLines: number; removedLines: number } | null;
  id: string;
  lineCount: number | null;
  messageId: string | null;
  revision: number;
  topicId: string | null;
}

export interface WorkspaceProposalDto {
  addedLines: number;
  agentId: string;
  baseRevision: number | null;
  createdAt: string;
  diffPreview: string | null;
  diffStats: { addedLines: number; removedLines: number } | null;
  id: string;
  messageId: string | null;
  proposalType: WorkspaceProposalType;
  proposedFileId: string | null;
  reason: string | null;
  removedLines: number;
  resolvedAt: string | null;
  status: WorkspaceProposalStatus;
  targetPath: string;
  topicId: string | null;
  workspaceFileId: string | null;
}

export class WorkspaceError extends Error {
  readonly code: WorkspaceErrorCode;
  readonly details?: Record<string, unknown>;
  readonly httpStatus: WorkspaceHttpStatus;
  readonly status: WorkspaceHttpStatus;

  constructor(
    code: WorkspaceErrorCode,
    message: string,
    httpStatus: WorkspaceHttpStatus,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'WorkspaceError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.status = httpStatus;
    this.details = details;
  }
}

export const MAX_WORKSPACE_PATH_LENGTH = 200;
export const MAX_WORKSPACE_SEGMENT_LENGTH = 100;
export const MAX_WORKSPACE_PATH_DEPTH = 5;
export const MAX_USER_SUMMARY_LENGTH = 120;
export const MAX_CHANGE_NOTE_LENGTH = 240;

const ALLOWED_LOAD_MODES = new Set<string>(['always', 'disabled', 'on_demand']);

const WINDOWS_RESERVED_SEGMENT_NAMES = new Set<string>([
  'AUX',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'CON',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
  'NUL',
  'PRN',
]);

const hasControlOrFormatChar = (value: string): boolean => {
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp <= 0x1f || cp === 0x7f) return true;
  }
  return /\p{Cf}/u.test(value);
};

const hasForbiddenPathChars = (value: string): boolean => /[<>:"|?*]/.test(value);

/**
 * Validates and normalizes a workspace POSIX relative path (`H-6`, Master Contract §2).
 */
export function normalizeWorkspacePath(rawPath: string): string {
  if (typeof rawPath !== 'string') {
    throw new WorkspaceError('INVALID_PATH', 'Workspace path must be a string', 400);
  }

  const normalized = rawPath.normalize('NFC');

  if (normalized.length === 0) {
    throw new WorkspaceError('INVALID_PATH', 'Workspace path must not be empty', 400);
  }

  if (normalized.length > MAX_WORKSPACE_PATH_LENGTH) {
    throw new WorkspaceError(
      'INVALID_PATH',
      `Workspace path exceeds ${MAX_WORKSPACE_PATH_LENGTH} characters`,
      400,
    );
  }

  if (normalized.startsWith('/') || normalized.endsWith('/')) {
    throw new WorkspaceError('INVALID_PATH', 'Workspace path must not start or end with "/"', 400);
  }

  if (normalized.includes('\\')) {
    throw new WorkspaceError('INVALID_PATH', 'Workspace path must not contain backslashes', 400);
  }

  if (hasControlOrFormatChar(normalized)) {
    throw new WorkspaceError(
      'INVALID_PATH',
      'Workspace path contains disallowed control or invisible Unicode format characters',
      400,
    );
  }

  if (hasForbiddenPathChars(normalized)) {
    throw new WorkspaceError(
      'INVALID_PATH',
      'Workspace path contains disallowed characters (<>:"|?*)',
      400,
    );
  }

  const segments = normalized.split('/');
  if (segments.length > MAX_WORKSPACE_PATH_DEPTH) {
    throw new WorkspaceError(
      'INVALID_PATH',
      `Workspace path depth exceeds maximum of ${MAX_WORKSPACE_PATH_DEPTH} segments`,
      400,
    );
  }

  for (const seg of segments) {
    if (seg.length === 0) {
      throw new WorkspaceError('INVALID_PATH', 'Workspace path contains an empty segment', 400);
    }

    if (seg.length > MAX_WORKSPACE_SEGMENT_LENGTH) {
      throw new WorkspaceError(
        'INVALID_PATH',
        `Workspace path segment exceeds ${MAX_WORKSPACE_SEGMENT_LENGTH} characters`,
        400,
      );
    }

    if (seg === '.' || seg === '..') {
      throw new WorkspaceError(
        'INVALID_PATH',
        'Workspace path must not contain "." or ".." segments',
        400,
      );
    }

    if (seg !== seg.trim() || /^\s|\s$/u.test(seg)) {
      throw new WorkspaceError(
        'INVALID_PATH',
        'Workspace path segment must not have leading or trailing whitespace',
        400,
      );
    }

    if (seg.endsWith('.')) {
      throw new WorkspaceError(
        'INVALID_PATH',
        'Workspace path segment must not end with a trailing dot',
        400,
      );
    }

    if (seg.toLowerCase() === '.git') {
      throw new WorkspaceError('INVALID_PATH', 'Workspace path must not use ".git" segment', 400);
    }

    const dotIndex = seg.indexOf('.');
    const stem = (dotIndex >= 0 ? seg.slice(0, dotIndex) : seg).toUpperCase();
    if (stem && WINDOWS_RESERVED_SEGMENT_NAMES.has(stem)) {
      throw new WorkspaceError(
        'INVALID_PATH',
        `Workspace path segment "${seg}" uses a reserved device name`,
        400,
      );
    }
  }

  return normalized;
}

export function isRootAgentsMd(normalizedPath: string): boolean {
  return normalizedPath.toLowerCase() === 'agents.md';
}

export function isAutoProtectedPath(normalizedPath: string, loadMode?: string): boolean {
  const lower = normalizedPath.toLowerCase();
  return (
    lower === 'agents.md' ||
    lower.endsWith('/agents.md') ||
    lower === 'claude.md' ||
    lower.endsWith('/claude.md') ||
    lower.startsWith('rules/') ||
    lower.includes('/rules/') ||
    loadMode === 'always'
  );
}

export function resolveEffectiveProtection(
  normalizedPath: string,
  loadMode: string,
  requestedIsProtected?: boolean,
): boolean {
  if (isAutoProtectedPath(normalizedPath, loadMode)) return true;
  return Boolean(requestedIsProtected);
}

export function validateWorkspaceLoadMode(
  normalizedPath: string,
  loadMode: string,
): asserts loadMode is WorkspaceLoadMode {
  if (!ALLOWED_LOAD_MODES.has(loadMode)) {
    throw new WorkspaceError(
      'INVALID_LOAD_MODE',
      `Invalid loadMode "${loadMode}"; expected always, on_demand, or disabled`,
      422,
    );
  }

  if (isRootAgentsMd(normalizedPath) && loadMode === 'on_demand') {
    throw new WorkspaceError(
      'INVALID_LOAD_MODE',
      'Root AGENTS.md cannot use on_demand load mode; use always or disabled',
      422,
    );
  }
}

const cleanInlineControlChars = (input: string): string => {
  let out = '';
  for (const ch of input) {
    const cp = ch.codePointAt(0) ?? 0;
    if (ch === '\r' || ch === '\n' || ch === '\t') {
      out += ' ';
      continue;
    }
    if (cp <= 0x1f || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)) {
      continue;
    }
    out += ch;
  }
  return out;
};

export function sanitizeUserSummary(raw?: string | null): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw !== 'string') {
    throw new WorkspaceError('INVALID_SUMMARY', 'User summary must be a string', 422);
  }

  const normalized = raw.normalize('NFC');
  if (normalized.length > MAX_USER_SUMMARY_LENGTH) {
    throw new WorkspaceError(
      'INVALID_SUMMARY',
      `User summary must not exceed ${MAX_USER_SUMMARY_LENGTH} characters`,
      422,
    );
  }

  const cleaned = cleanInlineControlChars(normalized)
    .replaceAll(/\p{Cf}/gu, '')
    .replaceAll(/[<>"']/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();

  if (!cleaned) return null;
  if (cleaned.length > MAX_USER_SUMMARY_LENGTH) {
    throw new WorkspaceError(
      'INVALID_SUMMARY',
      `User summary must not exceed ${MAX_USER_SUMMARY_LENGTH} characters`,
      422,
    );
  }

  return cleaned;
}

export function sanitizeChangeNote(raw?: string | null): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw !== 'string') return null;

  const cleaned = cleanInlineControlChars(raw.normalize('NFC'))
    .replaceAll(/\p{Cf}/gu, '')
    .replaceAll(/\s+/g, ' ')
    .trim();

  if (!cleaned) return null;
  return cleaned.length <= MAX_CHANGE_NOTE_LENGTH
    ? cleaned
    : cleaned.slice(0, MAX_CHANGE_NOTE_LENGTH).trimEnd();
}

export function escapeXmlAttr(raw: string): string {
  return cleanInlineControlChars(raw)
    .replaceAll(/\p{Cf}/gu, '')
    .trim()
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
