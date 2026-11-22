import debug from 'debug';

import { BaseProcessor } from '../base/BaseProcessor';
import type { Message, PipelineContext, ProcessorOptions } from '../types';

export const RECENT_UNCOMPACTED_USER_TURNS = 3;
export const MIN_ARTIFACT_BODY_TO_COMPACT = 800;
export const MAX_OLD_TOOL_CONTENT_CHARS = 4000;
export const MAX_OLD_TOOL_ARGUMENTS_CHARS = 4000;
export const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

const TOOL_CONTENT_HEAD_CHARS = 1200;
const TOOL_CONTENT_TAIL_CHARS = 400;
const TOOL_ARG_STRING_LIMIT = 1500;
const TOOL_ARG_HEAD_CHARS = 600;
const TOOL_ARG_TAIL_CHARS = 200;

const DEFAULT_WARM_MIN_SAVED_CHARS = 4000;
const DEFAULT_WARM_BREAK_EVEN_RATIO = 0.35;
const DEFAULT_WARM_MAX_DEFERRED_TURNS = 3;

const TEXT_FILE_RECEIPT_PREFIX = 'ARCKEP_TEXT_FILE_V1\n';
const LOADING_FLAT = '...';
const PLUGIN_SCHEMA_SEPARATOR = '____';

const ARTIFACT_BLOCK_RE = /(<lobeArtifact\b([^>]*)(?<!\/)>)([\s\S]*?)(<\/lobeArtifact>)/g;
const IDENTIFIER_ATTR_RE = /\bidentifier\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
const FILE_BLOCK_RE = /<file\b([^>]*)(?:\/>|>([\s\S]*?)<\/file>)/g;
const FILE_ID_ATTR_RE = /\bid\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
const FILE_ERROR_ATTR_RE = /\berror\s*=\s*(?:"[^"]*"|'[^']*')/i;
const COVERAGE_BLOCK_RE = /<coverage>([\s\S]*?)<\/coverage>/;
const SKILL_NAME_XML_RE = /<skill\b[^>]+?\bname\s*=\s*(?:"([^"]+)"|'([^']+)')/i;
const UPSERTED_DOC_RE = /^Upserted document "([^"]+)" \(([^)]+)\)\./;
const UPDATED_REMOVED_DOC_RE = /^(?:Updated|Removed) document ([^\s.]+)\./;

export interface ArckepToolResultTrimConfig {
  cacheTtlMs?: number;
  cacheWarm?: boolean;
  enabled?: boolean;
  recentUserTurns?: number;
  warmBreakEvenRatio?: number;
  warmMaxDeferredTurns?: number;
  warmMinSavedChars?: number;
}

export interface ArckepToolResultTrimMetadata {
  artifactsCompacted: number;
  cacheWarm: boolean;
  cutoffIndex: number;
  deduplicatedCount: number;
  lastUserIndex: number;
  savedChars: number;
  toolArgsTrimmed: number;
  toolResultsTrimmed: number;
}

declare module '../types' {
  interface PipelineContextMetadataOverrides {
    arckepToolResultTrim?: ArckepToolResultTrimMetadata;
  }
}

const log = debug('context-engine:processor:ArckepToolResultTrimProcessor');

interface ParsedArtifactBlock {
  body: string;
  closeTag: string;
  end: number;
  identifier: string;
  openTag: string;
  start: number;
}

interface ResolvedToolCallInfo {
  apiName: string;
  argumentsRaw: string;
  assistantIndex: number;
  callOrder: number;
  identifier: string;
  parsedArgs: Record<string, unknown> | null;
}

interface IndexedToolMessage {
  activateSkillName?: string;
  agentDocFilename?: string;
  agentDocId?: string;
  agentDocMutation?: boolean;
  agentDocOffset?: number;
  agentDocQuery?: string;
  agentDocRead?: boolean;
  apiName: string;
  argumentsRaw: string;
  assistantIndex: number;
  callOrder: number;
  identifier: string;
  index: number;
  isError: boolean;
  isProtectedTextFile: boolean;
  listModelsKey?: string;
  parsedArgs: Record<string, unknown> | null;
  readKnowledgeKey?: string;
}

interface PrefixEvalResult {
  artifactsCompacted: number;
  deduplicatedCount: number;
  messages: Message[];
  savedChars: number;
  toolArgsTrimmed: number;
  toolResultsTrimmed: number;
}

const compactStringValue = (value: string, head: number, tail: number, label: string): string =>
  `${value.slice(0, head)}\n…[${label} (${value.length} знаков) из прежнего шага сокращён]…\n${value.slice(-tail)}`;

const safeParseJsonObject = (raw: string | undefined): Record<string, unknown> | null => {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

const canonicalizeJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return Object.fromEntries(entries.map(([k, v]) => [k, canonicalizeJson(v)]));
  }
  return value;
};

const parseToolName = (
  rawName: string | undefined,
): { apiName: string; identifier: string } | null => {
  if (!rawName || typeof rawName !== 'string') return null;
  if (rawName.includes(PLUGIN_SCHEMA_SEPARATOR)) {
    const parts = rawName.split(PLUGIN_SCHEMA_SEPARATOR);
    if (parts.length >= 2 && parts[0] && parts[1]) {
      return { apiName: parts[1], identifier: parts[0] };
    }
  }
  const dotIdx = rawName.indexOf('.');
  if (dotIdx > 0 && dotIdx < rawName.length - 1) {
    return {
      apiName: rawName.slice(dotIdx + 1),
      identifier: rawName.slice(0, dotIdx),
    };
  }
  return null;
};

const isProtectedTextFileTool = (
  identifier: string,
  apiName: string,
  rawName?: string,
): boolean => {
  if (identifier === 'arckep-text-file' || apiName === 'writePart') return true;
  if (typeof rawName === 'string' && rawName.startsWith('arckep-text-file____')) return true;
  return false;
};

const compactToolArgumentsJson = (rawArgs: string): string => {
  if (rawArgs.length <= MAX_OLD_TOOL_ARGUMENTS_CHARS) return rawArgs;
  try {
    const parsed = JSON.parse(rawArgs);
    if (!parsed || typeof parsed !== 'object') return rawArgs;

    let changed = false;
    const shrink = (val: unknown): unknown => {
      if (typeof val === 'string' && val.length > TOOL_ARG_STRING_LIMIT) {
        changed = true;
        return compactStringValue(val, TOOL_ARG_HEAD_CHARS, TOOL_ARG_TAIL_CHARS, 'параметр вызова');
      }
      if (Array.isArray(val)) return val.map(shrink);
      if (val && typeof val === 'object') {
        return Object.fromEntries(
          Object.entries(val as Record<string, unknown>).map(([k, v]) => [k, shrink(v)]),
        );
      }
      return val;
    };

    const compacted = shrink(parsed);
    if (!changed) return rawArgs;
    const serialized = JSON.stringify(compacted);
    return serialized.length < rawArgs.length ? serialized : rawArgs;
  } catch {
    return rawArgs;
  }
};

