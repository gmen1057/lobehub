/**
 * Build a safe Tantivy BM25 query from arbitrary user text.
 *
 * ParadeDB/Tantivy's query parser fails on certain sequences of escaped
 * special characters, and raw user prompts routinely contain them
 * (colons, backslashes, parentheses, asterisks, quotes, etc.). Rather
 * than escape-and-hope, we strip every character that isn't alphanumeric
 * (incl. Unicode letters) and rebuild the query from clean terms.
 *
 * Guards:
 *   - drop empty / ultra-short terms
 *   - cap total terms (prevents pathological multi-kb prompts blowing
 *     up the parser and the posting list)
 */

const MAX_TERMS = 32;
const MIN_TERM_LEN = 2;

export function sanitizeBm25Query(query: string): string {
  const terms = query
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= MIN_TERM_LEN)
    .slice(0, MAX_TERMS);

  return terms.join(' AND ');
}
