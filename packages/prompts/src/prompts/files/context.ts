/** Limits apply to the working prompt, never to the stored source. */
export const FILE_PREVIEW_CHARS = 8_000;
export const FILE_CONTEXT_CHARS = 32_000;
export const FILE_READ_CHARS = 20_000;
export const FILE_READ_DEFAULT_MAX_LINES = 250;
export const FILE_READ_MIN_LINES = 1;
export const FILE_READ_MAX_LINES = 500;
export const FILE_READ_MAX_MATCHES = 50;
export const FILE_READ_MATCH_PREVIEW_CHARS = 160;

export type FileReadLineEnding = 'CRLF' | 'LF';

export interface FileReadMatch {
  /** 1-based line number containing this match. */
  line: number;
  /** UTF-16 character offset of this match in the original source. */
  offset: number;
  /** Single-line excerpt (at most 160 chars) around this match. */
  preview: string;
}

export interface FileReadOptions {
  /** Max lines per page in line mode (default 250, clamped to 1..500). */
  maxLines?: number;
  /** UTF-16 character offset, returned unchanged by the reader as nextOffset. */
  offset?: number;
  /** Case-insensitive literal search; never a regular expression. */
  query?: string;
  /** 1-based line number for line-numbered reading (`L<N>: <line>`). */
  startLine?: number;
}

export interface FileReadPage {
  /** True only when this response contains the entire source. */
  complete: boolean;
  content: string;
  endLine?: number;
  endOffset: number;
  lineEnding?: FileReadLineEnding;
  matches?: FileReadMatch[];
  nextOffset: number | null;
  nextStartLine?: number | null;
  query?: string;
  startLine?: number;
  startOffset: number;
  totalCharCount: number;
  totalLines?: number;
  totalMatches?: number;
}

interface SourceLine {
  rawEndOffset: number;
  startOffset: number;
  text: string;
}

const detectLineEnding = (content: string): FileReadLineEnding => {
  let crlfCount = 0;
  let loneLfCount = 0;
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) {
      if (i > 0 && content.charCodeAt(i - 1) === 13) {
        crlfCount++;
      } else {
        loneLfCount++;
      }
    }
  }
  return crlfCount > 0 && crlfCount >= loneLfCount ? 'CRLF' : 'LF';
};

const parseSourceLines = (content: string): SourceLine[] => {
  if (!content.length) return [];
  const lines: SourceLine[] = [];
  let pos = 0;
  while (pos < content.length) {
    const nl = content.indexOf('\n', pos);
    if (nl === -1) {
      lines.push({
        rawEndOffset: content.length,
        startOffset: pos,
        text: content.slice(pos),
      });
      break;
    }
    const textEnd = nl > pos && content.charCodeAt(nl - 1) === 13 ? nl - 1 : nl;
    lines.push({
      rawEndOffset: nl + 1,
      startOffset: pos,
      text: content.slice(pos, textEnd),
    });
    pos = nl + 1;
  }
  return lines;
};

const buildMatchPreview = (
  content: string,
  lineStart: number,
  lineTextEnd: number,
  matchIndex: number,
): string => {
  const lineLen = lineTextEnd - lineStart;
  if (lineLen <= FILE_READ_MATCH_PREVIEW_CHARS) {
    return content.slice(lineStart, lineTextEnd);
  }
  const relStart = matchIndex - lineStart;
  let sliceStart = Math.max(0, relStart - 40);
  const hasLeadingEllipsis = sliceStart > 0;
  const maxInner = FILE_READ_MATCH_PREVIEW_CHARS - (hasLeadingEllipsis ? 1 : 0);
  let sliceEnd = Math.min(lineLen, sliceStart + maxInner);
  const hasTrailingEllipsis = sliceEnd < lineLen;
  if (hasTrailingEllipsis) {
    sliceEnd = Math.min(lineLen, sliceStart + maxInner - 1);
  }
  if (!hasTrailingEllipsis && sliceEnd - sliceStart < maxInner) {
    sliceStart = Math.max(0, sliceEnd - maxInner);
  }
  let absStart = lineStart + sliceStart;
  let absEnd = lineStart + sliceEnd;
  if (absStart > lineStart && /[\uDC00-\uDFFF]/.test(content[absStart])) absStart++;
  if (absEnd < lineTextEnd && /[\uD800-\uDBFF]/.test(content[absEnd - 1])) absEnd--;
  const prefix = absStart > lineStart ? '…' : '';
  const suffix = absEnd < lineTextEnd ? '…' : '';
  return `${prefix}${content.slice(absStart, Math.max(absStart, absEnd))}${suffix}`;
};