const findInlineArtifactBlocks = (text: string): ParsedArtifactBlock[] => {
  if (!text.includes('<lobeArtifact')) return [];
  const blocks: ParsedArtifactBlock[] = [];
  for (const match of text.matchAll(ARTIFACT_BLOCK_RE)) {
    const openTag = match[1];
    const attrs = match[2] ?? '';
    const body = match[3] ?? '';
    const closeTag = match[4];
    if (body.trim().length < MIN_ARTIFACT_BODY_TO_COMPACT) continue;
    // Tags with external src="..." and no real inline body do not supersede full inline versions
    if (/\bsrc\s*=\s*(?:"[^"]+"|'[^']+')/i.test(attrs) && body.trim().length === 0) continue;
    const idMatch = IDENTIFIER_ATTR_RE.exec(attrs);
    const identifier = (idMatch?.[1] ?? idMatch?.[2] ?? '').trim();
    if (!identifier) continue;
    const start = match.index ?? 0;
    blocks.push({
      body,
      closeTag,
      end: start + match[0].length,
      identifier,
      openTag,
      start,
    });
  }
  return blocks;
};

const collectNonUserIds = (initialMessages: unknown[] | undefined): Set<string> => {
  const nonUserIds = new Set<string>();
  if (!Array.isArray(initialMessages)) return nonUserIds;

  const visitItem = (item: any, impliedNonUser = false) => {
    if (!item || typeof item !== 'object') return;
    const isNonUser = impliedNonUser || (typeof item.role === 'string' && item.role !== 'user');

    if (isNonUser && typeof item.id === 'string' && item.id) {
      nonUserIds.add(item.id);
    }

    if (Array.isArray(item.tools)) {
      for (const tool of item.tools) {
        if (tool?.result?.id && typeof tool.result.id === 'string') {
          nonUserIds.add(tool.result.id);
        }
      }
    }

    if (Array.isArray(item.children)) {
      for (const child of item.children) {
        visitItem(child, true);
      }
    }

    if (Array.isArray(item.members)) {
      for (const member of item.members) {
        visitItem(member, true);
      }
    }

    if (Array.isArray(item.tasks)) {
      for (const task of item.tasks) {
        visitItem(task, true);
      }
    }
  };

  for (const msg of initialMessages) {
    visitItem(msg, false);
  }

  return nonUserIds;
};

const startsWithCompressedSummary = (content: unknown): boolean => {
  if (typeof content === 'string') {
    return content.startsWith('<compressed_history_summary>');
  }
  if (Array.isArray(content)) {
    const firstText = content.find(
      (part: any) => part?.type === 'text' && typeof part.text === 'string',
    );
    return Boolean(firstText?.text?.startsWith('<compressed_history_summary>'));
  }
  return false;
};

const parseTimestampValue = (val: unknown): number | undefined => {
  if (typeof val === 'number') {
    return Number.isFinite(val) && val > 0 ? val : undefined;
  }
  if (val instanceof Date) {
    const ms = val.getTime();
    return Number.isFinite(ms) && ms > 0 ? ms : undefined;
  }
  if (typeof val === 'string' && val.trim().length > 0) {
    const asNum = Number(val);
    if (Number.isFinite(asNum) && asNum > 0) return asNum;
    const ms = new Date(val).getTime();
    return Number.isFinite(ms) && ms > 0 ? ms : undefined;
  }
  return undefined;
};

const getMessageTimestampMs = (msg: any, preferCreated: boolean): number | undefined => {
  if (!msg || typeof msg !== 'object') return undefined;
  const primary = preferCreated ? msg.createdAt : msg.updatedAt;
  const secondary = preferCreated ? msg.updatedAt : msg.createdAt;
  return parseTimestampValue(primary) ?? parseTimestampValue(secondary);
};

const isLoadingPlaceholder = (msg: any): boolean =>
  msg?.role === 'assistant' &&
  msg?.content === LOADING_FLAT &&
  !(Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) &&
  !(Array.isArray(msg.tools) && msg.tools.length > 0);

const estimateMessageChars = (msg: any): number => {
  if (!msg || typeof msg !== 'object') return 0;
  let total = 0;

  if (typeof msg.content === 'string') {
    total += msg.content.length;
  } else if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (typeof part?.text === 'string') total += part.text.length;
      else if (typeof part?.thinking === 'string') total += part.thinking.length;
    }
  }

  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
    for (const tc of msg.tool_calls) {
      total += (tc?.function?.name?.length ?? 0) + (tc?.function?.arguments?.length ?? 0);
    }
  } else if (Array.isArray(msg.tools) && msg.tools.length > 0) {
    for (const t of msg.tools) {
      total +=
        (t?.identifier?.length ?? 0) + (t?.apiName?.length ?? 0) + (t?.arguments?.length ?? 0);
    }
  }

  if (typeof msg.reasoning?.content === 'string') {
    total += msg.reasoning.content.length;
  }

  return total;
};

const detectToolMessageError = (msg: any): boolean => {
  if (!msg || typeof msg !== 'object') return true;
  if (msg.pluginError) return true;
  if (
    msg.pluginState &&
    typeof msg.pluginState === 'object' &&
    (msg.pluginState.success === false || Boolean(msg.pluginState.error))
  ) {
    return true;
  }

  if (typeof msg.content !== 'string') return false;
  const trimmed = msg.content.trim();
  if (trimmed.length === 0) return true;

  if (trimmed.startsWith('{')) {
    const parsed = safeParseJsonObject(trimmed);
    if (parsed && (parsed.success === false || Boolean(parsed.error))) {
      return true;
    }
  }

  const knownErrorPrefixes = [
    'Error reading knowledge:',
    'Provide between 1 and 8 file IDs.',
    'Search unavailable:',
    'Invalid document offset or limit.',
    'Use a literal query of at most 500 characters',
    'For a literal search use limit >= 2000',
    'Invalid document snapshot.',
    'Document changed since the previous page.',
    'Document not found:',
    'Cannot read agent document',
    'Cannot edit agent document',
    'Cannot upsert agent document',
    'Cannot remove agent document',
    'Cannot create agent document',
    'Cannot list agent documents',
    'Failed to upsert document:',
    'Failed to create agent document.',
    'Failed to activate tools:',
    'Failed to activate skill',
    'Skill activation is not available.',
    'Skill not found',
    'Topic not found',
    'Invalid archive snapshotAt',
  ];
  if (knownErrorPrefixes.some((prefix) => trimmed.startsWith(prefix))) {
    return true;
  }

  // If readKnowledge XML only contains self-closing <file ... error="..." /> tags
  if (trimmed.includes('<knowledge_base_files') && trimmed.includes('<file')) {
    let fileCount = 0;
    let errorCount = 0;
    for (const m of trimmed.matchAll(FILE_BLOCK_RE)) {
      fileCount++;
      if (FILE_ERROR_ATTR_RE.test(m[1] ?? '') && m[2] === undefined) {
        errorCount++;
      }
    }
    if (fileCount > 0 && fileCount === errorCount) return true;
  }

  return false;
};

const normalizeNonNegativeInt = (value: unknown, fallback = 0): number => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.max(0, Math.floor(parsed));
  }
  return fallback;
};

const normalizeOptionalInt = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.floor(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.floor(parsed);
  }
  return null;
};

const extractFirstLineJson = (content: string): Record<string, unknown> | null => {
  const nl = content.indexOf('\n');
  const firstLine = nl === -1 ? content : content.slice(0, nl);
  if (firstLine.length > 24_000) return null;
  const jsonStart = firstLine.indexOf('{');
  if (jsonStart < 0) return null;
  return safeParseJsonObject(firstLine.slice(jsonStart));
};

