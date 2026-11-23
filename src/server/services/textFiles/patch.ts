import { detectLineEnding, type SourceLineEnding } from '@lobechat/file-loaders';

export const MAX_PATCH_EDITS = 50;
export const MAX_PATCH_BATCH_BYTES = 512 * 1024;
export const MAX_PATCH_OUTPUT_BYTES = 2 * 1024 * 1024;
export const MAX_DIFF_SUMMARY_CHARS = 2500;
export const LINE_WINDOW_MARGIN = 5;
const MAX_REPORTED_MATCH_LINES = 10;
const DIFF_CONTEXT_LINES = 2;

export interface PatchEdit {
  endLine?: number;
  newText: string;
  oldText: string;
  replaceAll?: boolean;
  startLine?: number;
}

export type PatchMatchLevel = 'exact' | 'line_trim_end' | 'indent_flexible';

export type PatchEditErrorCode =
  | 'invalid_edit'
  | 'not_found'
  | 'not_found_in_range'
  | 'ambiguous_match'
  | 'indent_mismatch'
  | 'overlapping_edits';

export interface PatchEditDiagnostic {
  code?: PatchEditErrorCode;
  endLine?: number;
  index: number;
  level?: PatchMatchLevel;
  matchLines?: number[];
  message: string;
  occurrences?: number;
  ok: boolean;
  overlappingWith?: number[];
  startLine?: number;
}

export interface ApplyAtomicPatchOptions {
  fileName?: string;
  maxOutputBytes?: number;
  sourceEncoding?: string;
  targetEncoding?: string;
}

export type ApplyAtomicPatchResult =
  | {
      appliedEdits: number;
      appliedOccurrences: number;
      content: string;
      diagnostics: PatchEditDiagnostic[];
      diffSummary: string;
      hasBom: boolean;
      lineEnding: SourceLineEnding;
      linesAfter: number;
      linesBefore: number;
      ok: true;
    }
  | {
      code: 'invalid_patch' | 'patch_failed' | 'size_limit';
      diagnostics: PatchEditDiagnostic[];
      error: string;
      ok: false;
    };

interface LineIndex {
  lineEnds: Int32Array;
  lines: string[];
  lineStarts: Int32Array;
  /** Number of logical lines (excluding the empty slot after a trailing '\n'). */
  logicalLineCount: number;
  normalized: string;
  trimmedLines?: string[];
}

const getTrimmedLines = (index: LineIndex): string[] => {
  if (!index.trimmedLines) {
    const { lines } = index;
    const trimmed: string[] = Array.from({ length: lines.length });
    for (let i = 0; i < lines.length; i++) {
      trimmed[i] = trimEndTabsSpaces(lines[i]);
    }
    index.trimmedLines = trimmed;
  }
  return index.trimmedLines;
};

interface RawMatch {
  end: number;
  level: PatchMatchLevel;
  replacement: string;
  start: number;
}

interface ResolvedSpan {
  editIndex: number;
  end: number;
  level: PatchMatchLevel;
  replacement: string;
  start: number;
}

type IndentKind = 'none' | 'space' | 'tab' | 'mixed';

const isExactUtf8 = (s: string) => Buffer.from(s, 'utf8').toString('utf8') === s;

const trimEndTabsSpaces = (line: string) => line.replace(/[ \t]+$/, '');

const normalizeNewlines = (text: string) => text.replaceAll('\r\n', '\n');

const countLogicalLines = (normalized: string): number => {
  if (normalized.length === 0) return 0;
  let count = 1;
  for (let i = 0; i < normalized.length; i++) {
    if (normalized.charCodeAt(i) === 10) count++;
  }
  return normalized.endsWith('\n') ? count - 1 : count;
};

const buildLineIndex = (normalized: string): LineIndex => {
  const lines = normalized.split('\n');
  const lineStarts = new Int32Array(lines.length);
  const lineEnds = new Int32Array(lines.length);

  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    lineStarts[i] = offset;
    const len = lines[i].length;
    lineEnds[i] = offset + len;
    offset += len + 1; // +1 for '\n'
  }

  const logicalLineCount =
    normalized.length === 0 ? 0 : normalized.endsWith('\n') ? lines.length - 1 : lines.length;

  return { lineEnds, lineStarts, lines, logicalLineCount, normalized };
};