const collectQueryMatches = (
  content: string,
  escapedQuery: string,
  fromOffset: number,
): { firstMatchOffset: number | null; matches: FileReadMatch[]; totalMatches: number } => {
  const re = new RegExp(escapedQuery, 'giu');
  re.lastIndex = fromOffset;
  const matches: FileReadMatch[] = [];
  let totalMatches = 0;
  let firstMatchOffset: number | null = null;
  let scanPos = 0;
  let currentLine = 1;
  let currentLineStart = 0;

  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const matchIndex = m.index;
    if (firstMatchOffset === null) firstMatchOffset = matchIndex;
    totalMatches++;

    if (matches.length < FILE_READ_MAX_MATCHES) {
      while (scanPos < matchIndex) {
        const nl = content.indexOf('\n', scanPos);
        if (nl === -1 || nl >= matchIndex) {
          scanPos = matchIndex;
          break;
        }
        currentLine++;
        currentLineStart = nl + 1;
        scanPos = nl + 1;
      }
      const nextNl = content.indexOf('\n', matchIndex);
      const lineRawEnd = nextNl === -1 ? content.length : nextNl;
      const lineTextEnd =
        lineRawEnd > currentLineStart && content.charCodeAt(lineRawEnd - 1) === 13
          ? lineRawEnd - 1
          : lineRawEnd;
      matches.push({
        line: currentLine,
        offset: matchIndex,
        preview: buildMatchPreview(content, currentLineStart, lineTextEnd, matchIndex),
      });
    }

    if (m[0].length === 0) re.lastIndex++;
  }

  return { firstMatchOffset, matches, totalMatches };
};

const readLinePage = (
  content: string,
  options: FileReadOptions,
  effectiveLimit: number,
  query: string | undefined,
  escaped: string | undefined,
): FileReadPage => {
  const lines = parseSourceLines(content);
  const totalLines = lines.length;
  const lineEnding = detectLineEnding(content);
  const requestedStartLine = Number.isFinite(options.startLine)
    ? Math.max(1, Math.floor(options.startLine!))
    : 1;
  const rawMaxLines = Number.isFinite(options.maxLines)
    ? Math.floor(options.maxLines!)
    : FILE_READ_DEFAULT_MAX_LINES;
  const maxLines = Math.min(FILE_READ_MAX_LINES, Math.max(FILE_READ_MIN_LINES, rawMaxLines));

  let queryMatches: { matches: FileReadMatch[]; totalMatches: number } | undefined;
  let effectiveStartLine = requestedStartLine;

  if (query && escaped) {
    const searchFromOffset =
      requestedStartLine <= totalLines ? lines[requestedStartLine - 1].startOffset : content.length;
    const collected = collectQueryMatches(content, escaped, searchFromOffset);
    queryMatches = { matches: collected.matches, totalMatches: collected.totalMatches };
    if (collected.firstMatchOffset === null) {
      return {
        complete: false,
        content: '',
        endLine: 0,
        endOffset: content.length,
        lineEnding,
        matches: collected.matches,
        nextOffset: null,
        nextStartLine: null,
        query,
        startLine: requestedStartLine,
        startOffset: content.length,
        totalCharCount: content.length,
        totalLines,
        totalMatches: collected.totalMatches,
      };
    }
    effectiveStartLine = Math.max(requestedStartLine, collected.matches[0].line - 5);
  }

  if (totalLines === 0 || effectiveStartLine > totalLines) {
    return {
      complete: !query && totalLines === 0 && effectiveStartLine === 1,
      content: '',
      endLine: 0,
      endOffset: content.length,
      lineEnding,
      ...queryMatches,
      nextOffset: null,
      nextStartLine: null,
      query,
      startLine: effectiveStartLine,
      startOffset: content.length,
      totalCharCount: content.length,
      totalLines,
    };
  }

  const startIdx = effectiveStartLine - 1;
  const maxIdx = Math.min(totalLines, startIdx + maxLines);
  const outputLines: string[] = [];
  let usedChars = 0;
  let lastIdx = startIdx;
  let lineTruncated = false;
  let keptLineChars = 0;

  for (let idx = startIdx; idx < maxIdx; idx++) {
    const lineNum = idx + 1;
    const lineText = lines[idx].text;
    const prefix = `L${lineNum}: `;
    const formatted = `${prefix}${lineText}`;
    const sep = outputLines.length > 0 ? 1 : 0;

    if (usedChars + sep + formatted.length <= effectiveLimit) {
      outputLines.push(formatted);
      usedChars += sep + formatted.length;
      lastIdx = idx;
      continue;
    }

    if (outputLines.length > 0) break;

    // Even a single line exceeds the character budget (e.g. minified file): truncate safely
    // without splitting a UTF-16 surrogate pair so page length never exceeds effectiveLimit.
    const suffix = `… [truncated: ${lineText.length} chars]`;
    const available = effectiveLimit - prefix.length - suffix.length;
    if (available > 0) {
      let cut = Math.min(lineText.length, available);
      if (cut > 0 && cut < lineText.length && /[\uD800-\uDBFF]/.test(lineText[cut - 1])) {
        cut--;
      }
      outputLines.push(`${prefix}${lineText.slice(0, cut)}${suffix}`);
      keptLineChars = cut;
    } else {
      let cut = Math.min(formatted.length, effectiveLimit);
      if (cut > 0 && cut < formatted.length && /[\uD800-\uDBFF]/.test(formatted[cut - 1])) {
        cut--;
      }
      outputLines.push(formatted.slice(0, cut));
      keptLineChars = Math.max(0, cut - prefix.length);
    }
    lastIdx = idx;
    lineTruncated = true;
    break;
  }

  const endLine = lastIdx + 1;
  const nextStartLine = endLine < totalLines ? endLine + 1 : null;
  const startOffset = lines[startIdx].startOffset;
  const endOffset = lineTruncated
    ? Math.min(lines[lastIdx].rawEndOffset, startOffset + keptLineChars)
    : lines[lastIdx].rawEndOffset;

  return {
    complete: !query && effectiveStartLine === 1 && endLine === totalLines && !lineTruncated,
    content: outputLines.join('\n'),
    endLine,
    endOffset,
    lineEnding,
    ...queryMatches,
    nextOffset: endOffset < content.length ? endOffset : null,
    nextStartLine,
    query,
    startLine: effectiveStartLine,
    startOffset,
    totalCharCount: content.length,
    totalLines,
  };
};