const extractReadKnowledgeKey = (args: Record<string, unknown> | null): string | undefined => {
  if (!args) return undefined;
  let fileIds: string[] = [];
  if (Array.isArray(args.fileIds)) {
    fileIds = args.fileIds
      .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
      .map((id) => id.trim())
      .sort();
  } else if (typeof args.fileId === 'string' && args.fileId.trim().length > 0) {
    fileIds = [args.fileId.trim()];
  }
  if (fileIds.length === 0) return undefined;
  const offset = normalizeNonNegativeInt(args.offset, 0);
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  const rawStartLine = normalizeOptionalInt(args.startLine);
  const rawMaxLines = normalizeOptionalInt(args.maxLines);
  const isLineMode = rawStartLine !== null || rawMaxLines !== null;
  const startLine = isLineMode ? Math.max(1, rawStartLine ?? 1) : null;
  const maxLines = isLineMode ? Math.min(500, Math.max(1, rawMaxLines ?? 250)) : null;
  return JSON.stringify({
    fileIds,
    ...(maxLines !== null ? { maxLines } : {}),
    offset,
    query,
    ...(startLine !== null ? { startLine } : {}),
  });
};

const buildReadKnowledgeStub = (content: string, args: Record<string, unknown> | null): string => {
  const fileCursors: Array<Record<string, unknown>> = [];

  if (content.includes('<file')) {
    for (const match of content.matchAll(FILE_BLOCK_RE)) {
      const attrs = match[1] ?? '';
      const inner = match[2];
      const idMatch = FILE_ID_ATTR_RE.exec(attrs);
      const fileId = (idMatch?.[1] ?? idMatch?.[2] ?? '').trim();
      if (inner === undefined) continue;

      const covMatch = COVERAGE_BLOCK_RE.exec(inner);
      if (covMatch?.[1]) {
        const cov = safeParseJsonObject(covMatch[1]);
        if (cov) {
          fileCursors.push({
            ...(fileId ? { fileId } : {}),
            ...(typeof cov.startOffset === 'number' ? { startOffset: cov.startOffset } : {}),
            ...(typeof cov.endOffset === 'number' ? { endOffset: cov.endOffset } : {}),
            ...(cov.nextOffset === null || typeof cov.nextOffset === 'number'
              ? { nextOffset: cov.nextOffset }
              : {}),
            ...(typeof cov.totalCharCount === 'number'
              ? { totalCharCount: cov.totalCharCount }
              : {}),
            ...(typeof cov.startLine === 'number' ? { startLine: cov.startLine } : {}),
            ...(typeof cov.endLine === 'number' ? { endLine: cov.endLine } : {}),
            ...(cov.nextStartLine === null || typeof cov.nextStartLine === 'number'
              ? { nextStartLine: cov.nextStartLine }
              : {}),
            ...(typeof cov.totalLines === 'number' ? { totalLines: cov.totalLines } : {}),
          });
          continue;
        }
      }

      const rawBody = inner.replace(/^\n/, '').replace(/\n$/, '');
      fileCursors.push({
        ...(fileId ? { fileId } : {}),
        endOffset: rawBody.length,
        nextOffset: null,
        startOffset: 0,
        totalCharCount: rawBody.length,
      });
    }
  }

  let cursor: Record<string, unknown>;
  if (fileCursors.length === 1) {
    cursor = fileCursors[0];
  } else if (fileCursors.length > 1) {
    cursor = {
      ...fileCursors[0],
      pages: fileCursors,
    };
  } else {
    const headerJson = extractFirstLineJson(content);
    const argFileIds = Array.isArray(args?.fileIds)
      ? args!.fileIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
      : typeof args?.fileId === 'string' && args.fileId.trim().length > 0
        ? [args.fileId.trim()]
        : [];
    const fallbackFileId =
      (typeof headerJson?.fileId === 'string' ? headerJson.fileId : undefined) ?? argFileIds[0];
    const startOffset =
      typeof headerJson?.startOffset === 'number'
        ? headerJson.startOffset
        : normalizeNonNegativeInt(args?.offset, 0);
    const endOffset =
      typeof headerJson?.endOffset === 'number'
        ? headerJson.endOffset
        : startOffset + content.length;
    const nextOffset =
      headerJson && (headerJson.nextOffset === null || typeof headerJson.nextOffset === 'number')
        ? headerJson.nextOffset
        : null;
    const totalCharCount =
      typeof headerJson?.totalCharCount === 'number' ? headerJson.totalCharCount : content.length;

    cursor = {
      ...(fallbackFileId ? { fileId: fallbackFileId } : {}),
      endOffset,
      nextOffset,
      startOffset,
      totalCharCount,
      ...(typeof headerJson?.startLine === 'number' ? { startLine: headerJson.startLine } : {}),
      ...(typeof headerJson?.endLine === 'number' ? { endLine: headerJson.endLine } : {}),
      ...(headerJson &&
      (headerJson.nextStartLine === null || typeof headerJson.nextStartLine === 'number')
        ? { nextStartLine: headerJson.nextStartLine }
        : {}),
      ...(typeof headerJson?.totalLines === 'number' ? { totalLines: headerJson.totalLines } : {}),
    };
  }

  const repeatHint =
    typeof cursor.startLine === 'number' ? 'fileIds and startLine' : 'fileIds and offset';
  return `Original knowledge page retained (${content.length} chars). Repeat readKnowledge with ${repeatHint} to retrieve the exact page. ${JSON.stringify(cursor)}`;
};

const buildPagedHeadTailTrim = (content: string): string => {
  const headerJson = extractFirstLineJson(content);
  const cursor: Record<string, unknown> = {};
  if (headerJson) {
    for (const key of [
      'fileId',
      'startOffset',
      'endOffset',
      'nextOffset',
      'totalCharCount',
      'startLine',
      'endLine',
      'nextStartLine',
      'totalLines',
      'snapshotAt',
    ]) {
      const val = headerJson[key];
      if (
        typeof val === 'number' ||
        val === null ||
        (typeof val === 'string' && val.length < 120)
      ) {
        cursor[key] = val;
      }
    }
  }
  const cursorSuffix = Object.keys(cursor).length > 0 ? ` ${JSON.stringify(cursor)}` : '';
  return `${content.slice(0, TOOL_CONTENT_HEAD_CHARS)}\n…[вывод инструмента (${content.length} знаков) из прежнего шага сокращён${cursorSuffix}]…\n${content.slice(-TOOL_CONTENT_TAIL_CHARS)}`;
};

