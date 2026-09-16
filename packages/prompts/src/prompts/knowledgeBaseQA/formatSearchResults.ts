import { filePreview } from '../files/context';

export interface FileSearchResultChunk {
  similarity: number;
  text: string;
}

export interface FileSearchResult {
  fileId: string;
  fileName: string;
  relevanceScore: number;
  topChunks: FileSearchResultChunk[];
}

/**
 * Formats a single chunk with XML tags
 */
const formatChunk = (
  chunk: FileSearchResultChunk,
  fileId: string,
  fileName: string,
  budget: { remaining: number },
): string => {
  const limit = Math.max(0, Math.min(4_000, budget.remaining));
  budget.remaining -= Math.min(chunk.text.length, limit);
  return `<chunk fileId="${fileId}" fileName="${fileName}" similarity="${chunk.similarity}">${filePreview(chunk.text, limit)}</chunk>`;
};

/**
 * Formats a single file search result with XML tags
 */
const formatFile = (file: FileSearchResult, budget: { remaining: number }): string => {
  const chunks = file.topChunks.map((chunk) =>
    formatChunk(chunk, file.fileId, file.fileName, budget),
  );

  return `<file id="${file.fileId}" name="${file.fileName}" relevanceScore="${file.relevanceScore}">
${chunks.join('\n')}
</file>`;
};

/**
 * Formats knowledge base search results into an XML structure
 * @param fileResults - Array of file search results with relevance scores and chunks
 * @param query - The original search query
 * @returns Formatted XML string with search results
 */
export const formatSearchResults = (fileResults: FileSearchResult[], query: string): string => {
  if (fileResults.length === 0) {
    return `<knowledge_base_search_results query="${query}" totalCount="0">
<instruction>No relevant files found in the knowledge base for this query.</instruction>
</knowledge_base_search_results>`;
  }

  const budget = { remaining: 20_000 };
  const filesXml = fileResults.map((file) => formatFile(file, budget)).join('\n');

  return `<knowledge_base_search_results query="${query}" totalCount="${fileResults.length}">
<instruction>Here are the search results from the knowledge base. Use the readKnowledge tool with file IDs to get complete content.</instruction>
${filesXml}
</knowledge_base_search_results>`;
};
