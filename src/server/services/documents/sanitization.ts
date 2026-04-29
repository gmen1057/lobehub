import type { DocumentCellValue, DocumentSheet } from '@lobechat/builtin-tool-documents';

const DANGEROUS_HTML_BLOCK_RE =
  /<\s*(script|style|iframe|object|embed|link|meta)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi;
const HTML_TAG_RE = /<[^>]+>/g;
const FORMULA_PREFIX_RE = /^[=+\-@]/;

export const sanitizeMarkdown = (markdown: string) =>
  markdown.replaceAll(DANGEROUS_HTML_BLOCK_RE, '').replaceAll(HTML_TAG_RE, '');

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