const extractAgentDocMeta = (
  msg: any,
  args: Record<string, unknown> | null,
): {
  cursor: Record<string, unknown>;
  filename?: string;
  id?: string;
  offset: number;
  query: string;
} => {
  const content = typeof msg?.content === 'string' ? msg.content : '';
  const headerJson = extractFirstLineJson(content);
  const state = msg?.pluginState && typeof msg.pluginState === 'object' ? msg.pluginState : null;

  let id =
    (typeof headerJson?.id === 'string' && headerJson.id.trim()) ||
    (typeof state?.id === 'string' && state.id.trim()) ||
    (typeof args?.id === 'string' && args.id.trim()) ||
    undefined;
  let filename =
    (typeof headerJson?.filename === 'string' && headerJson.filename.trim()) ||
    (typeof state?.filename === 'string' && state.filename.trim()) ||
    (typeof args?.filename === 'string' && args.filename.trim()) ||
    undefined;

  if (!id || !filename) {
    const upserted = UPSERTED_DOC_RE.exec(content);
    if (upserted) {
      if (!filename) filename = upserted[1];
      if (!id) id = upserted[2];
    } else if (!id) {
      const updated = UPDATED_REMOVED_DOC_RE.exec(content);
      if (updated) id = updated[1];
    }
  }

  const offset = normalizeNonNegativeInt(args?.offset ?? headerJson?.startOffset, 0);
  const query =
    typeof args?.query === 'string'
      ? args.query.trim()
      : typeof headerJson?.query === 'string'
        ? headerJson.query.trim()
        : '';

  const cursor: Record<string, unknown> = {};
  if (id) cursor.id = id;
  if (filename) cursor.filename = filename;
  if (typeof headerJson?.startOffset === 'number') cursor.startOffset = headerJson.startOffset;
  else cursor.startOffset = offset;
  if (typeof headerJson?.endOffset === 'number') cursor.endOffset = headerJson.endOffset;
  if (headerJson && (headerJson.nextOffset === null || typeof headerJson.nextOffset === 'number')) {
    cursor.nextOffset = headerJson.nextOffset;
  }
  const totalLength =
    typeof headerJson?.totalLength === 'number'
      ? headerJson.totalLength
      : typeof headerJson?.totalCharCount === 'number'
        ? headerJson.totalCharCount
        : undefined;
  if (totalLength !== undefined) cursor.totalLength = totalLength;
  const snapshot =
    typeof headerJson?.snapshot === 'string' && headerJson.snapshot.length < 120
      ? headerJson.snapshot
      : typeof args?.snapshot === 'string' && args.snapshot.length < 120
        ? args.snapshot
        : undefined;
  if (snapshot) cursor.snapshot = snapshot;

  return { cursor, filename, id, offset, query };
};

const buildAgentDocumentStub = (
  content: string,
  apiName: string,
  cursor: Record<string, unknown>,
): string =>
  `Original agent document page retained (${content.length} chars). Repeat ${apiName} to retrieve the current page. ${JSON.stringify(cursor)}`;

const extractActivateSkillName = (
  msg: any,
  args: Record<string, unknown> | null,
): string | undefined => {
  const fromArgs = args?.name ?? args?.skillName ?? args?.identifier;
  if (typeof fromArgs === 'string' && fromArgs.trim().length > 0) {
    return fromArgs.trim();
  }
  const state = msg?.pluginState && typeof msg.pluginState === 'object' ? msg.pluginState : null;
  if (typeof state?.name === 'string' && state.name.trim().length > 0) {
    return state.name.trim();
  }
  if (typeof msg?.content === 'string') {
    const match = SKILL_NAME_XML_RE.exec(msg.content);
    const xmlName = (match?.[1] ?? match?.[2] ?? '').trim();
    if (xmlName) return xmlName;
  }
  return undefined;
};

const areEvaluatedMessagesEqual = (a: Message, b: Message): boolean => {
  if (a === b) return true;
  if (!a || !b || a.role !== b.role) return false;
  const sameContent =
    a.content === b.content || JSON.stringify(a.content) === JSON.stringify(b.content);
  if (!sameContent) return false;
  const sameToolCalls =
    a.tool_calls === b.tool_calls || JSON.stringify(a.tool_calls) === JSON.stringify(b.tool_calls);
  if (!sameToolCalls) return false;
  return a.tools === b.tools || JSON.stringify(a.tools) === JSON.stringify(b.tools);
};

/**
 * ArckepToolResultTrimProcessor
 *
 * Unified cache-safe context trimming processor that runs strictly AFTER
 * GroupMessageFlattenProcessor, TasksFlattenProcessor, CompressedGroupRoleTransformProcessor,
 * and ToolCallProcessor, and strictly BEFORE ToolMessageReorder and MessageCleanupProcessor.
 *
 * Enforces:
 * 1. Step 0 <-> Step 1 byte-for-byte prefix invariant anchored to `lastUserIndex`.
 * 2. Monotonic sticky replay + warm-cache break-even gate across turns.
 * 3. Targeted compaction & deduplication for Arckép's real tools while preserving
 *    the latest `activateSkill` per skill, `arckep-text-file` receipts, and `message.id` array alignment.
 */
export class ArckepToolResultTrimProcessor extends BaseProcessor {
  readonly name = 'ArckepToolResultTrimProcessor';

  constructor(
    private config: ArckepToolResultTrimConfig = {},
    options: ProcessorOptions = {},
  ) {
    super(options);
  }

  protected async doProcess(context: PipelineContext): Promise<PipelineContext> {
    if (this.config.enabled === false) {
      return this.markAsExecuted(context);
    }

    const clonedContext = this.cloneContext(context);

    // Normalize assistant content: null -> '' across all assistant messages so flat DB rows
    // (content: null) on Step 0 and flattened assistantGroup rows (content: '') on Step 1 match byte-for-byte.
    clonedContext.messages = clonedContext.messages.map((msg) => {
      if (msg && msg.role === 'assistant' && msg.content === null) {
        return { ...msg, content: '' };
      }
      return msg;
    });

    const messages = clonedContext.messages;
    const supportTools = clonedContext.metadata.supportTools !== false;
    const nonUserIds = collectNonUserIds(context.initialState?.messages);

    const realUserIndices: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (!msg || msg.role !== 'user') continue;
      if (msg.meta?.systemInjection === true) continue;
      if (typeof msg.id === 'string' && msg.id && nonUserIds.has(msg.id)) continue;
      if (msg.compressedMessages) continue;
      if (startsWithCompressedSummary(msg.content)) continue;
      if (!supportTools && msg.tool_call_id) continue;
      if (typeof msg.content === 'string' && msg.content.startsWith('<speaker name="')) continue;
      realUserIndices.push(i);
    }

    const lastUserIndex = realUserIndices.at(-1) ?? -1;
    if (lastUserIndex < 0) {
      return this.markAsExecuted(clonedContext);
    }

    // Index tool calls and tool messages ONLY within 0 .. lastUserIndex.
    // Messages at index > lastUserIndex (active in-flight tool steps) NEVER get trimmed
    // and NEVER influence deduplication or superseding of messages at index <= lastUserIndex.
    const toolCallMap = this.buildToolCallMap(messages, lastUserIndex);
    const indexedTools = this.buildIndexedToolMessages(
      messages,
      lastUserIndex,
      toolCallMap,
      supportTools,
    );
    const artifactMap = this.buildArtifactBlockMap(messages, lastUserIndex);

    const recentUserTurns = Math.max(
      0,
      this.config.recentUserTurns ?? RECENT_UNCOMPACTED_USER_TURNS,
    );
    const warmMinSavedChars = this.config.warmMinSavedChars ?? DEFAULT_WARM_MIN_SAVED_CHARS;
    const warmBreakEvenRatio = this.config.warmBreakEvenRatio ?? DEFAULT_WARM_BREAK_EVEN_RATIO;
    const warmMaxDeferredTurns = Math.max(
      1,
      this.config.warmMaxDeferredTurns ?? DEFAULT_WARM_MAX_DEFERRED_TURNS,
    );
    const cacheTtlMs = this.config.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;

