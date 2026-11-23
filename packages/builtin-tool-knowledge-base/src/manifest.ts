import type { BuiltinToolManifest } from '@lobechat/types';

import { systemPrompt } from './systemRole';
import { KnowledgeBaseApiName, KnowledgeBaseIdentifier } from './types';

export const KnowledgeBaseManifest: BuiltinToolManifest = {
  api: [
    {
      description:
        'Search through knowledge base using semantic vector search to find relevant files and chunks. Returns a summary of matching files with their relevance scores and brief excerpts. Use this first to discover which files contain relevant information. IMPORTANT: Since this uses vector-based search, always resolve pronouns and references to concrete entities (e.g., use "authentication system" instead of "it").',
      name: KnowledgeBaseApiName.searchKnowledgeBase,
      parameters: {
        properties: {
          fileIds: {
            type: 'array',
            maxItems: 8,
            items: { type: 'string' },
            description:
              'Optional attachment file IDs to search in addition to agent knowledge bases.',
          },
          query: {
            description:
              'The search query to find relevant information. Be specific and use concrete entities. IMPORTANT: Resolve all pronouns and references (like "it", "that", "this") to actual entity names before searching, as this uses semantic vector search which works best with concrete terms.',
            type: 'string',
          },
          topK: {
            default: 15,
            description:
              'Number of top relevant chunks to return (default: 15). Each file will include the most relevant chunks.',
            maximum: 100,
            minimum: 5,
            type: 'number',
          },
        },
        required: ['query'],
        type: 'object',
      },
    },
    {
      description:
        'Read original uploaded files or knowledge-base files in bounded pages. IDs come from attachment/agent context or search. Works without semantic search or embeddings. Use startLine/maxLines for line-numbered reading (L<N>: <line>; follow nextStartLine), or offset for character-offset reading (follow nextOffset). For literal search supply query to get an index of up to 50 matching lines/offsets (totalMatches + matches) plus context around the first hit. For exhaustive analysis read every page without query or process the full original with a code tool. Never infer whole-file results from a preview or search hits.',
      name: KnowledgeBaseApiName.readKnowledge,
      parameters: {
        properties: {
          fileIds: {
            description: 'File IDs from attachments, agent files, or searchKnowledgeBase results.',
            items: {
              type: 'string',
            },
            type: 'array',
            maxItems: 8,
            minItems: 1,
          },
          maxLines: {
            type: 'integer',
            minimum: 1,
            maximum: 500,
            description:
              'Optional max lines per page when using startLine (default 250, max 500; also bounded by character limit).',
          },
          offset: {
            type: 'integer',
            minimum: 0,
            description:
              'Character offset; start at 0, then copy nextOffset from the previous page.',
          },
          query: {
            type: 'string',
            maxLength: 500,
            description:
              'Optional case-insensitive literal text search starting at offset (or startLine). Returns totalMatches and up to 50 matches (line, offset, preview). Omit for sequential reading.',
          },
          startLine: {
            type: 'integer',
            minimum: 1,
            description:
              'Optional 1-based start line for line-numbered reading (L<N>: <line>). Follow nextStartLine to continue. Omit for character-offset reading.',
          },
        },
        required: ['fileIds'],
        type: 'object',
      },
    },
  ],
  identifier: KnowledgeBaseIdentifier,
  meta: {
    avatar: '📚',
    description: 'Поиск по загруженным документам с использованием AI',
    title: 'База знаний',
  },
  systemRole: systemPrompt,
  type: 'builtin',
};