const offsetToLine = (lineStarts: Int32Array, offset: number): number => {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (lineStarts[mid] <= offset) {
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return Math.max(1, hi + 1);
};

const leadingWhitespaceLength = (line: string): number => {
  let i = 0;
  while (i < line.length) {
    const ch = line.charCodeAt(i);
    if (ch !== 32 && ch !== 9) break;
    i++;
  }
  return i;
};

const analyzeBlockIndent = (
  lines: string[],
  trimmedLines: string[],
  startIdx: number,
  count: number,
): { baseIndent: number; kind: IndentKind; nonBlankCount: number } => {
  let hasSpace = false;
  let hasTab = false;
  let minIndent = Number.POSITIVE_INFINITY;
  let nonBlankCount = 0;

  for (let i = 0; i < count; i++) {
    const trimmed = trimmedLines[startIdx + i];
    if (trimmed.length === 0) continue;
    nonBlankCount++;
    const line = lines[startIdx + i];
    let indentLen = 0;
    while (indentLen < line.length) {
      const ch = line.charCodeAt(indentLen);
      if (ch === 32) {
        hasSpace = true;
      } else if (ch === 9) {
        hasTab = true;
      } else {
        break;
      }
      indentLen++;
    }
    if (indentLen < minIndent) minIndent = indentLen;
  }

  if (nonBlankCount === 0) {
    return { baseIndent: 0, kind: 'none', nonBlankCount: 0 };
  }

  const kind: IndentKind =
    hasSpace && hasTab ? 'mixed' : hasSpace ? 'space' : hasTab ? 'tab' : 'none';
  return { baseIndent: minIndent, kind, nonBlankCount };
};

const reindentReplacement = (
  newNorm: string,
  delta: number,
  indentChar: ' ' | '\t',
): { ok: true; text: string } | { ok: false } => {
  if (newNorm.length === 0 || delta === 0) {
    return { ok: true, text: newNorm };
  }

  const hasTrailingNewline = newNorm.endsWith('\n');
  const core = hasTrailingNewline ? newNorm.slice(0, -1) : newNorm;
  const lines = core.split('\n');
  const oppositeChar = indentChar === ' ' ? '\t' : ' ';
  const pad = delta > 0 ? indentChar.repeat(delta) : '';
  const removeCount = delta < 0 ? -delta : 0;

  const out: string[] = Array.from({ length: lines.length });

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (trimEndTabsSpaces(line).length === 0) {
      // Preserve blank lines without introducing trailing spaces or failing negative delta.
      out[i] = '';
      continue;
    }

    const leadLen = leadingWhitespaceLength(line);
    for (let k = 0; k < leadLen; k++) {
      if (line[k] === oppositeChar) {
        return { ok: false };
      }
    }

    if (delta > 0) {
      out[i] = pad + line;
    } else {
      if (leadLen < removeCount) {
        return { ok: false };
      }
      out[i] = line.slice(removeCount);
    }
  }

  return { ok: true, text: out.join('\n') + (hasTrailingNewline ? '\n' : '') };
};

interface CascadeResult {
  indentMismatch?: boolean;
  matches: RawMatch[];
}