    const totalRealTurns = realUserIndices.length;

    const isTurnWarm = (m: number): boolean => {
      if (m === totalRealTurns && this.config.cacheWarm !== undefined) {
        return Boolean(this.config.cacheWarm);
      }
      const userIdx = realUserIndices[m - 1];
      const userTs = getMessageTimestampMs(messages[userIdx], true);
      if (userTs === undefined) return false;

      let maxPrevTs = 0;
      for (let k = 0; k < userIdx; k++) {
        const prior = messages[k];
        if (!prior || prior.role === 'system' || prior.meta?.systemInjection === true) continue;
        if (isLoadingPlaceholder(prior)) continue;
        const prevTs = getMessageTimestampMs(prior, false);
        if (prevTs !== undefined && prevTs > maxPrevTs) {
          maxPrevTs = prevTs;
        }
      }

      if (maxPrevTs <= 0) return false;
      const gap = userTs - maxPrevTs;
      return gap >= 0 && gap < cacheTtlMs;
    };

    let appliedCutoff = 0;
    let effectiveDedupBound = -1;
    let deferredTurns = 0;
    let finalCacheWarm = false;

    for (let m = 1; m <= totalRealTurns; m++) {
      const curUserIndex = realUserIndices[m - 1];
      const prevUserIndex = m >= 2 ? realUserIndices[m - 2] : -1;
      const warm = isTurnWarm(m);
      if (m === totalRealTurns) finalCacheWarm = warm;

      const candidateCutoff = m > recentUserTurns ? realUserIndices[m - recentUserTurns] : 0;

      if (!warm) {
        appliedCutoff = Math.max(appliedCutoff, candidateCutoff);
        effectiveDedupBound = curUserIndex;
        deferredTurns = 0;
        continue;
      }

      const baselineDedupBound = effectiveDedupBound >= 0 ? effectiveDedupBound : prevUserIndex;
      const nextCutoff = Math.max(appliedCutoff, candidateCutoff);

      const oldEval = this.evaluatePrefix(
        messages,
        curUserIndex,
        appliedCutoff,
        baselineDedupBound,
        indexedTools,
        artifactMap,
      );
      const candEval = this.evaluatePrefix(
        messages,
        curUserIndex,
        nextCutoff,
        curUserIndex,
        indexedTools,
        artifactMap,
      );

      const deltaSavedChars = candEval.savedChars - oldEval.savedChars;

      let firstDiffIdx = 0;
      while (
        firstDiffIdx < curUserIndex &&
        areEvaluatedMessagesEqual(candEval.messages[firstDiffIdx], oldEval.messages[firstDiffIdx])
      ) {
        firstDiffIdx++;
      }

      // If advancing cutoff / dedupBound mutates 0 bytes in 0 .. curUserIndex - 1,
      // the provider cache is untouched — advance for free without burning deferredTurns!
      if (deltaSavedChars <= 0 || firstDiffIdx >= curUserIndex) {
        appliedCutoff = nextCutoff;
        effectiveDedupBound = curUserIndex;
        deferredTurns = 0;
        continue;
      }

      if (deferredTurns + 1 >= warmMaxDeferredTurns) {
        appliedCutoff = nextCutoff;
        effectiveDedupBound = curUserIndex;
        deferredTurns = 0;
        continue;
      }

      let cachedTailChars = 0;
      for (let k = firstDiffIdx; k < curUserIndex; k++) {
        cachedTailChars += estimateMessageChars(oldEval.messages[k]);
      }
      const breakEvenThreshold = Math.max(warmMinSavedChars, cachedTailChars * warmBreakEvenRatio);

      if (deltaSavedChars >= breakEvenThreshold) {
        appliedCutoff = nextCutoff;
        effectiveDedupBound = curUserIndex;
        deferredTurns = 0;
      } else {
        effectiveDedupBound = baselineDedupBound;
        deferredTurns += 1;
      }
    }

    const finalEval = this.evaluatePrefix(
      messages,
      lastUserIndex,
      appliedCutoff,
      effectiveDedupBound,
      indexedTools,
      artifactMap,
    );

    const outputMessages = [...finalEval.messages, ...messages.slice(lastUserIndex + 1)];
    clonedContext.messages = outputMessages;
    clonedContext.metadata.arckepToolResultTrim = {
      artifactsCompacted: finalEval.artifactsCompacted,
      cacheWarm: finalCacheWarm,
      cutoffIndex: appliedCutoff,
      deduplicatedCount: finalEval.deduplicatedCount,
      lastUserIndex,
      savedChars: finalEval.savedChars,
      toolArgsTrimmed: finalEval.toolArgsTrimmed,
      toolResultsTrimmed: finalEval.toolResultsTrimmed,
    };

    log(
      `Trimmed prefix up to lastUserIndex=${lastUserIndex}, cutoff=${appliedCutoff}, dedupBound=${effectiveDedupBound}, savedChars=${finalEval.savedChars}`,
    );

