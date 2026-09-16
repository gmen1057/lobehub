import { formatSearchResults, promptFileContents, promptNoSearchResults } from '@lobechat/prompts';
import type { BuiltinToolContext, BuiltinToolResult } from '@lobechat/types';
import { BaseExecutor } from '@lobechat/types';

import { ragService } from '@/services/rag';
import { agentSelectors } from '@/store/agent/selectors';
import { getAgentStoreState } from '@/store/agent/store';

import type {
  FileContentDetail,
  ReadKnowledgeArgs,
  ReadKnowledgeState,
  SearchKnowledgeBaseArgs,
  SearchKnowledgeBaseState,
} from '../types';
import { KnowledgeBaseIdentifier } from '../types';

/**
 * Knowledge Base Tool Executor
 *
 * Handles knowledge base search and retrieval operations.
 */
class KnowledgeBaseExecutor extends BaseExecutor<{
  readKnowledge: 'readKnowledge';
  searchKnowledgeBase: 'searchKnowledgeBase';
}> {
  readonly identifier = KnowledgeBaseIdentifier;
  protected readonly apiEnum = {
    readKnowledge: 'readKnowledge' as const,
    searchKnowledgeBase: 'searchKnowledgeBase' as const,
  };

  /**
   * Search knowledge base and return file summaries with relevant chunks
   */
  searchKnowledgeBase = async (
    params: SearchKnowledgeBaseArgs,
    ctx: BuiltinToolContext,
  ): Promise<BuiltinToolResult> => {
    try {
      const { query, topK = 20 } = params;

      // Get knowledge base IDs from agent store
      const agentState = getAgentStoreState();
      const knowledgeIds = agentSelectors.currentKnowledgeIds(agentState);

      // Search configured knowledge bases and explicitly requested attachments.
      const knowledgeBaseIds = knowledgeIds.knowledgeBaseIds;

      const { chunks, fileResults } = await ragService.semanticSearchForChat(
        { fileIds: params.fileIds, knowledgeIds: knowledgeBaseIds, query, topK },
        ctx.signal,
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
        error: { body: e, message: (e as Error).message, type: 'PluginServerError' },
        success: false,
      };
    }
  };

  /**
   * Read bounded pages from original files without requiring embeddings.
   */
  readKnowledge = async (params: ReadKnowledgeArgs): Promise<BuiltinToolResult> => {
    try {
      const { fileIds } = params;

      if (!fileIds || fileIds.length === 0 || fileIds.length > 8) {
        return {
          content: 'Provide between 1 and 8 file IDs. Read additional files in subsequent calls.',
          success: false,
        };
      }

      const fileContents = await ragService.getFileContents(fileIds);

      const formattedContent = promptFileContents(fileContents, params);

      const state: ReadKnowledgeState = {
        files: fileContents.map((file): FileContentDetail => ({
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
        error: { body: e, message: (e as Error).message, type: 'PluginServerError' },
        success: false,
      };
    }
  };
}

// Export the executor instance for registration
export const knowledgeBaseExecutor = new KnowledgeBaseExecutor();