const runMatchCascade = (
  index: LineIndex,
  oldNorm: string,
  newNorm: string,
  winStartLine: number,
  winEndLine: number,
  replaceAll: boolean,
): CascadeResult => {
  const { lineEnds, lineStarts, lines, logicalLineCount, normalized } = index;

  if (logicalLineCount === 0 || winStartLine > winEndLine || winStartLine > logicalLineCount) {
    return { matches: [] };
  }

  const clampedStartLine = Math.max(1, winStartLine);
  const clampedEndLine = Math.min(logicalLineCount, winEndLine);
  const winStartIdx = clampedStartLine - 1;
  const winEndIdx = clampedEndLine - 1;
  const winStartChar = lineStarts[winStartIdx];
  const winEndChar = clampedEndLine < lines.length ? lineStarts[clampedEndLine] : normalized.length;

  // Level 1: Exact substring match within [winStartChar, winEndChar]
  {
    const exactMatches: RawMatch[] = [];
    let pos = winStartChar;
    while (pos <= winEndChar - oldNorm.length) {
      const found = normalized.indexOf(oldNorm, pos);
      if (found < 0 || found + oldNorm.length > winEndChar) break;
      exactMatches.push({
        end: found + oldNorm.length,
        level: 'exact',
        replacement: newNorm,
        start: found,
      });
      pos = replaceAll ? found + oldNorm.length : found + 1;
    }
    if (exactMatches.length > 0) {
      return { matches: exactMatches };
    }
  }

  const oldHasTrailingNewline = oldNorm.endsWith('\n');
  const oldCore = oldHasTrailingNewline ? oldNorm.slice(0, -1) : oldNorm;
  const oldLines = oldCore.split('\n');
  const oldTrimmed = oldLines.map(trimEndTabsSpaces);
  const blockHeight = oldLines.length;
  const maxStartIdx = winEndIdx - blockHeight + 1;

  if (maxStartIdx < winStartIdx) {
    return { matches: [] };
  }

  // Level 2: Line-by-line match with trailing horizontal whitespace ignored ONLY (never leading!)
  if (oldTrimmed.every((l) => l.length === 0)) {
    return { matches: [] };
  }
  const trimmedLines = getTrimmedLines(index);
  {
    const trimEndMatches: RawMatch[] = [];
    let idx = winStartIdx;
    while (idx <= maxStartIdx) {
      let matched = true;
      for (let j = 0; j < blockHeight; j++) {
        if (trimmedLines[idx + j] !== oldTrimmed[j]) {
          matched = false;
          break;
        }
      }
      if (matched) {
        const lastIdx = idx + blockHeight - 1;
        const hasLineBreakAfter = lineEnds[lastIdx] < normalized.length;
        if (!oldHasTrailingNewline || hasLineBreakAfter) {
          trimEndMatches.push({
            end: oldHasTrailingNewline ? lineEnds[lastIdx] + 1 : lineEnds[lastIdx],
            level: 'line_trim_end',
            replacement: newNorm,
            start: lineStarts[idx],
          });
          idx += replaceAll ? blockHeight : 1;
          continue;
        }
      }
      idx++;
    }
    if (trimEndMatches.length > 0) {
      return { matches: trimEndMatches };
    }
  }

  // Level 3: Indent-flexible block match (homogeneous indent char, exact relative indentation)
  const oldIndent = analyzeBlockIndent(oldLines, oldTrimmed, 0, blockHeight);
  if (oldIndent.nonBlankCount === 0 || oldIndent.kind === 'mixed') {
    return { matches: [] };
  }

  const indentMatches: RawMatch[] = [];
  let sawIndentMismatch = false;
  let idx = winStartIdx;
  while (idx <= maxStartIdx) {
    const candIndent = analyzeBlockIndent(lines, trimmedLines, idx, blockHeight);
    if (
      candIndent.nonBlankCount !== oldIndent.nonBlankCount ||
      candIndent.kind === 'mixed' ||
      (oldIndent.kind !== 'none' &&
        candIndent.kind !== 'none' &&
        oldIndent.kind !== candIndent.kind)
    ) {
      idx++;
      continue;
    }

    let matched = true;
    for (let j = 0; j < blockHeight; j++) {
      const oTrim = oldTrimmed[j];
      const cTrim = trimmedLines[idx + j];
      if (oTrim.length === 0 || cTrim.length === 0) {
        if (oTrim.length !== cTrim.length) {
          matched = false;
          break;
        }
        continue;
      }
      if (oTrim.slice(oldIndent.baseIndent) !== cTrim.slice(candIndent.baseIndent)) {
        matched = false;
        break;
      }
    }

    if (matched) {
      const lastIdx = idx + blockHeight - 1;
      const hasLineBreakAfter = lineEnds[lastIdx] < normalized.length;
      if (!oldHasTrailingNewline || hasLineBreakAfter) {
        const effectiveKind = candIndent.kind !== 'none' ? candIndent.kind : oldIndent.kind;
        const indentChar: ' ' | '\t' = effectiveKind === 'tab' ? '\t' : ' ';
        const delta = candIndent.baseIndent - oldIndent.baseIndent;
        const reindented = reindentReplacement(newNorm, delta, indentChar);
        if (!reindented.ok) {
          sawIndentMismatch = true;
          idx++;
          continue;
        }
        indentMatches.push({
          end: oldHasTrailingNewline ? lineEnds[lastIdx] + 1 : lineEnds[lastIdx],
          level: 'indent_flexible',
          replacement: reindented.text,
          start: lineStarts[idx],
        });
        idx += replaceAll ? blockHeight : 1;
        continue;
      }
    }
    idx++;
  }

  if (indentMatches.length > 0) {
    return { matches: indentMatches };
  }
  return { indentMismatch: sawIndentMismatch, matches: [] };
};

const doesBlockHaveUnclosedPrefix = (
  sourceNormalized: string,
  blockCharStart: number,
  allSpans: ResolvedSpan[],
  spansStart: number,
  spansEnd: number,
): boolean => {
  for (let k = spansEnd - 1; k >= spansStart; k--) {
    const repl = allSpans[k].replacement;
    if (repl.length > 0) {
      return !repl.endsWith('\n');
    }
    const gapStart = k > spansStart ? allSpans[k - 1].end : blockCharStart;
    const gapEnd = allSpans[k].start;
    if (gapEnd > gapStart) {
      return sourceNormalized.charCodeAt(gapEnd - 1) !== 10;
    }
  }
  return false;
};

interface OpenDiffHunk {
  delta: number;
  lastOpEndIdx: number;
  lines: string[];
  newStartIdx: number;
  oldStartIdx: number;
}

