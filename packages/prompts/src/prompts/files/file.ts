import type { ChatFileItem } from '@lobechat/types';

// Tabular chat-attachments (csv/tsv/xlsx/xls) get their FULL content parsed
// and stored in `documents.content` (DB — untouched by this cap; knowledge-base
// chunking/RAG is a fully separate path and is also untouched). But stuffing
// an entire large spreadsheet into every prompt turn blows context/cost before
// the model gets a chance to react. So only what's injected HERE, into the
// chat prompt, is capped to a structural preview — real analysis always goes
// through the file's own url inside the code sandbox (pandas); see <dashboard>
// in systemRole.ts.
// 16_000 chars ≈ 4-8k tokens: enough to show the header + a meaningful sample
// of rows without meaningfully inflating the cost of the conversation.
const TABULAR_CONTENT_CAP = 16_000;

const TABULAR_MIME_TYPES = new Set([
  'text/csv',
  'text/tab-separated-values',
  'application/vnd.ms-excel', // .xls (also what some browsers report for .csv)
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
]);
const TABULAR_EXTENSIONS = new Set(['csv', 'tsv', 'xls', 'xlsx']);

// Browsers are inconsistent about MIME for csv/tsv (empty string, text/plain,
// etc. depending on OS file-type associations) — fall back to the filename
// extension, same "fileType or extension" idiom isTextReadableFile/ExcelLoader
// already use for tabular detection elsewhere in the file pipeline.
const isTabularFile = (item: ChatFileItem): boolean => {
  if (TABULAR_MIME_TYPES.has(item.fileType)) return true;
  const ext = item.name.split('.').pop()?.toLowerCase();
  return !!ext && TABULAR_EXTENSIONS.has(ext);
};

// Cuts on a line boundary — never a half-written row — and appends a
// structural note so the model knows this is a preview, not the full
// dataset, and exactly where to get the rest. Multi-sheet xlsx (markdown
// <sheet> blocks per sheet, see ExcelLoader) gets one extra clause when the
// cut lands before all sheets were shown.
const truncateTabularContent = (content: string): string => {
  if (content.length <= TABULAR_CONTENT_CAP) return content;

  const slice = content.slice(0, TABULAR_CONTENT_CAP);
  const lastNewline = slice.lastIndexOf('\n');
  const truncated = lastNewline > 0 ? slice.slice(0, lastNewline) : slice;

  const totalLines = content.split('\n').length;
  const shownLines = truncated.split('\n').length;
  const totalSheets = (content.match(/<sheet /g) || []).length;
  const shownSheets = (truncated.match(/<sheet /g) || []).length;
  const sheetsNote =
    totalSheets > 1 && shownSheets < totalSheets
      ? ` Only ${shownSheets} of ${totalSheets} sheets are shown — some were cut entirely.`
      : '';

  return (
    `${truncated}\n[content truncated: showing first ${truncated.length} of ${content.length} chars ` +
    `(~${shownLines} of ${totalLines} lines).${sheetsNote} The FULL file was NOT included in context — ` +
    `download it via this file's url inside the code sandbox (pandas) for any real analysis or ` +
    `aggregation.]`
  );
};

const filePrompt = (item: ChatFileItem, addUrl: boolean) => {
  const rawContent = item.content || '';
  const content = isTabularFile(item) ? truncateTabularContent(rawContent) : rawContent;
  return addUrl
    ? `<file id="${item.id}" name="${item.name}" type="${item.fileType}" size="${item.size}" url="${item.url}">${content}</file>`
    : `<file id="${item.id}" name="${item.name}" type="${item.fileType}" size="${item.size}">${content}</file>`;
};

export const filePrompts = (fileList: ChatFileItem[], addUrl: boolean) => {
  if (fileList.length === 0) return '';

  const prompt = `<files>
<files_docstring>here are user upload files you can refer to</files_docstring>
${fileList.map((item) => filePrompt(item, addUrl)).join('\n')}
</files>`;

  return prompt.trim();
};
