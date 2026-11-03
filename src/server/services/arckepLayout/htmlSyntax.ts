import { createHash } from 'node:crypto';
import { Script } from 'node:vm';

import ts from 'typescript';

import { artifactTag, escapeAttr, parseChatFileId } from './artifacts';

export interface HtmlSyntaxIssue {
  column: number;
  excerpt: string;
  kind: 'escaped_sequence' | 'html_structure' | 'script_syntax';
  line: number;
  message: string;
  scriptIndex?: number;
}

export interface HtmlSyntaxValidationResult {
  checkedScripts: number;
  issues: HtmlSyntaxIssue[];
  unverifiedParts: string[];
  valid: boolean;
  verifiedParts: string[];
}

export const VERIFIED_HTML_PARTS = [
  'html-wrapper-balance',
  'escaped-markup-sequences',
  'inline-js-syntax',
] as const;

export const UNVERIFIED_HTML_PARTS = [
  'css-layout-rendering',
  'external-cdn-assets',
  'runtime-dom-events',
  'content-completeness',
] as const;

const NON_JS_SCRIPT_TYPES = new Set([
  'application/json',
  'application/ld+json',
  'application/manifest+json',
  'importmap',
  'speculationrules',
  'text/html',
  'text/markdown',
  'text/plain',
  'text/template',
  'text/x-template',
]);

const EXECUTABLE_JS_TYPES = new Set([
  '',
  'application/ecmascript',
  'application/javascript',
  'application/x-ecmascript',
  'application/x-javascript',
  'module',
  'text/ecmascript',
  'text/javascript',
  'text/javascript1.0',
  'text/javascript1.1',
  'text/javascript1.2',
  'text/javascript1.3',
  'text/javascript1.4',
  'text/javascript1.5',
  'text/jscript',
  'text/livescript',
  'text/x-ecmascript',
  'text/x-javascript',
]);

const HTML_MARKUP_RE =
  /<(?:!doctype\s+html|html|head|body|main|section|article|div|table|header|footer|nav|aside|form|canvas|svg|p|h[1-6]|ul|ol|li|button|span|style|script)\b/i;

export const computeHtmlSha256 = (html: string): string =>
  createHash('sha256').update(html, 'utf8').digest('hex');

const lineAndColAt = (
  text: string,
  index: number,
): { column: number; excerpt: string; line: number } => {
  const safeIndex = Math.max(0, Math.min(index, text.length));
  const before = text.slice(0, safeIndex);
  const linesBefore = before.split('\n');
  const line = linesBefore.length;
  const column = (linesBefore.at(-1)?.length ?? 0) + 1;
  const allLines = text.split('\n');
  const excerpt = (allLines[line - 1] ?? '').trim().slice(0, 160);
  return { column, excerpt, line };
};

