/** Limits apply to the working prompt, never to the stored source. */
export const FILE_PREVIEW_CHARS = 8_000;
export const FILE_CONTEXT_CHARS = 32_000;
export const FILE_READ_CHARS = 20_000;

export interface FileReadOptions {
  /** UTF-16 character offset, returned unchanged by the reader as nextOffset. */
  offset?: number;
  /** Case-insensitive literal search; never a regular expression. */
  query?: string;
}

export interface FileReadPage {
  /** True only when this response contains the entire source. */
  complete: boolean;
  content: string;
  endOffset: number;
  nextOffset: number | null;
  query?: string;
  startOffset: number;
  totalCharCount: number;
}

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
  const offset = Math.min(
    content.length,
    Math.max(0, Math.floor(Number.isFinite(options.offset) ? options.offset! : 0)),
  );
  const query = options.query?.trim();
  // Escaping avoids regex interpretation while /iu preserves original source offsets
  // (lowercasing the whole source can change its length for some Unicode characters).
  const escaped = query?.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = escaped ? new RegExp(escaped, 'iu').exec(content.slice(offset)) : undefined;
  const found = match ? offset + match.index : offset;
  const startOffset = query ? (match ? Math.max(offset, found - 1000) : content.length) : offset;
  let endOffset = Math.min(content.length, startOffset + Math.max(2, limit));
  // Do not split a surrogate pair. Preserve exact cursor coverage across pages.
  if (endOffset < content.length && /[\uD800-\uDBFF]/.test(content[endOffset - 1])) endOffset--;
  return {
    complete: !query && startOffset === 0 && endOffset === content.length,
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
