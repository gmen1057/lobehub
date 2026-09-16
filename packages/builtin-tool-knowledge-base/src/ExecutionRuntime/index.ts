import { formatSearchResults, promptFileContents, promptNoSearchResults } from '@lobechat/prompts';
import type { BuiltinServerRuntimeOutput } from '@lobechat/types';

import type {
  ReadKnowledgeArgs,
  ReadKnowledgeState,
  SearchKnowledgeBaseArgs,
  SearchKnowledgeBaseState,
} from '../types';

interface FileContentResult {
  content: string;
  error?: string;
  fileId: string;
  filename: string;
  preview?: string;
  totalCharCount?: number;
  totalLineCount?: number;
}

interface RagService {
  getFileContents: (fileIds: string[], signal?: AbortSignal) => Promise<FileContentResult[]>;
  semanticSearchForChat: (
    params: { fileIds?: string[]; knowledgeIds?: string[]; query: string; topK: number },
    signal?: AbortSignal,
  ) => Promise<{ chunks: any[]; fileResults: any[] }>;
}

export class KnowledgeBaseExecutionRuntime {
  private ragService: RagService;

  constructor(ragService: RagService) {
    this.ragService = ragService;
  }

  /**
   * Search knowledge base and return file summaries with relevant chunks
   */
  async searchKnowledgeBase(
    args: SearchKnowledgeBaseArgs,
    options?: {
      knowledgeBaseIds?: string[];
      messageId?: string;
      signal?: AbortSignal;
    },
  ): Promise<BuiltinServerRuntimeOutput> {
    try {
      const { query, topK = 20 } = args;

      // Search configured knowledge bases and explicitly requested attachments.
      const { chunks, fileResults } = await this.ragService.semanticSearchForChat(
        { fileIds: args.fileIds, knowledgeIds: options?.knowledgeBaseIds, query, topK },
        options?.signal,
      );

      if (chunks.length === 0) {
        const state: SearchKnowledgeBaseState = { chunks: [], fileResults: [], totalResults: 0 };

        return { content: promptNoSearchResults(query), state, success: true };
      }

      // Format search results for AI
      const formattedContent = formatSearchResults(fileResults, query);

      const state: SearchKnowledgeBaseState = { chunks, fileResults, totalResults: chunks.length };

      return { content: formattedContent, state, success: true };
    } catch (e) {
      return {
        content: `Search unavailable: ${(e as Error).message}. This is not evidence that the source has no relevant information. For known attachment IDs, use readKnowledge with query (literal search) or offset (sequential reading); continue automatically.`,
        error: e,
        success: false,
      };
    }
  }

  /**
   * Read bounded pages from original files without requiring embeddings.
   */
  async readKnowledge(
    args: ReadKnowledgeArgs,
    options?: { signal?: AbortSignal },
  ): Promise<BuiltinServerRuntimeOutput> {
    try {
      const { fileIds } = args;

      if (!fileIds || fileIds.length === 0 || fileIds.length > 8) {
        return {
          content: 'Provide between 1 and 8 file IDs. Read additional files in subsequent calls.',
          success: false,
        };
      }

      const fileContents = await this.ragService.getFileContents(fileIds, options?.signal);

      const formattedContent = promptFileContents(fileContents, args);

      const state: ReadKnowledgeState = {
        files: fileContents.map((file) => ({
          error: file.error,
          fileId: file.fileId,
          filename: file.filename,
          preview: file.preview,
          totalCharCount: file.totalCharCount,
          totalLineCount: file.totalLineCount,
        })),
      };

      return { content: formattedContent, state, success: true };
    } catch (e) {
      return {
        content: `Error reading knowledge: ${(e as Error).message}`,
        error: e,
        success: false,
      };
    }
  }
}
