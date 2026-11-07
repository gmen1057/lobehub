import { FILE_READ_CHARS, readFilePage } from '@lobechat/prompts';
import type { BuiltinServerRuntimeOutput } from '@lobechat/types';

import type { DocumentReadOptions } from '../types';

interface DocumentSource {
  content?: string;
  filename?: string;
  id: string;
  title?: string;
}

// The shared reader includes up to 1000 characters before a literal match. A
// search page must leave room for that context and the entire 500-char query.
const MIN_SEARCH_PAGE_CHARS = 2000;

const invalidRead = (message: string): BuiltinServerRuntimeOutput => ({
  content: message,
  error: { code: 'INVALID_ARGUMENT', message, status: 400 },
  success: false,
});

function readInteger(value: unknown, fallback: number, minimum: number): number {
  if (value === undefined) return fallback;
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`Use an integer greater than or equal to ${minimum}.`);
  }
  return parsed;
}

/** Exact, bounded source access shared by ID and filename reads in all runtimes. */
export async function readAgentDocumentPage(
  doc: DocumentSource,
  args: DocumentReadOptions,
): Promise<BuiltinServerRuntimeOutput> {
  let offset: number;
  let limit: number;
  try {
    offset = readInteger(args.offset, 0, 0);
    limit = Math.min(readInteger(args.limit, FILE_READ_CHARS, 2), FILE_READ_CHARS);
  } catch (error) {
    return invalidRead(`Invalid document offset or limit. ${(error as Error).message}`);
  }
  if (args.query !== undefined && (typeof args.query !== 'string' || args.query.length > 500)) {
    return invalidRead(
      'Use a literal query of at most 500 characters, or omit it to read sequentially.',
    );
  }
  if (args.query?.trim() && limit < MIN_SEARCH_PAGE_CHARS) {
    return invalidRead(
      'For a literal search use limit >= 2000 to include the match and its context, or omit limit.',
    );
  }
  if (args.snapshot !== undefined && !/^sha256:[a-f\d]{64}$/.test(args.snapshot)) {
    return invalidRead(
      'Invalid document snapshot. Copy the fingerprint returned by the previous page.',
    );
  }

  const original = doc.content ?? '';
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${doc.id}\0${original}`),
  );
  const snapshot = `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  if (args.snapshot !== undefined && args.snapshot !== snapshot) {
    const message =
      'Document changed since the previous page. Restart reading at offset=0 without snapshot; do not combine pages from different snapshots.';
    return {
      content: message,
      error: { code: 'DOCUMENT_CHANGED', message, status: 409 },
      success: false,
    };
  }

  const page = readFilePage(original, { offset, query: args.query }, limit);
  const { content, ...cursor } = page;
  const metadata = {
    ...cursor,
    eof: page.endOffset === original.length,
    filename: doc.filename?.slice(0, 500),
    id: doc.id,
    snapshot,
    title: doc.title?.slice(0, 500),
    totalLength: original.length,
  };
  return {
    content:
      `Agent document page ${JSON.stringify(metadata)}\n` +
      'The complete original is retained. For the next page copy nextOffset and snapshot into the same read tool; choose any offset/limit or query to inspect a section. Read every page without query before replacing the whole document. Search hits are not exhaustive. Continue automatically; do not ask the user to select excerpts.\n' +
      content,
    state: { ...metadata, content },
    success: true,
  };
}
