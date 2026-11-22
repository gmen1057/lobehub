const CODE_ARTIFACT_SRC_PREFIX = '/chat/code-artifact/';
const OPEN_TAG_LOWER = '<lobeartifact';
const CLOSE_TAG_LOWER = '</lobeartifact';

interface ParsedAttrSpan {
  name: string;
  spanEnd: number;
  spanStart: number;
  value: string;
}

const isTagNameChar = (ch: string | undefined): boolean => {
  if (!ch) return false;
  const code = ch.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) || // 0-9
    (code >= 65 && code <= 90) || // A-Z
    (code >= 97 && code <= 122) || // a-z
    code === 95 || // _
    code === 45 // -
  );
};

const isWhitespace = (ch: string | undefined): boolean =>
  ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f';

const isAttrNameStart = (ch: string | undefined): boolean => {
  if (!ch) return false;
  const code = ch.charCodeAt(0);
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95 || // _
    code === 58 // :
  );
};

const isAttrNameChar = (ch: string | undefined): boolean =>
  isTagNameChar(ch) || ch === ':' || ch === '.';

const decodeXmlEntities = (value: string): string =>
  value
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');

const scanAttributes = (raw: string): ParsedAttrSpan[] => {
  const result: ParsedAttrSpan[] = [];
  let i = 0;
  const len = raw.length;

  while (i < len) {
    const wsStart = i;
    while (i < len && isWhitespace(raw[i])) i++;
    if (i >= len) break;

    if (!isAttrNameStart(raw[i])) {
      i++;
      continue;
    }

    const nameStart = i;
    while (i < len && isAttrNameChar(raw[i])) i++;
    const name = raw.slice(nameStart, i).toLowerCase();

    while (i < len && isWhitespace(raw[i])) i++;
    if (i >= len || raw[i] !== '=') continue;
    i++; // consume '='
    while (i < len && isWhitespace(raw[i])) i++;
    if (i >= len) break;

    let value = '';
    if (raw[i] === '\\' && (raw[i + 1] === '"' || raw[i + 1] === "'")) {
      const quote = raw[i + 1];
      i += 2;
      const valStart = i;
      while (i < len) {
        if (raw[i] === '\\' && raw[i + 1] === quote) {
          value = raw.slice(valStart, i);
          i += 2;
          break;
        }
        i++;
      }
      if (i >= len && !value && valStart < len) {
        value = raw.slice(valStart, len);
      }
    } else if (raw[i] === '"' || raw[i] === "'") {
      const quote = raw[i];
      i += 1;
      const valStart = i;
      while (i < len && raw[i] !== quote) i++;
      value = raw.slice(valStart, i);
      if (i < len && raw[i] === quote) i++;
    } else {
      const valStart = i;
      while (i < len && !isWhitespace(raw[i]) && raw[i] !== '/' && raw[i] !== '>') i++;
      value = raw.slice(valStart, i);
    }

    result.push({
      name,
      spanEnd: i,
      spanStart: wsStart,
      value: decodeXmlEntities(value),
    });
  }

  return result;
};

const parseTagAttributes = (attrsRaw: string): Record<string, string> => {
  const attrs: Record<string, string> = {};
  for (const attr of scanAttributes(attrsRaw)) {
    attrs[attr.name] = attr.value;
  }
  return attrs;
};

const stripSrcAttrFromOpenTag = (openTag: string): string => {
  const prefixLen = OPEN_TAG_LOWER.length;
  if (openTag.length <= prefixLen) return openTag;
  const endsWithGt = openTag.endsWith('>');
  const suffixStart = endsWithGt ? openTag.length - 1 : openTag.length;
  const attrsRaw = openTag.slice(prefixLen, suffixStart);
  const attrs = scanAttributes(attrsRaw);
  const srcSpans = attrs.filter((a) => a.name === 'src');
  if (srcSpans.length === 0) return openTag;

  let rebuilt = '';
  let cursor = 0;
  for (const span of srcSpans) {
    rebuilt += attrsRaw.slice(cursor, span.spanStart);
    cursor = span.spanEnd;
  }
  rebuilt += attrsRaw.slice(cursor);
  return openTag.slice(0, prefixLen) + rebuilt + openTag.slice(suffixStart);
};

