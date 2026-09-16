import { DEFAULT_FILE_EMBEDDING_MODEL_ITEM } from '@lobechat/const';
import type { LobeChatDatabase } from '@lobechat/database';
import type {
  ChatSemanticSearchChunk,
  FileSearchResult,
  SemanticSearchSchemaType,
} from '@lobechat/types';
import { RequestTrigger } from '@lobechat/types';
import { TRPCError } from '@trpc/server';
import pMap from 'p-map';

import { ChunkModel } from '@/database/models/chunk';
import { DocumentModel } from '@/database/models/document';
import { FileModel } from '@/database/models/file';
import { getServerDefaultFilesConfig } from '@/server/globalConfig';
import { initModelRuntimeFromDB } from '@/server/modules/ModelRuntime';
import { DocumentService } from '@/server/services/document';

/**
 * Group chunks by file and calculate relevance scores
 */
const groupAndRankFiles = (chunks: ChatSemanticSearchChunk[], topK: number): FileSearchResult[] => {
  const fileMap = new Map<string, FileSearchResult>();

  // Group chunks by file
  for (const chunk of chunks) {
    const fileId = chunk.fileId || 'unknown';
    const fileName = chunk.fileName || `File ${fileId}`;

    if (!fileMap.has(fileId)) {
      fileMap.set(fileId, {
        fileId,
        fileName,
        relevanceScore: 0,
        topChunks: [],
      });
    }

    const fileResult = fileMap.get(fileId)!;
    fileResult.topChunks.push({
      id: chunk.id,
      similarity: chunk.similarity,
      text: chunk.text || '',
    });
  }

  // Calculate relevance score for each file (average of top 3 chunks)
  for (const fileResult of fileMap.values()) {
    fileResult.topChunks.sort((a, b) => b.similarity - a.similarity);
    const top3 = fileResult.topChunks.slice(0, 3);
    fileResult.relevanceScore =
      top3.reduce((sum, chunk) => sum + chunk.similarity, 0) / top3.length;
    // Keep only top chunks per file
    fileResult.topChunks = fileResult.topChunks.slice(0, 3);
  }

  // Sort files by relevance score and return top K
  return Array.from(fileMap.values())
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, topK);
};

export class KnowledgeRetrievalService {
  private chunkModel: ChunkModel;
  private documentModel: DocumentModel;
  private fileModel: FileModel;
  private documentService: DocumentService;
  constructor(
    private serverDB: LobeChatDatabase,
    private userId: string,
  ) {
    this.chunkModel = new ChunkModel(serverDB, userId);
    this.documentModel = new DocumentModel(serverDB, userId);
    this.fileModel = new FileModel(serverDB, userId);
    this.documentService = new DocumentService(serverDB, userId);
  }

  getFileContents = async (fileIds: string[], _signal?: AbortSignal) => {
    const input = { fileIds };

    return await pMap(
      input.fileIds,
      async (fileId) => {
        // 1. Find file information
        const file = await this.fileModel.findById(fileId);
        if (!file) {
          return {
            content: '',
            error: 'File not found',
            fileId,
            filename: `Unknown file ${fileId}`,
          };
        }

        // 2. Find existing parsed document
        let document:
          | {
              content: string | null;
              metadata: Record<string, any> | null;
            }
          | undefined = await this.documentModel.findByFileId(fileId);

        // 3. If not exists, parse the file
        if (!document) {
          try {
            document = await this.documentService.parseFile(fileId);
          } catch (error) {
            return {
              content: '',
              error: `Failed to parse file: ${(error as Error).message}`,
              fileId,
              filename: file.name,
            };
          }
        }

        // 4. Calculate file statistics
        const content = document.content || '';
        const lines = content.split('\n');
        const totalLineCount = lines.length;
        const totalCharCount = content.length;
        const preview = lines.slice(0, 5).join('\n');

        // 5. Return content with details
        return {
          content,
          fileId,
          filename: file.name,
          metadata: document.metadata,
          preview,
          totalCharCount,
          totalLineCount,
        };
      },
      { concurrency: 3 },
    );
  };

  semanticSearchForChat = async (input: SemanticSearchSchemaType, _signal?: AbortSignal) => {
    try {
      const { model, provider } =
        getServerDefaultFilesConfig().embeddingModel || DEFAULT_FILE_EMBEDDING_MODEL_ITEM;
      // Read user's provider config from database
      const modelRuntime = await initModelRuntimeFromDB(this.serverDB, this.userId, provider);

      // slice content to make sure in the context window limit
      const query = input.query.length > 8000 ? input.query.slice(0, 8000) : input.query;

      const embeddings = await modelRuntime.embeddings(
        {
          dimensions: 1024,
          input: query,
          model,
        },
        { metadata: { trigger: RequestTrigger.SemanticSearch }, user: this.userId },
      );

      const embedding = embeddings![0];

      let finalFileIds = input.fileIds ?? [];

      if (input.knowledgeIds && input.knowledgeIds.length > 0) {
        const knowledgeFiles = await this.serverDB.query.knowledgeBaseFiles.findMany({
          where: (fields, { and, eq, inArray }) =>
            and(
              eq(fields.userId, this.userId),
              inArray(fields.knowledgeBaseId, input.knowledgeIds!),
            ),
        });

        finalFileIds = knowledgeFiles.map((f) => f.fileId).concat(finalFileIds);
      }

      const ownedFiles = await this.fileModel.findByIds(finalFileIds);
      finalFileIds = ownedFiles.map((file) => file.id);
      const chunks = await this.chunkModel.semanticSearchForChat({
        embedding,
        fileIds: finalFileIds,
        query: input.query,
        topK: input.topK,
      });

      // Group chunks by file and calculate relevance scores
      const fileResults = groupAndRankFiles(chunks, input.topK || 15);

      // TODO: need to rerank the chunks

      return { chunks, fileResults };
    } catch (e) {
      console.error(e);

      const error = e as any;
      const errorType = error.errorType;

      // Map business error types to appropriate HTTP status codes
      if (errorType === 'InvalidProviderAPIKey') {
        throw new TRPCError({
          code: 'METHOD_NOT_SUPPORTED',
          message: error.message || 'Invalid API key for embedding provider',
        });
      }

      if (errorType === 'ProviderBizError') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: error.message || 'Provider service error',
        });
      }

      // For unknown errors, still return 500 but with proper message
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: error.message || errorType || 'Failed to perform semantic search',
      });
    }
  };
}