export function readFilePage(
  content: string,
  options: FileReadOptions = {},
  limit = FILE_READ_CHARS,
): FileReadPage {
  if (
    options.query !== undefined &&
    (typeof options.query !== 'string' || options.query.length > 500)
  ) {
    throw new Error(
      'Use a literal query of at most 500 characters, or omit query for sequential reading.',
    );
  }
  const effectiveLimit = Math.max(2, limit);
  const query = options.query?.trim();
  // Escaping avoids regex interpretation while /iu preserves original source offsets
  // (lowercasing the whole source can change its length for some Unicode characters).
  const escaped = query?.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');

  if (options.startLine !== undefined || options.maxLines !== undefined) {
    return readLinePage(content, options, effectiveLimit, query, escaped);
  }

  const offset = Math.min(
    content.length,
    Math.max(0, Math.floor(Number.isFinite(options.offset) ? options.offset! : 0)),
  );

  if (query && escaped) {
    const { firstMatchOffset, matches, totalMatches } = collectQueryMatches(
      content,
      escaped,
      offset,
    );
    const startOffset =
      firstMatchOffset !== null ? Math.max(offset, firstMatchOffset - 1000) : content.length;
    let endOffset = Math.min(content.length, startOffset + effectiveLimit);
    // Do not split a surrogate pair. Preserve exact cursor coverage across pages.
    if (endOffset < content.length && /[\uD800-\uDBFF]/.test(content[endOffset - 1])) endOffset--;
    return {
      complete: false,
      content: content.slice(startOffset, endOffset),
      endOffset,
      matches,
      nextOffset: endOffset < content.length ? endOffset : null,
      query,
      startOffset,
      totalCharCount: content.length,
      totalMatches,
    };
  }

  const startOffset = offset;
  let endOffset = Math.min(content.length, startOffset + effectiveLimit);
  // Do not split a surrogate pair. Preserve exact cursor coverage across pages.
  if (endOffset < content.length && /[\uD800-\uDBFF]/.test(content[endOffset - 1])) endOffset--;
  return {
    complete: startOffset === 0 && endOffset === content.length,
    content: content.slice(startOffset, endOffset),
    endOffset,
    nextOffset: endOffset < content.length ? endOffset : null,
    query,
    startOffset,
    totalCharCount: content.length,
  };
}

interface SourceMessage {
  compressedMessages?: SourceMessage[];
  fileList?: { id: string; name: string }[];
}

/** Deterministic references: a summarizer must never be able to lose file access. */
export function fileReferences(messages: SourceMessage[]): string {
  const files = new Map<string, string>();
  const visit = (items: SourceMessage[]) => {
    for (const message of items) {
      for (const file of message.fileList || []) files.set(file.id, file.name);
      if (message.compressedMessages) visit(message.compressedMessages);
    }
  };
  visit(messages);
  if (!files.size) return '';
  return (
    '\n<original_files>Use readKnowledge with these IDs to retrieve originals automatically.\n' +
    JSON.stringify([...files].map(([fileId, name]) => ({ fileId, name }))) +
    '\n</original_files>'
  );
}

export function filePreview(content: string, limit = FILE_PREVIEW_CHARS): string {
  if (content.length <= limit) return content;
  const prefix = content.slice(0, Math.max(0, limit));
  const newline = prefix.lastIndexOf('\n');
  const preview = newline > 0 ? prefix.slice(0, newline) : prefix;
  return (
    `${preview}\n[Partial preview: ${preview.length} of ${content.length} characters. ` +
    'Original is retained. Use readKnowledge with this file ID and offset=0; follow nextOffset to read further, ' +
    'or pass query for literal search. Search hits/previews do not establish complete coverage. ' +
    'For exhaustive lists/comparisons read every page; for counts/aggregations process the full original with the available code tool. ' +
    'Do not ask the user to select excerpts or perform these steps.]'
  );
}