const parseScriptAttrs = (
  rawAttrs: string,
): { isModule: boolean; isSkippedType: boolean; src?: string } => {
  let typeVal = '';
  let srcVal: string | undefined;
  const attrRe = /([a-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;
  for (const match of rawAttrs.matchAll(attrRe)) {
    const name = match[1].toLowerCase();
    const val = (match[2] ?? match[3] ?? match[4] ?? '').trim();
    if (name === 'type') typeVal = val.toLowerCase().split(';')[0].trim();
    if (name === 'src') srcVal = val;
  }
  const isModule = typeVal === 'module';
  const isSkippedType =
    (typeVal !== '' && !EXECUTABLE_JS_TYPES.has(typeVal)) ||
    NON_JS_SCRIPT_TYPES.has(typeVal) ||
    typeVal.startsWith('x-shader/');
  return { isModule, isSkippedType, src: srcVal };
};

const validateScriptBlock = (
  scriptBody: string,
  html: string,
  bodyStartIndex: number,
  scriptIndex: number,
  isModule: boolean,
): HtmlSyntaxIssue[] => {
  const issues: HtmlSyntaxIssue[] = [];

  // 1. Check for literal "\n" corruption at the start or between statements of a script block
  const literalNewlineMatch = /^\s*\\n|\}\s*\\n\s*|\{\s*\\n\s*|;\s*\\n\s*/.exec(scriptBody);
  if (literalNewlineMatch) {
    const loc = lineAndColAt(html, bodyStartIndex + literalNewlineMatch.index);
    issues.push({
      ...loc,
      kind: 'escaped_sequence',
      message:
        'Inline <script> contains literal "\\n" escape sequence instead of real newline characters',
      scriptIndex,
    });
    return issues;
  }

  // 2. Parse with TypeScript JS parser (handles both classic JS and ES module syntax with exact offsets)
  const sourceFile = ts.createSourceFile(
    `inline-script-${scriptIndex}.js`,
    scriptBody,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  ) as ts.SourceFile & { parseDiagnostics?: ts.DiagnosticWithLocation[] };

  const diagnostics = sourceFile.parseDiagnostics ?? [];
  if (diagnostics.length > 0) {
    const first = diagnostics[0];
    const startOffset = typeof first.start === 'number' ? first.start : 0;
    const loc = lineAndColAt(html, bodyStartIndex + startOffset);
    const msg = ts.flattenDiagnosticMessageText(first.messageText, ' ');
    issues.push({
      ...loc,
      kind: 'script_syntax',
      message: `JavaScript syntax error in <script> #${scriptIndex}: ${msg}`,
      scriptIndex,
    });
    return issues;
  }

  // 3. For classic scripts (non-module without import/export), also verify with V8 vm.Script parser
  //    (compiles AST only, never executes code) to catch strict V8 early syntax errors
  const hasModuleKeyword = /\b(?:import|export)\b/.test(scriptBody);
  if (!isModule && !hasModuleKeyword) {
    const before = html.slice(0, bodyStartIndex);
    const beforeLines = before.split('\n');
    const lineOffset = beforeLines.length - 1;
    const columnOffset = (beforeLines.at(-1) ?? '').length;
    try {
      const compiled = new Script(scriptBody, {
        columnOffset,
        filename: 'artifact.html',
        lineOffset,
      });
      void compiled;
    } catch (error) {
      const err = error as Error;
      const stackLines = String(err.stack ?? '').split('\n');
      const lineMatch = stackLines[0]?.match(/artifact\.html:(\d+)/);
      const line = lineMatch ? Number(lineMatch[1]) : lineOffset + 1;
      const caretLine = stackLines[2] ?? '';
      const caretIdx = caretLine.indexOf('^');
      const column = caretIdx >= 0 ? caretIdx + 1 : 1;
      const htmlLines = html.split('\n');
      const excerpt = (htmlLines[line - 1] ?? stackLines[1] ?? '').trim().slice(0, 160);
      issues.push({
        column,
        excerpt,
        kind: 'script_syntax',
        line,
        message: `JavaScript syntax error in <script> #${scriptIndex}: ${err.message}`,
        scriptIndex,
      });
    }
  }

  return issues;
};

/**
 * Validates raw HTML artifact bytes without executing code or making network requests:
 * - Verifies non-empty HTML structure and balanced <html/>, <body/>, <script/>, <style/> tags
 * - Detects JSON-escaped markup corruption (`class=\"...\"` or `>\n<` outside scripts/styles)
 * - Parses every inline executable <script> block (classic & module JS) and reports 1-based line/column in the HTML document
 */
export const validateHtmlArtifactSyntax = (rawHtml: string): HtmlSyntaxValidationResult => {
  const issues: HtmlSyntaxIssue[] = [];
  const verifiedParts = [...VERIFIED_HTML_PARTS];
  const unverifiedParts = [...UNVERIFIED_HTML_PARTS];

  const trimmed = rawHtml.trim();
  if (!trimmed) {
    return {
      checkedScripts: 0,
      issues: [
        {
          column: 1,
          excerpt: '',
          kind: 'html_structure',
          line: 1,
          message: 'HTML artifact content is empty',
        },
      ],
      unverifiedParts,
      valid: false,
      verifiedParts,
    };
  }

  if (!HTML_MARKUP_RE.test(trimmed)) {
    const loc = lineAndColAt(rawHtml, 0);
    issues.push({
      ...loc,
      kind: 'html_structure',
      message: 'Content does not contain recognizable HTML document or element tags',
    });
  }

  // Check balanced top-level structural tags (<html, <body, <script, <style)
  for (const tag of ['html', 'body', 'script', 'style'] as const) {
    const openRe = new RegExp(`<${tag}\\b[^>]*>`, 'gi');
    const closeRe = new RegExp(`</${tag}\\s*>`, 'gi');
    const opens = [...rawHtml.matchAll(openRe)];
    const closes = [...rawHtml.matchAll(closeRe)];
    if (opens.length !== closes.length) {
      const unmatched = opens.at(-1);
      const loc = lineAndColAt(rawHtml, unmatched?.index ?? 0);
      issues.push({
        ...loc,
        kind: 'html_structure',
        message: `Unbalanced <${tag}> tag: found ${opens.length} opening and ${closes.length} closing tag(s)`,
      });
    }
  }

  // Extract inline <script> blocks and mask out <script>/<style> ranges before checking HTML markup escapes
  const scriptBlockRe = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let checkedScripts = 0;
  const maskedRanges: Array<[number, number]> = [];

  for (const match of rawHtml.matchAll(scriptBlockRe)) {
    const fullMatch = match[0];
    const rawAttrs = match[1] ?? '';
    const scriptBody = match[2] ?? '';
    const matchStart = match.index ?? 0;
    const openTagEnd = fullMatch.indexOf('>') + 1;
    const bodyStartIndex = matchStart + openTagEnd;
    maskedRanges.push([bodyStartIndex, bodyStartIndex + scriptBody.length]);

    const { isModule, isSkippedType, src } = parseScriptAttrs(rawAttrs);
    if (isSkippedType) continue;
    if (src && !scriptBody.trim()) continue;
    if (!scriptBody.trim()) continue;

    checkedScripts += 1;
    const scriptIssues = validateScriptBlock(
      scriptBody,
      rawHtml,
      bodyStartIndex,
      checkedScripts,
      isModule,
    );
    issues.push(...scriptIssues);
  }

  for (const styleMatch of rawHtml.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) {
    const start = (styleMatch.index ?? 0) + styleMatch[0].indexOf('>') + 1;
    maskedRanges.push([start, start + (styleMatch[1]?.length ?? 0)]);
  }

  const isInsideMaskedRange = (idx: number) =>
    maskedRanges.some(([start, end]) => idx >= start && idx < end);

  // Check for JSON-escaped quotes on HTML attributes (`<div class=\"...\"`) or literal `\n` between HTML tags (`>\n  <`)
  const escapedAttrMatch = /<[a-z][\w-]*\s[^<>]{0,200}?[a-z-]+=\\["']/i.exec(rawHtml);
  if (escapedAttrMatch && !isInsideMaskedRange(escapedAttrMatch.index)) {
    const loc = lineAndColAt(rawHtml, escapedAttrMatch.index);
    issues.push({
      ...loc,
      kind: 'escaped_sequence',
      message:
        'HTML tag attributes contain backslash-escaped quotes (\\"); use normal unescaped quotes in HTML',
    });
  }

  const escapedTagNewlineMatch = />\s*\\n\s*</.exec(rawHtml);
  if (escapedTagNewlineMatch && !isInsideMaskedRange(escapedTagNewlineMatch.index)) {
    const loc = lineAndColAt(rawHtml, escapedTagNewlineMatch.index);
    issues.push({
      ...loc,
      kind: 'escaped_sequence',
      message:
        'HTML markup contains literal "\\n" sequences between tags instead of real newline characters',
    });
  }

  return {
    checkedScripts,
    issues,
    unverifiedParts,
    valid: issues.length === 0,
    verifiedParts,
  };
};

export const formatHtmlSyntaxDiagnostics = (
  result: HtmlSyntaxValidationResult,
  identifier?: string,
): string => {
  const label = identifier ? ` «${identifier}»` : '';
  if (result.valid) {
    return (
      `Синтаксис HTML-артефакта${label} проверен (скриптов проверено: ${result.checkedScripts}). ` +
      `Проверено: ${result.verifiedParts.join(', ')}. ` +
      `Не проверяется этим шагом: ${result.unverifiedParts.join(', ')}.`
    );
  }

  const lines = [
    `HTML-артефакт${label} НЕ сохранён: найдена синтаксическая ошибка (${result.issues.length}).`,
    'Исправь указанные строки и вызови writeArtifact (или editArtifact) повторно — битая версия не опубликована, предыдущая исправная версия (если была) сохранена:',
    ...result.issues.map(
      (issue, idx) =>
        `${idx + 1}) Строка ${issue.line}, столбец ${issue.column} [${issue.kind}]: ${issue.message}` +
        (issue.excerpt ? `\n   Фрагмент: ${issue.excerpt}` : ''),
    ),
    '',
    `Проверено: ${result.verifiedParts.join(', ')}. Не проверяется этим шагом: ${result.unverifiedParts.join(', ')}.`,
  ];
  return lines.join('\n');
};

const OPEN_TAG_PREFIX = '<lobeartifact';

const findPartialPrefixIndex = (text: string): number => {
  const maxLen = Math.min(text.length, OPEN_TAG_PREFIX.length - 1);
  for (let len = maxLen; len >= 1; len -= 1) {
    const suffix = text.slice(text.length - len).toLowerCase();
    if (OPEN_TAG_PREFIX.startsWith(suffix)) {
      return text.length - len;
    }
  }
  return -1;
};

const cleanArtifactBody = (raw: string): string => {
  let body = raw
    .replace(/^[ \t]*\r?\n/, '')
    .replaceAll('\r\n', '\n')
    .trimEnd();
  body = body.replace(/^[ \t]*```[^\n]*\n/, '').replace(/\n?[ \t]*```$/, '');
  return body.trim();
};

const parseLooseAttrs = (
  attrsRaw: string,
): { escapedQuotes: boolean; identifier: string; src?: string; title: string; type: string } => {
  const escapedQuotes = /\\["']/.test(attrsRaw);
  const attrs: Record<string, string> = {};
  const attrRe = /([a-z_:][\w:.-]*)\s*=\s*(?:\\?"([^"\\]*)\\?"|\\?'([^'\\]*)\\?')/gi;
  for (const match of attrsRaw.matchAll(attrRe)) {
    attrs[match[1].toLowerCase()] = (match[2] ?? match[3] ?? '')
      .replaceAll('&quot;', '"')
      .replaceAll('&#39;', "'")
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .replaceAll('&amp;', '&');
  }
  return {
    escapedQuotes,
    identifier: attrs.identifier || 'html-artifact',
    src: attrs.src,
    title: attrs.title || attrs.identifier || 'HTML Artifact',
    type: (attrs.type || '').trim().toLowerCase(),
  };
};

interface StreamSegmentText {
  kind: 'text';
  text: string;
}

interface StreamSegmentHtmlArtifact {
  attrsRaw: string;
  bodyRaw: string;
  closed: boolean;
  kind: 'html_artifact';
  openTag: string;
  rawTag: string;
  selfClosing: boolean;
}

type StreamSegment = StreamSegmentHtmlArtifact | StreamSegmentText;

export interface StreamGateFinalizeOptions {
  /**
   * Optional persistence hook to upload verified inline HTML to chat storage and emit a `<lobeArtifact ... src="...">` tag.
   * When omitted or if it returns `undefined`, the verified `<lobeArtifact>` tag is emitted inline.
   */
  saveHtml?: (params: {
    html: string;
    identifier: string;
    title: string;
  }) => Promise<{ address: string; fileId: string } | undefined>;
}

export interface StreamGateFinalizeResult {
  diagnostics: string[];
  finalContent: string;
  hasHtmlArtifacts: boolean;
  postStreamDelta: string;
  publishedArtifacts: Array<{
    fileId?: string;
    identifier: string;
    sha256: string;
    src?: string;
    title: string;
  }>;
  valid: boolean;
}

/**
 * Stateful streaming publication gate for `<lobeArtifact type="text/html">`.
 * - Normal conversational text is returned immediately from `push(chunk)` so SSE streaming remains responsive.
 * - Any `<lobeArtifact ... type="text/html">` wrapper (across arbitrary chunk boundaries) is held back until `finalize()`.
 * - Unclosed wrappers, backslash-escaped wrappers, and inline HTML/JS syntax errors are caught before publication:
 *   broken HTML bytes are never emitted to the stream or uploaded to storage.
 */
export class HtmlArtifactStreamGate {
  private segments: StreamSegment[] = [];
  private mode: 'artifact_body' | 'opening_tag' | 'text' = 'text';
  private buffer = '';
  private currentOpenTag = '';
  private currentAttrsRaw = '';

  private appendTextSegment(text: string) {
    if (!text) return;
    const last = this.segments.at(-1);
    if (last && last.kind === 'text') {
      last.text += text;
    } else {
      this.segments.push({ kind: 'text', text });
    }
  }

  push(chunk: string): string {
    if (!chunk) return '';
    this.buffer += chunk;
    let emitted = '';

    while (this.buffer.length > 0) {
      if (this.mode === 'text') {
        const openMatch = /<lobeArtifact(?![\w-])/i.exec(this.buffer);
        if (openMatch) {
          const before = this.buffer.slice(0, openMatch.index);
          if (before) {
            emitted += before;
            this.appendTextSegment(before);
          }
          this.buffer = this.buffer.slice(openMatch.index);
          this.mode = 'opening_tag';
          continue;
        }

        const prefixIdx = findPartialPrefixIndex(this.buffer);
        if (prefixIdx >= 0) {
          const safe = this.buffer.slice(0, prefixIdx);
          if (safe) {
            emitted += safe;
            this.appendTextSegment(safe);
          }
          this.buffer = this.buffer.slice(prefixIdx);
        } else {
          emitted += this.buffer;
          this.appendTextSegment(this.buffer);
          this.buffer = '';
        }
        break;
      }

      if (this.mode === 'opening_tag') {
        const gtIdx = this.buffer.indexOf('>');
        if (gtIdx < 0) {
          // Wait for the rest of the opening tag
          break;
        }

        const openTag = this.buffer.slice(0, gtIdx + 1);
        const selfClosing = /\/\s*>$/.test(openTag);
        const attrsRaw = openTag.slice('<lobeArtifact'.length, selfClosing ? openTag.lastIndexOf('/') : -1);
        const parsed = parseLooseAttrs(attrsRaw);
        const isHtmlType = parsed.type === 'text/html';

        this.buffer = this.buffer.slice(gtIdx + 1);

        if (!isHtmlType) {
          emitted += openTag;
          this.appendTextSegment(openTag);
          this.mode = 'text';
          continue;
        }

        if (selfClosing) {
          this.segments.push({
            attrsRaw,
            bodyRaw: '',
            closed: true,
            kind: 'html_artifact',
            openTag,
            rawTag: openTag,
            selfClosing: true,
          });
          this.mode = 'text';
          continue;
        }

        this.currentOpenTag = openTag;
        this.currentAttrsRaw = attrsRaw;
        this.mode = 'artifact_body';
        continue;
      }

      if (this.mode === 'artifact_body') {
        const closeMatch = /<\/lobeArtifact\s*>/i.exec(this.buffer);
        if (!closeMatch) {
          // Hold HTML body until closing tag arrives
          break;
        }

        const bodyRaw = this.buffer.slice(0, closeMatch.index);
        const closeTag = closeMatch[0];
        const rawTag = this.currentOpenTag + bodyRaw + closeTag;
        this.segments.push({
          attrsRaw: this.currentAttrsRaw,
          bodyRaw,
          closed: true,
          kind: 'html_artifact',
          openTag: this.currentOpenTag,
          rawTag,
          selfClosing: false,
        });
        this.buffer = this.buffer.slice(closeMatch.index + closeTag.length);
        this.currentOpenTag = '';
        this.currentAttrsRaw = '';
        this.mode = 'text';
      }
    }

    return emitted;
  }

  async finalize(options: StreamGateFinalizeOptions = {}): Promise<StreamGateFinalizeResult> {
    let postStreamDelta = '';

    if (this.mode === 'text' && this.buffer) {
      postStreamDelta += this.buffer;
      this.appendTextSegment(this.buffer);
      this.buffer = '';
    } else if (this.mode === 'opening_tag' && this.buffer) {
      const parsed = parseLooseAttrs(this.buffer);
      if (parsed.type === 'text/html' || /text\/html/i.test(this.buffer)) {
        this.segments.push({
          attrsRaw: this.buffer,
          bodyRaw: '',
          closed: false,
          kind: 'html_artifact',
          openTag: this.buffer,
          rawTag: this.buffer,
          selfClosing: false,
        });
      } else {
        postStreamDelta += this.buffer;
        this.appendTextSegment(this.buffer);
      }
      this.buffer = '';
      this.mode = 'text';
    } else if (this.mode === 'artifact_body') {
      this.segments.push({
        attrsRaw: this.currentAttrsRaw,
        bodyRaw: this.buffer,
        closed: false,
        kind: 'html_artifact',
        openTag: this.currentOpenTag,
        rawTag: this.currentOpenTag + this.buffer,
        selfClosing: false,
      });
      this.buffer = '';
      this.currentOpenTag = '';
      this.currentAttrsRaw = '';
      this.mode = 'text';
    }

    const htmlSegments = this.segments.filter(
      (seg): seg is StreamSegmentHtmlArtifact => seg.kind === 'html_artifact',
    );
    if (htmlSegments.length === 0) {
      const finalContent = this.segments
        .map((seg) => (seg.kind === 'text' ? seg.text : seg.rawTag))
        .join('');
      return {
        diagnostics: [],
        finalContent,
        hasHtmlArtifacts: false,
        postStreamDelta,
        publishedArtifacts: [],
        valid: true,
      };
    }

    const diagnostics: string[] = [];
    const publishedArtifacts: StreamGateFinalizeResult['publishedArtifacts'] = [];
    const finalParts: string[] = [];

    for (const seg of this.segments) {
      if (seg.kind === 'text') {
        finalParts.push(seg.text);
        continue;
      }

      const parsed = parseLooseAttrs(seg.attrsRaw);
      const body = cleanArtifactBody(seg.bodyRaw);
      const srcFileId = body ? undefined : parseChatFileId(parsed.src);

      const wrapperIssues: HtmlSyntaxIssue[] = [];
      if (parsed.escapedQuotes) {
        wrapperIssues.push({
          column: 1,
          excerpt: seg.openTag.slice(0, 160),
          kind: 'escaped_sequence',
          line: 1,
          message:
            'Opening <lobeArtifact> tag uses backslash-escaped quotes (\\"); use normal unescaped quotes',
        });
      }
      if (!seg.closed) {
        wrapperIssues.push({
          column: 1,
          excerpt: seg.rawTag.slice(-160).trim(),
          kind: 'html_structure',
          line: seg.rawTag.split('\n').length,
          message: 'Unclosed <lobeArtifact> wrapper: stream ended before closing </lobeArtifact>',
        });
      }

      // Already-verified chat file reference tag (`<lobeArtifact ... src="/chat/f/<id>/"></lobeArtifact>`)
      if (srcFileId && wrapperIssues.length === 0) {
        const canonicalTag = artifactTag({
          identifier: parsed.identifier,
          src: parsed.src!,
          title: parsed.title,
        });
        postStreamDelta += canonicalTag;
        finalParts.push(canonicalTag);
        publishedArtifacts.push({
          fileId: srcFileId,
          identifier: parsed.identifier,
          sha256: computeHtmlSha256(canonicalTag),
          src: parsed.src,
          title: parsed.title,
        });
        continue;
      }

      const syntaxResult = validateHtmlArtifactSyntax(body);
      const allIssues = [...wrapperIssues, ...syntaxResult.issues];
      if (allIssues.length > 0) {
        diagnostics.push(
          formatHtmlSyntaxDiagnostics(
            {
              ...syntaxResult,
              issues: allIssues,
              valid: false,
            },
            parsed.identifier,
          ),
        );
        // Do NOT emit broken HTML bytes to postStreamDelta or finalParts!
        continue;
      }

      const sha256 = computeHtmlSha256(body);
      let publishedTag = `<lobeArtifact identifier="${escapeAttr(parsed.identifier)}" type="text/html" title="${escapeAttr(parsed.title)}">\n${body}\n</lobeArtifact>`;
      let savedInfo: { address: string; fileId: string } | undefined;

      if (options.saveHtml) {
        savedInfo = await options.saveHtml({
          html: body,
          identifier: parsed.identifier,
          title: parsed.title,
        });
        if (savedInfo) {
          publishedTag = artifactTag({
            identifier: parsed.identifier,
            src: savedInfo.address,
            title: parsed.title,
          });
        }
      }

      postStreamDelta += publishedTag;
      finalParts.push(publishedTag);
      publishedArtifacts.push({
        fileId: savedInfo?.fileId,
        identifier: parsed.identifier,
        sha256,
        src: savedInfo?.address,
        title: parsed.title,
      });
    }

    return {
      diagnostics,
      finalContent: finalParts.join(''),
      hasHtmlArtifacts: true,
      postStreamDelta,
      publishedArtifacts,
      valid: diagnostics.length === 0,
    };
  }
}