const formatSavedCodeArtifactNote = (attrs: Record<string, string>, trimmedSrc: string): string => {
  const title = attrs.title?.trim() ?? '';
  const language = attrs.language?.trim() ?? '';
  const afterPrefix = trimmedSrc.slice(CODE_ARTIFACT_SRC_PREFIX.length).replace(/\/+$/, '');
  const fileId = afterPrefix.split(/[/?#]/)[0]?.trim() ?? '';

  const label = title ? `"${title}"` : 'code file';
  const lang = language ? ` (${language})` : '';
  const ref = fileId ? `, fileId=${fileId}` : '';
  const readHint = fileId
    ? ` Use getTopicContext(mode="code_artifacts", fileId="${fileId}") if you need to inspect it.`
    : '';

  return `[Saved ${label}${lang}${ref} — previous code block stored by server.${readHint}]`;
};

const findNextOpenTag = (lower: string, from: number): number => {
  let idx = lower.indexOf(OPEN_TAG_LOWER, from);
  while (idx !== -1) {
    if (!isTagNameChar(lower[idx + OPEN_TAG_LOWER.length])) {
      return idx;
    }
    idx = lower.indexOf(OPEN_TAG_LOWER, idx + OPEN_TAG_LOWER.length);
  }
  return -1;
};

const findNextCloseTag = (
  lower: string,
  from: number,
): { closeEnd: number; closeStart: number } | null => {
  let idx = lower.indexOf(CLOSE_TAG_LOWER, from);
  while (idx !== -1) {
    let j = idx + CLOSE_TAG_LOWER.length;
    while (j < lower.length && isWhitespace(lower[j])) j++;
    if (j < lower.length && lower[j] === '>') {
      return { closeEnd: j + 1, closeStart: idx };
    }
    idx = lower.indexOf(CLOSE_TAG_LOWER, idx + CLOSE_TAG_LOWER.length);
  }
  return null;
};

const scanOpeningTag = (
  text: string,
  lower: string,
  tagStart: number,
): {
  attrsEnd: number;
  incomplete: boolean;
  openEnd: number;
  selfClosing: boolean;
} => {
  let i = tagStart + OPEN_TAG_LOWER.length;
  const len = text.length;
  let quote: '"' | "'" | null = null;
  let escapedQuote = false;
  let lastNonWsOutsideQuoteIdx = -1;

  while (i < len) {
    const ch = text[i];

    if (quote !== null) {
      if (escapedQuote) {
        if (ch === '\\' && text[i + 1] === quote) {
          quote = null;
          escapedQuote = false;
          i += 2;
          continue;
        }
      } else if (ch === quote) {
        quote = null;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }

    if (ch === '\\' && (text[i + 1] === '"' || text[i + 1] === "'")) {
      quote = text[i + 1] as '"' | "'";
      escapedQuote = true;
      lastNonWsOutsideQuoteIdx = i;
      i += 2;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      escapedQuote = false;
      lastNonWsOutsideQuoteIdx = i;
      i += 1;
      continue;
    }

    if (ch === '>') {
      const selfClosing =
        lastNonWsOutsideQuoteIdx >= tagStart + OPEN_TAG_LOWER.length &&
        text[lastNonWsOutsideQuoteIdx] === '/';
      return {
        attrsEnd: selfClosing ? lastNonWsOutsideQuoteIdx : i,
        incomplete: false,
        openEnd: i + 1,
        selfClosing,
      };
    }

    if (
      ch === '<' &&
      lower.startsWith(OPEN_TAG_LOWER, i) &&
      !isTagNameChar(lower[i + OPEN_TAG_LOWER.length])
    ) {
      return {
        attrsEnd: i,
        incomplete: true,
        openEnd: i,
        selfClosing: false,
      };
    }

    if (!isWhitespace(ch)) {
      lastNonWsOutsideQuoteIdx = i;
    }
    i += 1;
  }

  return {
    attrsEnd: len,
    incomplete: true,
    openEnd: len,
    selfClosing: false,
  };
};

/**
 * Single-pass O(n) rewriter for server-generated `<lobeArtifact ... src="/chat/code-artifact/<fileId>/">`
 * tags in conversation history before sending context to an LLM.
 *
 * - Prevents models from seeing raw empty `<lobeArtifact ... src="/chat/code-artifact/...">`
 *   tags in prior turns and mimicking them instead of writing code.
 * - Handles self-closing, paired, unclosed, and backslash-escaped attribute quotes.
 * - Never swallows across a nested `<lobeArtifact` start tag.
 * - Leaves `<lobeArtifact type="text/html" ...>` and non-code-artifact tags untouched.
 * - Preserves non-empty inline bodies by stripping only the `src` attribute from the opening tag.
 * - 100% deterministic for prompt-cache stability.
 */
export const rewriteSavedCodeArtifactTagsForLLM = (text: string): string => {
  if (!text || !text.includes(CODE_ARTIFACT_SRC_PREFIX)) return text;

  const lower = text.toLowerCase();
  let output = '';
  let emitCursor = 0;
  let scanPos = 0;
  let changed = false;

  // Monotonic lookahead caches keep worst-case time strictly O(n) even on adversarial inputs.
  let cachedNextOpen = -2;
  let cachedClose: { closeEnd: number; closeStart: number } | null | undefined;

  const getNextOpen = (from: number): number => {
    if (cachedNextOpen !== -2 && (cachedNextOpen === -1 || cachedNextOpen >= from)) {
      return cachedNextOpen;
    }
    cachedNextOpen = findNextOpenTag(lower, from);
    return cachedNextOpen;
  };

  const getNextClose = (from: number): { closeEnd: number; closeStart: number } | null => {
    if (cachedClose !== undefined && (cachedClose === null || cachedClose.closeStart >= from)) {
      return cachedClose;
    }
    cachedClose = findNextCloseTag(lower, from);
    return cachedClose;
  };

  while (scanPos < text.length) {
    const tagStart = getNextOpen(scanPos);
    if (tagStart === -1) break;

    const open = scanOpeningTag(text, lower, tagStart);
    const attrsRaw = text.slice(tagStart + OPEN_TAG_LOWER.length, open.attrsEnd);
    const attrs = parseTagAttributes(attrsRaw);
    const type = (attrs.type ?? '').trim().toLowerCase();
    const src = attrs.src?.trim() ?? '';
    const isCodeArtifact = type !== 'text/html' && src.startsWith(CODE_ARTIFACT_SRC_PREFIX);

    if (open.incomplete) {
      if (isCodeArtifact) {
        output += text.slice(emitCursor, tagStart) + formatSavedCodeArtifactNote(attrs, src);
        emitCursor = open.openEnd;
        changed = true;
      }
      scanPos = open.openEnd;
      continue;
    }

    if (open.selfClosing) {
      if (isCodeArtifact) {
        output += text.slice(emitCursor, tagStart) + formatSavedCodeArtifactNote(attrs, src);
        emitCursor = open.openEnd;
        changed = true;
      }
      scanPos = open.openEnd;
      continue;
    }

    // Paired or unclosed opening tag: check whether a matching </lobeArtifact> appears
    // before the next <lobeArtifact> start tag.
    const nextOpenAfter = getNextOpen(open.openEnd);
    const nextClose = getNextClose(open.openEnd);
    const hasMatchedClose =
      nextClose !== null && (nextOpenAfter === -1 || nextClose.closeStart < nextOpenAfter);

    if (hasMatchedClose) {
      if (isCodeArtifact) {
        const body = text.slice(open.openEnd, nextClose.closeStart);
        if (body.trim().length > 0) {
          const openTag = text.slice(tagStart, open.openEnd);
          const closeTag = text.slice(nextClose.closeStart, nextClose.closeEnd);
          output +=
            text.slice(emitCursor, tagStart) + stripSrcAttrFromOpenTag(openTag) + body + closeTag;
        } else {
          output += text.slice(emitCursor, tagStart) + formatSavedCodeArtifactNote(attrs, src);
        }
        emitCursor = nextClose.closeEnd;
        changed = true;
      }
      scanPos = nextClose.closeEnd;
      continue;
    }

    // Unclosed tag (no </lobeArtifact> before EOF or before next <lobeArtifact>).
    const boundary = nextOpenAfter === -1 ? text.length : nextOpenAfter;
    if (isCodeArtifact) {
      const body = text.slice(open.openEnd, boundary);
      if (body.trim().length > 0) {
        const openTag = text.slice(tagStart, open.openEnd);
        output += text.slice(emitCursor, tagStart) + stripSrcAttrFromOpenTag(openTag);
        emitCursor = open.openEnd;
      } else {
        output += text.slice(emitCursor, tagStart) + formatSavedCodeArtifactNote(attrs, src);
        // If at EOF, consume trailing whitespace inside the empty tag; if followed by another tag,
        // keep whitespace separating the two tags.
        emitCursor = nextOpenAfter === -1 ? text.length : open.openEnd;
      }
      changed = true;
    }
    scanPos = open.openEnd;
  }

  if (!changed) return text;
  return output + text.slice(emitCursor);
};

/**
 * Rewrites saved code-artifact tags inside either a plain string message content
 * or a multimodal array of content parts (preserving reference identity when unchanged).
 */
export const rewriteMessageContentCodeArtifactTags = (content: unknown): unknown => {
  if (typeof content === 'string') {
    return rewriteSavedCodeArtifactTagsForLLM(content);
  }

  if (Array.isArray(content)) {
    let changed = false;
    const mapped = content.map((part) => {
      if (
        part &&
        typeof part === 'object' &&
        (part as { type?: unknown }).type === 'text' &&
        typeof (part as { text?: unknown }).text === 'string'
      ) {
        const originalText = (part as { text: string }).text;
        const rewritten = rewriteSavedCodeArtifactTagsForLLM(originalText);
        if (rewritten !== originalText) {
          changed = true;
          return { ...part, text: rewritten };
        }
      }
      return part;
    });
    return changed ? mapped : content;
  }

  return content;
};

/**
 * Rewrites saved code-artifact tags inside stored message content, including:
 * - plain strings
 * - multimodal part arrays (`Array<{ type: string; text?: string }>`)
 * - serialized multimodal DB JSON strings (`'[{"type":"text","text":"..."}]'`)
 */
export const rewriteStoredMessageContentForLLM = (content: unknown): unknown => {
  if (typeof content === 'string') {
    if (!content.includes(CODE_ARTIFACT_SRC_PREFIX)) return content;

    const trimmed = content.trim();
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (
          Array.isArray(parsed) &&
          parsed.length > 0 &&
          parsed.every(
            (item) =>
              item &&
              typeof item === 'object' &&
              typeof (item as { type?: unknown }).type === 'string',
          )
        ) {
          const rewrittenParts = rewriteMessageContentCodeArtifactTags(parsed);
          return rewrittenParts !== parsed ? JSON.stringify(rewrittenParts) : content;
        }
      } catch {
        // Not valid JSON — fall through to plain string rewrite
      }
    }

    return rewriteSavedCodeArtifactTagsForLLM(content);
  }

  return rewriteMessageContentCodeArtifactTags(content);
};