const formatDiffSummary = ({
  allSpans,
  appliedEdits,
  appliedOccurrences,
  index,
  lineEnding,
  patchedNormalized,
  sourceEncoding,
  targetEncoding,
}: {
  allSpans: ResolvedSpan[];
  appliedEdits: number;
  appliedOccurrences: number;
  index: LineIndex;
  lineEnding: SourceLineEnding;
  patchedNormalized: string;
  sourceEncoding: string;
  targetEncoding?: string;
}): { diffSummary: string; linesAfter: number; linesBefore: number } => {
  const { lineEnds, lineStarts, lines, logicalLineCount: totalOldLines, normalized } = index;
  const sourceHasTrailingNl = normalized.endsWith('\n');

  let totalAdded = 0;
  let totalDeleted = 0;
  let cumulativeDelta = 0;

  const previewBudget = MAX_DIFF_SUMMARY_CHARS + 128;
  const hunkBlocks: string[] = [];
  let previewChars = 0;
  let previewTruncated = false;
  let openHunk: OpenDiffHunk | null = null;

  const pushPreviewLine = (hunk: OpenDiffHunk, line: string) => {
    if (previewTruncated) return;
    hunk.lines.push(line);
    previewChars += line.length + 1;
    if (previewChars > previewBudget) {
      previewTruncated = true;
    }
  };

  const finalizeOpenHunk = () => {
    if (!openHunk) return;
    const hunkOldEndIdx = Math.min(totalOldLines, openHunk.lastOpEndIdx + DIFF_CONTEXT_LINES);
    if (!previewTruncated) {
      for (let k = openHunk.lastOpEndIdx; k < hunkOldEndIdx; k++) {
        pushPreviewLine(openHunk, ` ${lines[k]}`);
        if (previewTruncated) break;
      }
    }
    const oldCount = hunkOldEndIdx - openHunk.oldStartIdx;
    const newCount = oldCount + openHunk.delta;
    const oldStart1 = oldCount === 0 ? openHunk.oldStartIdx : openHunk.oldStartIdx + 1;
    const newStart1 = newCount === 0 ? openHunk.newStartIdx : openHunk.newStartIdx + 1;
    const header = `@@ -${oldStart1},${oldCount} +${newStart1},${newCount} @@`;
    hunkBlocks.push([header, ...openHunk.lines].join('\n'));
    previewChars += header.length + 1;
    if (previewChars > previewBudget) {
      previewTruncated = true;
    }
    openHunk = null;
  };

  const recordOpInHunk = (
    opOldStart: number,
    opOldEnd: number,
    opNewLines: string[] | null,
    opDelta: number,
  ) => {
    if (openHunk && opOldStart - openHunk.lastOpEndIdx <= DIFF_CONTEXT_LINES * 2) {
      if (!previewTruncated) {
        for (let k = openHunk.lastOpEndIdx; k < opOldStart; k++) {
          pushPreviewLine(openHunk, ` ${lines[k]}`);
          if (previewTruncated) break;
        }
        if (!previewTruncated) {
          for (let k = opOldStart; k < opOldEnd; k++) {
            pushPreviewLine(openHunk, `-${lines[k]}`);
            if (previewTruncated) break;
          }
        }
        if (!previewTruncated && opNewLines) {
          for (const newLine of opNewLines) {
            pushPreviewLine(openHunk, `+${newLine}`);
            if (previewTruncated) break;
          }
        }
      }
      openHunk.lastOpEndIdx = opOldEnd;
      openHunk.delta += opDelta;
    } else {
      finalizeOpenHunk();
      if (!previewTruncated) {
        const hunkOldStartIdx = Math.max(0, opOldStart - DIFF_CONTEXT_LINES);
        const hunkNewStartIdx = hunkOldStartIdx + cumulativeDelta;
        openHunk = {
          delta: opDelta,
          lastOpEndIdx: opOldEnd,
          lines: [],
          newStartIdx: hunkNewStartIdx,
          oldStartIdx: hunkOldStartIdx,
        };
        for (let k = hunkOldStartIdx; k < opOldStart; k++) {
          pushPreviewLine(openHunk, ` ${lines[k]}`);
          if (previewTruncated) break;
        }
        if (!previewTruncated) {
          for (let k = opOldStart; k < opOldEnd; k++) {
            pushPreviewLine(openHunk, `-${lines[k]}`);
            if (previewTruncated) break;
          }
        }
        if (!previewTruncated && opNewLines) {
          for (const newLine of opNewLines) {
            pushPreviewLine(openHunk, `+${newLine}`);
            if (previewTruncated) break;
          }
        }
      }
    }
    cumulativeDelta += opDelta;
  };

  let lineCursor = 0;
  let spanIdx = 0;

  while (spanIdx < allSpans.length && totalOldLines > 0) {
    const firstSpan = allSpans[spanIdx];
    while (lineCursor + 1 < totalOldLines && lineStarts[lineCursor + 1] <= firstSpan.start) {
      lineCursor++;
    }
    const blockStartLine = lineCursor;
    let blockEndLine = blockStartLine + 1;
    const spansStart = spanIdx;
    let spansEnd = spanIdx;

    while (true) {
      while (spansEnd < allSpans.length) {
        const s = allSpans[spansEnd];
        const nextLineStart =
          blockEndLine < totalOldLines ? lineStarts[blockEndLine] : normalized.length;
        if (s.start >= nextLineStart) break;

        while (lineCursor + 1 < totalOldLines && lineStarts[lineCursor + 1] <= s.end - 1) {
          lineCursor++;
        }
        if (lineCursor + 1 > blockEndLine) {
          blockEndLine = lineCursor + 1;
        }
        spansEnd++;
      }

      if (blockEndLine < totalOldLines) {
        const lastSpan = allSpans[spansEnd - 1];
        const blockCharEnd = lineEnds[blockEndLine - 1] + 1;
        if (
          lastSpan.end === blockCharEnd &&
          !lastSpan.replacement.endsWith('\n') &&
          (lastSpan.replacement.length > 0 ||
            doesBlockHaveUnclosedPrefix(
              normalized,
              lineStarts[blockStartLine],
              allSpans,
              spansStart,
              spansEnd,
            ))
        ) {
          blockEndLine++;
          continue;
        }
      }
      break;
    }

    spanIdx = spansEnd;

    // Fast path once preview budget is full: single inline non-empty single-line replacement
    if (
      previewTruncated &&
      spansEnd - spansStart === 1 &&
      blockEndLine - blockStartLine === 1 &&
      firstSpan.end <= lineEnds[blockStartLine] &&
      firstSpan.replacement.length > 0 &&
      !firstSpan.replacement.includes('\n')
    ) {
      const same =
        firstSpan.replacement.length === firstSpan.end - firstSpan.start &&
        normalized.startsWith(firstSpan.replacement, firstSpan.start);
      if (!same) {
        totalDeleted += 1;
        totalAdded += 1;
        if (openHunk) {
          recordOpInHunk(blockStartLine, blockEndLine, null, 0);
        }
      }
      continue;
    }

    const blockHasTrailingNl = blockEndLine < totalOldLines || sourceHasTrailingNl;
    const blockCharStart = lineStarts[blockStartLine];
    const blockCharEnd = blockHasTrailingNl ? lineEnds[blockEndLine - 1] + 1 : normalized.length;

    const parts: string[] = [];
    let pos = blockCharStart;
    for (let k = spansStart; k < spansEnd; k++) {
      const s = allSpans[k];
      if (s.start > pos) parts.push(normalized.slice(pos, s.start));
      parts.push(s.replacement);
      pos = s.end;
    }
    if (pos < blockCharEnd) parts.push(normalized.slice(pos, blockCharEnd));
    const patchedBlockText = parts.join('');

    let newBlockLines: string[];
    if (patchedBlockText.length === 0) {
      newBlockLines = [];
    } else if (patchedBlockText.endsWith('\n')) {
      newBlockLines = patchedBlockText.slice(0, -1).split('\n');
    } else {
      newBlockLines = patchedBlockText.split('\n');
    }

    const oldLen = blockEndLine - blockStartLine;
    const newLen = newBlockLines.length;
    const minLen = Math.min(oldLen, newLen);

    let prefixLen = 0;
    while (prefixLen < minLen && lines[blockStartLine + prefixLen] === newBlockLines[prefixLen]) {
      prefixLen++;
    }

    let suffixLen = 0;
    while (
      suffixLen < minLen - prefixLen &&
      lines[blockEndLine - 1 - suffixLen] === newBlockLines[newLen - 1 - suffixLen]
    ) {
      suffixLen++;
    }

    const opOldStart = blockStartLine + prefixLen;
    const opOldEnd = blockEndLine - suffixLen;
    const delCount = opOldEnd - opOldStart;
    const addCount = newLen - prefixLen - suffixLen;

    if (delCount === 0 && addCount === 0) continue;

    totalDeleted += delCount;
    totalAdded += addCount;
    const opDelta = addCount - delCount;

    if (!previewTruncated || openHunk) {
      const opNewLines = previewTruncated
        ? null
        : newBlockLines.slice(prefixLen, newLen - suffixLen);
      recordOpInHunk(opOldStart, opOldEnd, opNewLines, opDelta);
    } else {
      cumulativeDelta += opDelta;
    }
  }

  finalizeOpenHunk();

  const linesBefore = totalOldLines;
  const linesAfter = linesBefore + totalAdded - totalDeleted;
  const occurrenceSuffix =
    appliedOccurrences !== appliedEdits ? ` (${appliedOccurrences} replacements)` : '';
  // eslint-disable-next-line unicorn/text-encoding-identifier-case
  const resolvedTargetEncoding = targetEncoding ?? 'utf-8';
  const statsLine = `Patch applied: ${appliedEdits} edit${appliedEdits === 1 ? '' : 's'}${occurrenceSuffix}, lines ${linesBefore} -> ${linesAfter} (+${totalAdded} / -${totalDeleted}), encoding ${sourceEncoding} -> ${resolvedTargetEncoding}, lineEnding ${lineEnding}.`;

  if (hunkBlocks.length === 0) {
    return {
      diffSummary:
        patchedNormalized === normalized
          ? `${statsLine}\n(no textual changes)`
          : `${statsLine}\n(trailing newline updated)`,
      linesAfter,
      linesBefore,
    };
  }

  const full = `${statsLine}\n${hunkBlocks.join('\n')}`;
  if (!previewTruncated && full.length <= MAX_DIFF_SUMMARY_CHARS) {
    return { diffSummary: full, linesAfter, linesBefore };
  }

  const suffix = '\n...(truncated)';
  const diffSummary =
    full.length <= MAX_DIFF_SUMMARY_CHARS - suffix.length
      ? full + suffix
      : full.slice(0, MAX_DIFF_SUMMARY_CHARS - suffix.length) + suffix;
  return { diffSummary, linesAfter, linesBefore };
};

