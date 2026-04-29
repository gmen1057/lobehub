import type { DocumentCellValue, DocumentSheet } from '@lobechat/builtin-tool-documents';

const DANGEROUS_HTML_BLOCK_RE =
  /<\s*(script|style|iframe|object|embed|link|meta)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi;
// Self-closing variants and dangerous open tags without a closer.
const DANGEROUS_HTML_TAG_RE =
  /<\s*(script|style|iframe|object|embed|link|meta|form|input|button|svg|math|a|img)\b[^>]*>/gi;
const ON_HANDLER_RE = /\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
const JS_HREF_RE = /\b(href|src)\s*=\s*("javascript:[^"]*"|'javascript:[^']*')/gi;
// ASCII hyphen (U+002D) and typographic minus (U+2212) — both can trigger formula evaluation.
const FORMULA_PREFIX_RE = /^[=+\-−@]/;

export const sanitizeMarkdown = (markdown: string) =>
  markdown
    .replaceAll(DANGEROUS_HTML_BLOCK_RE, '')
    .replaceAll(DANGEROUS_HTML_TAG_RE, '')
    .replaceAll(ON_HANDLER_RE, '')
    .replaceAll(JS_HREF_RE, '');

export const sanitizeSpreadsheetCell = (value: DocumentCellValue): DocumentCellValue => {
  if (typeof value !== 'string') return value;

  return FORMULA_PREFIX_RE.test(value.trimStart()) ? `'${value}` : value;
};

export const sanitizeSpreadsheetRows = (rows: DocumentCellValue[][]) =>
  rows.map((row) => row.map((cell) => sanitizeSpreadsheetCell(cell)));

export const sanitizeSheets = (sheets?: DocumentSheet[]) =>
  sheets?.map((sheet) => ({
    ...sheet,
    rows: sanitizeSpreadsheetRows(sheet.rows),
  }));