    return this.markAsExecuted(clonedContext);
  }

  private buildToolCallMap(
    messages: Message[],
    maxIndex: number,
  ): Map<string, ResolvedToolCallInfo> {
    const map = new Map<string, ResolvedToolCallInfo>();

    for (let i = 0; i <= maxIndex; i++) {
      const msg = messages[i];
      if (!msg || msg.role !== 'assistant') continue;

      let callOrder = 0;
      const orderByCallId = new Map<string, number>();

      if (Array.isArray(msg.tool_calls)) {
        for (const call of msg.tool_calls) {
          if (!call?.id || typeof call.id !== 'string') continue;
          if (!orderByCallId.has(call.id)) {
            orderByCallId.set(call.id, callOrder++);
          }
        }
      }

      if (Array.isArray(msg.tools)) {
        for (const tool of msg.tools) {
          if (!tool?.id || typeof tool.id !== 'string') continue;
          if (!orderByCallId.has(tool.id)) {
            orderByCallId.set(tool.id, callOrder++);
          }
          const identifier = typeof tool.identifier === 'string' ? tool.identifier : '';
          const apiName = typeof tool.apiName === 'string' ? tool.apiName : '';
          const argumentsRaw = typeof tool.arguments === 'string' ? tool.arguments : '';
          map.set(tool.id, {
            apiName,
            argumentsRaw,
            assistantIndex: i,
            callOrder: orderByCallId.get(tool.id)!,
            identifier,
            parsedArgs: safeParseJsonObject(argumentsRaw),
          });
        }
      }

      if (Array.isArray(msg.tool_calls)) {
        for (const call of msg.tool_calls) {
          if (!call?.id || typeof call.id !== 'string') continue;
          const existing = map.get(call.id);
          const parsedName = parseToolName(call.function?.name);
          const identifier = existing?.identifier || parsedName?.identifier || '';
          const apiName = existing?.apiName || parsedName?.apiName || '';
          const argumentsRaw =
            typeof call.function?.arguments === 'string'
              ? call.function.arguments
              : existing?.argumentsRaw || '';
          map.set(call.id, {
            apiName,
            argumentsRaw,
            assistantIndex: existing?.assistantIndex ?? i,
            callOrder: existing?.callOrder ?? orderByCallId.get(call.id) ?? 0,
            identifier,
            parsedArgs: existing?.parsedArgs ?? safeParseJsonObject(argumentsRaw),
          });
        }
      }
    }

    return map;
  }

  private buildIndexedToolMessages(
    messages: Message[],
    maxIndex: number,
    toolCallMap: Map<string, ResolvedToolCallInfo>,
    supportTools: boolean,
  ): Map<number, IndexedToolMessage> {
    const result = new Map<number, IndexedToolMessage>();
    const seenToolCallIds = new Set<string>();

    for (let i = 0; i <= maxIndex; i++) {
      const msg = messages[i];
      if (!msg || msg.role !== 'tool') continue;

      const callInfo =
        typeof msg.tool_call_id === 'string' ? toolCallMap.get(msg.tool_call_id) : undefined;

      // Mirror ToolMessageReorder & conversation-flow parse(): when tools are enabled, orphan
      // tool rows (missing/unmatched tool_call_id) and duplicate tool_call_id rows are dropped
      // immediately downstream and must never participate in deduplication or savedChars.
      if (supportTools) {
        if (typeof msg.tool_call_id !== 'string' || !msg.tool_call_id || !callInfo) continue;
        if (seenToolCallIds.has(msg.tool_call_id)) continue;
        seenToolCallIds.add(msg.tool_call_id);
      }

      const pluginIdentifier =
        typeof msg.plugin?.identifier === 'string' ? msg.plugin.identifier : '';
      const pluginApiName = typeof msg.plugin?.apiName === 'string' ? msg.plugin.apiName : '';
      const parsedFromName = parseToolName(msg.name);

      const identifier =
        callInfo?.identifier || pluginIdentifier || parsedFromName?.identifier || '';
      const apiName = callInfo?.apiName || pluginApiName || parsedFromName?.apiName || '';
      const argumentsRaw =
        callInfo?.argumentsRaw ||
        (typeof msg.plugin?.arguments === 'string' ? msg.plugin.arguments : '');
      const parsedArgs = callInfo?.parsedArgs ?? safeParseJsonObject(argumentsRaw);

      const isProtectedTextFile =
        isProtectedTextFileTool(identifier, apiName, msg.name) ||
        (typeof msg.content === 'string' && msg.content.startsWith(TEXT_FILE_RECEIPT_PREFIX));

      const isError = detectToolMessageError(msg);

      const entry: IndexedToolMessage = {
        apiName,
        argumentsRaw,
        assistantIndex: callInfo?.assistantIndex ?? i,
        callOrder: callInfo?.callOrder ?? 0,
        identifier,
        index: i,
        isError,
        isProtectedTextFile,
        parsedArgs,
      };

      if (!isError && !isProtectedTextFile) {
        if (identifier === 'lobe-knowledge-base' && apiName === 'readKnowledge') {
          entry.readKnowledgeKey = extractReadKnowledgeKey(parsedArgs);
        } else if (identifier === 'lobe-agent-documents') {
          if (apiName === 'readDocument' || apiName === 'readDocumentByFilename') {
            const meta = extractAgentDocMeta(msg, parsedArgs);
            entry.agentDocRead = true;
            entry.agentDocId = meta.id;
            entry.agentDocFilename = meta.filename;
            entry.agentDocOffset = meta.offset;
            entry.agentDocQuery = meta.query;
          } else if (
            apiName === 'editDocument' ||
            apiName === 'updateDocument' ||
            apiName === 'upsertDocumentByFilename' ||
            apiName === 'removeDocument'
          ) {
            const meta = extractAgentDocMeta(msg, parsedArgs);
            entry.agentDocMutation = true;
            entry.agentDocId = meta.id;
            entry.agentDocFilename = meta.filename;
          }
        } else if (identifier === 'lobe-activator' && apiName === 'activateSkill') {
          entry.activateSkillName = extractActivateSkillName(msg, parsedArgs);
        } else if (identifier.startsWith('mcp-arckep-studio') && apiName === 'list_models') {
          entry.listModelsKey = `${identifier}::${JSON.stringify(canonicalizeJson(parsedArgs ?? {}))}`;
        }
      }

      result.set(i, entry);
    }

    return result;
  }

  private buildArtifactBlockMap(
    messages: Message[],
    maxIndex: number,
  ): Map<number, { blocks: ParsedArtifactBlock[]; partIndex: number }[]> {
    const map = new Map<number, { blocks: ParsedArtifactBlock[]; partIndex: number }[]>();

    for (let i = 0; i <= maxIndex; i++) {
      const msg = messages[i];
      if (!msg || msg.role !== 'assistant') continue;

      if (typeof msg.content === 'string') {
        const blocks = findInlineArtifactBlocks(msg.content);
        if (blocks.length > 0) {
          map.set(i, [{ blocks, partIndex: -1 }]);
        }
      } else if (Array.isArray(msg.content)) {
        const partEntries: { blocks: ParsedArtifactBlock[]; partIndex: number }[] = [];
        msg.content.forEach((part: any, partIndex: number) => {
          if (part?.type === 'text' && typeof part.text === 'string') {
            const blocks = findInlineArtifactBlocks(part.text);
            if (blocks.length > 0) {
              partEntries.push({ blocks, partIndex });
            }
          }
        });
        if (partEntries.length > 0) {
          map.set(i, partEntries);
        }
      }
    }

    return map;
  }

  private evaluatePrefix(
    messages: Message[],
    boundIndex: number,
    cutoffIndex: number,
    dedupBound: number,
    indexedTools: Map<number, IndexedToolMessage>,
    artifactMap: Map<number, { blocks: ParsedArtifactBlock[]; partIndex: number }[]>,
  ): PrefixEvalResult {
    const clampedDedupBound = Math.min(dedupBound, boundIndex);
    const clampedCutoff = Math.min(cutoffIndex, boundIndex + 1);

    // 1. Precompute deduplication / superseding sets within 0 .. clampedDedupBound
    // Iterate in canonical ToolMessageReorder order (assistantIndex, callOrder, index)
    // so parallel Promise.all DB completion order on Step 0 matches GroupMessageFlatten order on Step 1b.
    const orderedToolsInBound: IndexedToolMessage[] = [];
    for (const info of indexedTools.values()) {
      if (info.index > boundIndex || info.assistantIndex > clampedDedupBound) continue;
      if (info.isError || info.isProtectedTextFile) continue;
      orderedToolsInBound.push(info);
    }
    orderedToolsInBound.sort(
      (a, b) =>
        a.assistantIndex - b.assistantIndex || a.callOrder - b.callOrder || a.index - b.index,
    );

    const canonicalRankByMsgIndex = new Map<number, number>();
    const latestReadKnowledge = new Map<string, number>();
    const latestActivateSkill = new Map<string, number>();
    const latestListModels = new Map<string, number>();
    const docEventsInBound: IndexedToolMessage[] = [];

    orderedToolsInBound.forEach((info, rank) => {
      canonicalRankByMsgIndex.set(info.index, rank);
      if (info.readKnowledgeKey) {
        latestReadKnowledge.set(info.readKnowledgeKey, rank);
      }
      if (info.activateSkillName) {
        latestActivateSkill.set(info.activateSkillName, rank);
      }
      if (info.listModelsKey) {
        latestListModels.set(info.listModelsKey, rank);
      }
      if (info.agentDocRead || info.agentDocMutation) {
        docEventsInBound.push(info);
      }
    });

    const supersededAgentDocReads = new Set<number>();
    for (let a = 0; a < docEventsInBound.length; a++) {
      const earlier = docEventsInBound[a];
      if (!earlier.agentDocRead) continue;

      for (let b = a + 1; b < docEventsInBound.length; b++) {
        const later = docEventsInBound[b];
        const sameDoc =
          Boolean(
            earlier.agentDocId && later.agentDocId && earlier.agentDocId === later.agentDocId,
          ) ||
          Boolean(
            earlier.agentDocFilename &&
            later.agentDocFilename &&
            earlier.agentDocFilename === later.agentDocFilename,
          );
        if (!sameDoc) continue;

        if (later.agentDocMutation) {
          supersededAgentDocReads.add(earlier.index);
          break;
        }
        if (
          later.agentDocRead &&
          earlier.agentDocOffset === later.agentDocOffset &&
          earlier.agentDocQuery === later.agentDocQuery
        ) {
          supersededAgentDocReads.add(earlier.index);
          break;
        }
      }
    }

    // Latest inline <lobeArtifact identifier="..."> within 0 .. clampedDedupBound
    const latestArtifact = new Map<
      string,
      { blockIndex: number; msgIndex: number; partIndex: number }
    >();
    for (let i = 0; i <= clampedDedupBound; i++) {
      const entries = artifactMap.get(i);
      if (!entries) continue;
      for (const entry of entries) {
        entry.blocks.forEach((b, blockIndex) => {
          latestArtifact.set(b.identifier, {
            blockIndex,
            msgIndex: i,
            partIndex: entry.partIndex,
          });
        });
      }
    }

    // 2. Transform messages[0 .. boundIndex]
    const nextMessages: Message[] = Array.from({ length: boundIndex + 1 });
    let savedChars = 0;
    let artifactsCompacted = 0;
    let deduplicatedCount = 0;
    let toolResultsTrimmed = 0;
    let toolArgsTrimmed = 0;

    for (let i = 0; i <= boundIndex; i++) {
      const origMsg = messages[i];
      if (!origMsg || typeof origMsg !== 'object') {
        nextMessages[i] = origMsg;
        continue;
      }

      let nextMsg = origMsg;
      const isOld = i < clampedCutoff;
      const inDedupWindow = i <= clampedDedupBound;

      // (A) Assistant messages: inline <lobeArtifact> superseding + old tool call arguments
      if (nextMsg.role === 'assistant') {
        if (inDedupWindow) {
          const entries = artifactMap.get(i);
          if (entries) {
            if (typeof nextMsg.content === 'string') {
              const blocks = entries[0]?.blocks ?? [];
              const superseded = blocks.filter((b, blockIndex) => {
                const latest = latestArtifact.get(b.identifier);
                return (
                  latest &&
                  (latest.msgIndex !== i ||
                    latest.partIndex !== -1 ||
                    latest.blockIndex !== blockIndex)
                );
              });
              if (superseded.length > 0) {
                const rebuilt = this.rebuildArtifactText(nextMsg.content, superseded);
                if (rebuilt.length < nextMsg.content.length) {
                  savedChars += nextMsg.content.length - rebuilt.length;
                  artifactsCompacted += superseded.length;
                  nextMsg = { ...nextMsg, content: rebuilt };
                }
              }
            } else if (Array.isArray(nextMsg.content)) {
              let partsChanged = false;
              const updatedParts = [...nextMsg.content];
              for (const entry of entries) {
                const part = updatedParts[entry.partIndex];
                if (!part || typeof part.text !== 'string') continue;
                const superseded = entry.blocks.filter((b, blockIndex) => {
                  const latest = latestArtifact.get(b.identifier);
                  return (
                    latest &&
                    (latest.msgIndex !== i ||
                      latest.partIndex !== entry.partIndex ||
                      latest.blockIndex !== blockIndex)
                  );
                });
                if (superseded.length > 0) {
                  const rebuilt = this.rebuildArtifactText(part.text, superseded);
                  if (rebuilt.length < part.text.length) {
                    savedChars += part.text.length - rebuilt.length;
                    artifactsCompacted += superseded.length;
                    updatedParts[entry.partIndex] = { ...part, text: rebuilt };
                    partsChanged = true;
                  }
                }
              }
              if (partsChanged) {
                nextMsg = { ...nextMsg, content: updatedParts };
              }
            }
          }
        }

        if (isOld) {
          const trimmedCallIds = new Set<string>();
          let charsSavedInCalls = 0;

          if (Array.isArray(nextMsg.tool_calls) && nextMsg.tool_calls.length > 0) {
            let tcChanged = false;
            const nextToolCalls = nextMsg.tool_calls.map((tc: any, idx: number) => {
              const rawArgs = tc?.function?.arguments;
              if (typeof rawArgs !== 'string' || rawArgs.length <= MAX_OLD_TOOL_ARGUMENTS_CHARS) {
                return tc;
              }
              const parsedName = parseToolName(tc.function?.name);
              if (
                isProtectedTextFileTool(
                  parsedName?.identifier ?? '',
                  parsedName?.apiName ?? '',
                  tc.function?.name,
                )
              ) {
                return tc;
              }
              const compactedArgs = compactToolArgumentsJson(rawArgs);
              if (compactedArgs !== rawArgs) {
                tcChanged = true;
                const key = typeof tc.id === 'string' && tc.id ? tc.id : `idx:${idx}`;
                trimmedCallIds.add(key);
                charsSavedInCalls += rawArgs.length - compactedArgs.length;
                return {
                  ...tc,
                  function: {
                    ...tc.function,
                    arguments: compactedArgs,
                  },
                };
              }
              return tc;
            });

            if (tcChanged) {
              nextMsg = { ...nextMsg, tool_calls: nextToolCalls };
            }
          }

          if (Array.isArray(nextMsg.tools) && nextMsg.tools.length > 0) {
            let toolsChanged = false;
            const nextTools = nextMsg.tools.map((tool: any, idx: number) => {
              const rawArgs = tool?.arguments;
              if (typeof rawArgs !== 'string' || rawArgs.length <= MAX_OLD_TOOL_ARGUMENTS_CHARS) {
                return tool;
              }
              if (
                isProtectedTextFileTool(
                  typeof tool.identifier === 'string' ? tool.identifier : '',
                  typeof tool.apiName === 'string' ? tool.apiName : '',
                )
              ) {
                return tool;
              }
              const compactedArgs = compactToolArgumentsJson(rawArgs);
              if (compactedArgs !== rawArgs) {
                toolsChanged = true;
                const key = typeof tool.id === 'string' && tool.id ? tool.id : `idx:${idx}`;
                if (!trimmedCallIds.has(key)) {
                  trimmedCallIds.add(key);
                  charsSavedInCalls += rawArgs.length - compactedArgs.length;
                }
                return { ...tool, arguments: compactedArgs };
              }
              return tool;
            });

            if (toolsChanged) {
              nextMsg = { ...nextMsg, tools: nextTools };
            }
          }

          if (trimmedCallIds.size > 0) {
            toolArgsTrimmed += trimmedCallIds.size;
            savedChars += charsSavedInCalls;
          }
        }

        nextMessages[i] = nextMsg;
        continue;
      }

      // (B) Tool messages: 6 targeted rules
      if (nextMsg.role === 'tool' && typeof nextMsg.content === 'string') {
        const content = nextMsg.content;
        const info = indexedTools.get(i);

        // Unindexed tool messages (e.g. orphan or duplicate tool_call_id rows that ToolMessageReorder
        // drops immediately downstream) are left untouched so they never skew savedChars or dedup.
        if (!info) {
          nextMessages[i] = nextMsg;
          continue;
        }

        // Rule (6): NEVER touch arckep-text-file / writePart or ARCKEP_TEXT_FILE_V1\n receipts
        if (info.isProtectedTextFile || content.startsWith(TEXT_FILE_RECEIPT_PREFIX)) {
          nextMessages[i] = nextMsg;
          continue;
        }

        const toolIsOld = info.assistantIndex < clampedCutoff;
        const toolInDedupWindow = info.assistantIndex <= clampedDedupBound;
        const myRank = canonicalRankByMsgIndex.get(i) ?? -1;

        const identifier = info.identifier;
        const apiName = info.apiName;
        let replacement: string | undefined;
        let isDeduplicated = false;

        // Rule (4): lobe-activator / activateSkill — ALWAYS keep the latest successful activation per skillName intact!
        if (identifier === 'lobe-activator' && apiName === 'activateSkill' && !info.isError) {
          const skillName = info.activateSkillName;
          if (skillName && toolInDedupWindow && myRank >= 0) {
            const latestRank = latestActivateSkill.get(skillName);
            if (latestRank !== undefined && latestRank > myRank) {
              const stub = `Skill "${skillName}" already activated; full instructions retained in the latest activateSkill("${skillName}") result below.`;
              if (stub.length < content.length) {
                replacement = stub;
                isDeduplicated = true;
              }
            }
          }
          // Never fall through to > 4000 truncation for successful activateSkill!
        }
        // Rule (1): lobe-knowledge-base / readKnowledge
        else if (identifier === 'lobe-knowledge-base' && apiName === 'readKnowledge') {
          const isDup =
            !info.isError &&
            toolInDedupWindow &&
            myRank >= 0 &&
            Boolean(info.readKnowledgeKey) &&
            (latestReadKnowledge.get(info.readKnowledgeKey!) ?? -1) > myRank;

          if (isDup || (toolIsOld && !info.isError)) {
            const stub = buildReadKnowledgeStub(content, info.parsedArgs);
            if (stub.length < content.length) {
              replacement = stub;
              isDeduplicated = isDup;
            }
          } else if (toolIsOld && content.length > MAX_OLD_TOOL_CONTENT_CHARS) {
            replacement = compactStringValue(
              content,
              TOOL_CONTENT_HEAD_CHARS,
              TOOL_CONTENT_TAIL_CHARS,
              'вывод инструмента',
            );
          }
        }
        // Rule (2): lobe-topic-reference / getTopicContext & lobe-knowledge-base / searchKnowledgeBase
        else if (
          (identifier === 'lobe-topic-reference' && apiName === 'getTopicContext') ||
          (identifier === 'lobe-knowledge-base' && apiName === 'searchKnowledgeBase')
        ) {
          if (toolIsOld && content.length > MAX_OLD_TOOL_CONTENT_CHARS) {
            const trimmed = buildPagedHeadTailTrim(content);
            if (trimmed.length < content.length) {
              replacement = trimmed;
            }
          }
        }
        // Rule (3): lobe-agent-documents / readDocument & readDocumentByFilename
        else if (
          identifier === 'lobe-agent-documents' &&
          (apiName === 'readDocument' || apiName === 'readDocumentByFilename')
        ) {
          const isSuperseded = toolInDedupWindow && supersededAgentDocReads.has(i);
          if (
            isSuperseded ||
            (toolIsOld && !info.isError && content.length > MAX_OLD_TOOL_CONTENT_CHARS)
          ) {
            const meta = extractAgentDocMeta(nextMsg, info.parsedArgs);
            const stub = buildAgentDocumentStub(content, apiName, meta.cursor);
            if (stub.length < content.length) {
              replacement = stub;
              isDeduplicated = isSuperseded;
            }
          } else if (toolIsOld && content.length > MAX_OLD_TOOL_CONTENT_CHARS) {
            replacement = compactStringValue(
              content,
              TOOL_CONTENT_HEAD_CHARS,
              TOOL_CONTENT_TAIL_CHARS,
              'вывод инструмента',
            );
          }
        }
        // Rule (5a): mcp-arckep-studio-* / list_models
        else if (identifier.startsWith('mcp-arckep-studio') && apiName === 'list_models') {
          const isDup =
            !info.isError &&
            toolInDedupWindow &&
            myRank >= 0 &&
            Boolean(info.listModelsKey) &&
            (latestListModels.get(info.listModelsKey!) ?? -1) > myRank;

          if (isDup) {
            const stub = `Model list (${content.length} chars) omitted: identical ${identifier}/${apiName} result retained later in conversation.`;
            if (stub.length < content.length) {
              replacement = stub;
              isDeduplicated = true;
            }
          } else if (toolIsOld && content.length > MAX_OLD_TOOL_CONTENT_CHARS) {
            replacement = compactStringValue(
              content,
              TOOL_CONTENT_HEAD_CHARS,
              TOOL_CONTENT_TAIL_CHARS,
              'вывод инструмента',
            );
          }
        }
        // Rule (5b): mcp-arckep-studio-web / web_search, mcp-arckep-e2b-sandbox / execute_code, and all other old > 4000 tool outputs
        else if (toolIsOld && content.length > MAX_OLD_TOOL_CONTENT_CHARS) {
          const trimmed = compactStringValue(
            content,
            TOOL_CONTENT_HEAD_CHARS,
            TOOL_CONTENT_TAIL_CHARS,
            'вывод инструмента',
          );
          if (trimmed.length < content.length) {
            replacement = trimmed;
          }
        }

        if (replacement !== undefined && replacement.length < content.length) {
          savedChars += content.length - replacement.length;
          toolResultsTrimmed += 1;
          if (isDeduplicated) deduplicatedCount += 1;
          nextMsg = { ...nextMsg, content: replacement };
        }
      }

      nextMessages[i] = nextMsg;
    }

    return {
      artifactsCompacted,
      deduplicatedCount,
      messages: nextMessages,
      savedChars,
      toolArgsTrimmed,
      toolResultsTrimmed,
    };
  }

  private rebuildArtifactText(text: string, superseded: ParsedArtifactBlock[]): string {
    let cursor = 0;
    let rebuilt = '';
    for (const b of superseded) {
      rebuilt += text.slice(cursor, b.start);
      rebuilt += `${b.openTag}\n<!-- Предыдущая версия макета (${b.body.length} знаков) опущена: актуальная версия с тем же identifier приведена ниже в истории диалога -->\n${b.closeTag}`;
      cursor = b.end;
    }
    rebuilt += text.slice(cursor);
    return rebuilt;
  }
}