const formatFailureSummary = (diagnostics: PatchEditDiagnostic[]): string => {
  const failed = diagnostics.filter((d) => !d.ok);
  const summaryLines = diagnostics.map((d) => {
    if (d.ok) {
      const range =
        d.startLine !== undefined && d.endLine !== undefined
          ? d.startLine === d.endLine
            ? `L${d.startLine}`
            : `L${d.startLine}..${d.endLine}`
          : '';
      return `edit[${d.index}]: ok (${range}${d.level ? `, ${d.level}` : ''})`;
    }
    return `edit[${d.index}]: ${d.code ?? 'error'} — ${d.message}`;
  });
  return `Atomic patch rejected (${failed.length}/${diagnostics.length} failed, 0 changes saved):\n${summaryLines.join('\n')}`;
};

export function applyAtomicPatch(
  source: string,
  edits: PatchEdit[],
  options: ApplyAtomicPatchOptions = {},
): ApplyAtomicPatchResult {
  const maxOutputBytes = options.maxOutputBytes ?? MAX_PATCH_OUTPUT_BYTES;

  if (!Array.isArray(edits) || edits.length < 1 || edits.length > MAX_PATCH_EDITS) {
    return {
      code: 'invalid_patch',
      diagnostics: [],
      error: `edits must contain between 1 and ${MAX_PATCH_EDITS} items.`,
      ok: false,
    };
  }

  // Validate batch byte budget and per-edit shape before matching.
  let batchBytes = 0;
  const validationDiagnostics: PatchEditDiagnostic[] = [];
  let hasInvalidEdit = false;

  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    if (!edit || typeof edit !== 'object') {
      hasInvalidEdit = true;
      validationDiagnostics.push({
        code: 'invalid_edit',
        index: i,
        message: 'Edit entry must be an object.',
        ok: false,
      });
      continue;
    }

    const { endLine, newText, oldText, startLine } = edit;
    if (
      typeof oldText !== 'string' ||
      oldText.length === 0 ||
      oldText.includes('\0') ||
      !isExactUtf8(oldText)
    ) {
      hasInvalidEdit = true;
      validationDiagnostics.push({
        code: 'invalid_edit',
        index: i,
        message: 'oldText must be a non-empty valid UTF-8 string without NUL bytes.',
        ok: false,
      });
      continue;
    }

    if (typeof newText !== 'string' || newText.includes('\0') || !isExactUtf8(newText)) {
      hasInvalidEdit = true;
      validationDiagnostics.push({
        code: 'invalid_edit',
        index: i,
        message: 'newText must be a valid UTF-8 string without NUL bytes.',
        ok: false,
      });
      continue;
    }

    if (
      (startLine !== undefined && (!Number.isSafeInteger(startLine) || startLine < 1)) ||
      (endLine !== undefined && (!Number.isSafeInteger(endLine) || endLine < 1)) ||
      (startLine !== undefined && endLine !== undefined && endLine < startLine)
    ) {
      hasInvalidEdit = true;
      validationDiagnostics.push({
        code: 'invalid_edit',
        index: i,
        message: 'startLine and endLine must be positive integers with startLine <= endLine.',
        ok: false,
      });
      continue;
    }

    batchBytes += Buffer.byteLength(oldText, 'utf8') + Buffer.byteLength(newText, 'utf8');
    validationDiagnostics.push({ index: i, message: 'valid', ok: true });
  }

  if (hasInvalidEdit) {
    return {
      code: 'invalid_patch',
      diagnostics: validationDiagnostics,
      error: formatFailureSummary(validationDiagnostics),
      ok: false,
    };
  }

  if (batchBytes > MAX_PATCH_BATCH_BYTES) {
    return {
      code: 'invalid_patch',
      diagnostics: [],
      error: `Total edit batch size (${batchBytes} bytes) exceeds ${MAX_PATCH_BATCH_BYTES} bytes limit.`,
      ok: false,
    };
  }

  const hasBom = source.startsWith('\uFEFF');
  const sourceWithoutBom = hasBom ? source.slice(1) : source;
  const lineEnding = detectLineEnding(sourceWithoutBom);
  const sourceNormalized = normalizeNewlines(sourceWithoutBom);
  const index = buildLineIndex(sourceNormalized);
  const totalLines = index.logicalLineCount;

  const diagnostics: PatchEditDiagnostic[] = [];
  const allSpans: ResolvedSpan[] = [];

  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    const oldNorm = normalizeNewlines(edit.oldText);
    const newNorm = normalizeNewlines(edit.newText);
    const replaceAll = edit.replaceAll === true;

    const hasRange = edit.startLine !== undefined || edit.endLine !== undefined;
    const oldLineCount = countLogicalLines(oldNorm);
    const reqStart = edit.startLine ?? 1;
    const reqEnd =
      edit.endLine ??
      (edit.startLine !== undefined ? edit.startLine + Math.max(0, oldLineCount - 1) : totalLines);
    const winStart = hasRange ? Math.max(1, reqStart - LINE_WINDOW_MARGIN) : 1;
    const winEnd = hasRange ? Math.min(totalLines, reqEnd + LINE_WINDOW_MARGIN) : totalLines;

    const result = runMatchCascade(index, oldNorm, newNorm, winStart, winEnd, replaceAll);

    if (result.matches.length === 0) {
      if (result.indentMismatch) {
        diagnostics.push({
          code: 'indent_mismatch',
          index: i,
          message:
            'Matched block indentation cannot be safely applied to newText (negative or mixed indentation).',
          ok: false,
        });
        continue;
      }

      if (hasRange && totalLines > 0) {
        const fullResult = runMatchCascade(index, oldNorm, newNorm, 1, totalLines, true);
        if (fullResult.matches.length > 0) {
          const matchLines = fullResult.matches
            .slice(0, MAX_REPORTED_MATCH_LINES)
            .map((m) => offsetToLine(index.lineStarts, m.start));
          const rangeLabel =
            edit.startLine !== undefined && edit.endLine !== undefined
              ? `L${edit.startLine}..${edit.endLine}`
              : edit.startLine !== undefined
                ? `L${edit.startLine}`
                : `L1..${edit.endLine}`;
          diagnostics.push({
            code: 'not_found_in_range',
            index: i,
            matchLines,
            message: `Not found in requested range ${rangeLabel} (margin ±${LINE_WINDOW_MARGIN}); found elsewhere at line(s) ${matchLines.join(', ')}. Update startLine/endLine or omit them.`,
            occurrences: fullResult.matches.length,
            ok: false,
          });
          continue;
        }
      }

      diagnostics.push({
        code: 'not_found',
        index: i,
        message: 'oldText was not found in the file.',
        ok: false,
      });
      continue;
    }

    if (result.matches.length > 1 && !replaceAll) {
      const matchLines = result.matches
        .slice(0, MAX_REPORTED_MATCH_LINES)
        .map((m) => offsetToLine(index.lineStarts, m.start));
      diagnostics.push({
        code: 'ambiguous_match',
        index: i,
        matchLines,
        message: `Found ${result.matches.length} matches (lines: ${matchLines.join(', ')}${result.matches.length > MAX_REPORTED_MATCH_LINES ? ', ...' : ''}). Add more surrounding context, specify startLine/endLine, or set replaceAll: true.`,
        occurrences: result.matches.length,
        ok: false,
      });
      continue;
    }

    for (const match of result.matches) {
      allSpans.push({
        editIndex: i,
        end: match.end,
        level: match.level,
        replacement: match.replacement,
        start: match.start,
      });
    }

    const firstMatch = result.matches[0];
    const startLine = offsetToLine(index.lineStarts, firstMatch.start);
    const endLine = offsetToLine(index.lineStarts, Math.max(firstMatch.start, firstMatch.end - 1));

    diagnostics.push({
      endLine,
      index: i,
      level: firstMatch.level,
      message:
        result.matches.length > 1
          ? `Matched ${result.matches.length} occurrences (${firstMatch.level}).`
          : `Matched L${startLine}..${endLine} (${firstMatch.level}).`,
      occurrences: result.matches.length,
      ok: true,
      startLine,
    });
  }

  // Sort spans by (start, end, editIndex) and verify strict non-overlap across original snapshot.
  allSpans.sort((a, b) => a.start - b.start || a.end - b.end || a.editIndex - b.editIndex);

  const overlapMap = new Map<number, Set<number>>();
  const recordOverlap = (a: number, b: number) => {
    if (!overlapMap.has(a)) overlapMap.set(a, new Set());
    if (!overlapMap.has(b)) overlapMap.set(b, new Set());
    if (a !== b) {
      overlapMap.get(a)!.add(b);
      overlapMap.get(b)!.add(a);
    } else {
      overlapMap.get(a)!.add(a);
    }
  };

  for (let i = 0; i < allSpans.length; i++) {
    const prev = allSpans[i];
    for (let j = i + 1; j < allSpans.length; j++) {
      const curr = allSpans[j];
      if (curr.start > prev.end) break;
      const overlaps =
        prev.end > curr.start ||
        (prev.end === curr.start && (prev.start === prev.end || curr.start === curr.end));
      if (overlaps) {
        recordOverlap(prev.editIndex, curr.editIndex);
      }
    }
  }

  for (const [editIdx, conflicts] of overlapMap) {
    const conflictList = [...conflicts].sort((a, b) => a - b);
    diagnostics[editIdx] = {
      code: 'overlapping_edits',
      index: editIdx,
      message: `Overlaps with edit(s) ${conflictList.map((n) => `#${n}`).join(', ')}.`,
      ok: false,
      overlappingWith: conflictList,
    };
  }

  if (diagnostics.some((d) => !d.ok)) {
    return {
      code: 'patch_failed',
      diagnostics,
      error: formatFailureSummary(diagnostics),
      ok: false,
    };
  }

  // Single-pass O(N) assembly.
  let patchedNormalized: string;
  const singleEdit = edits.length === 1 ? edits[0] : undefined;
  const singleNewNorm = singleEdit ? normalizeNewlines(singleEdit.newText) : '';
  if (
    singleEdit &&
    singleEdit.replaceAll === true &&
    singleEdit.startLine === undefined &&
    singleEdit.endLine === undefined &&
    allSpans.length > 0 &&
    allSpans[0].level === 'exact' &&
    !singleNewNorm.includes('$')
  ) {
    patchedNormalized = sourceNormalized.replaceAll(
      normalizeNewlines(singleEdit.oldText),
      singleNewNorm,
    );
  } else {
    const chunks: string[] = [];
    let cursor = 0;
    for (const span of allSpans) {
      if (span.start > cursor) {
        chunks.push(sourceNormalized.slice(cursor, span.start));
      }
      chunks.push(span.replacement);
      cursor = span.end;
    }
    if (cursor < sourceNormalized.length) {
      chunks.push(sourceNormalized.slice(cursor));
    }
    patchedNormalized = chunks.join('');
  }
  const withLineEndings =
    lineEnding === 'CRLF' ? patchedNormalized.replaceAll('\n', '\r\n') : patchedNormalized;
  const finalContent = hasBom ? '\uFEFF' + withLineEndings : withLineEndings;

  const finalBytes = Buffer.byteLength(finalContent, 'utf8');
  if (finalBytes > maxOutputBytes) {
    return {
      code: 'size_limit',
      diagnostics,
      error: `Patched file size (${finalBytes} bytes) exceeds the ${Math.round(maxOutputBytes / (1024 * 1024)) || 2} MiB (${maxOutputBytes} bytes) ceiling for patchFile. Do not retry patchFile with the same expansion — reduce output size, split into smaller files, or process via a script/E2B sandbox.`,
      ok: false,
    };
  }

  // eslint-disable-next-line unicorn/text-encoding-identifier-case
  const sourceEncoding = options.sourceEncoding ?? (hasBom ? 'utf-8-bom' : 'utf-8');
  const { diffSummary, linesAfter, linesBefore } = formatDiffSummary({
    allSpans,
    appliedEdits: edits.length,
    appliedOccurrences: allSpans.length,
    index,
    lineEnding,
    patchedNormalized,
    sourceEncoding,
    targetEncoding: options.targetEncoding,
  });

  return {
    appliedEdits: edits.length,
    appliedOccurrences: allSpans.length,
    content: finalContent,
    diagnostics,
    diffSummary,
    hasBom,
    lineEnding,
    linesAfter,
    linesBefore,
    ok: true,
  };
}
