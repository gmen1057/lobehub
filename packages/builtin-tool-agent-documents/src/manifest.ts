import type { BuiltinToolManifest } from '@lobechat/types';

import { systemPrompt } from './systemRole';
import { AgentDocumentsApiName, AgentDocumentsIdentifier } from './types';

const documentReadProperties = {
  limit: {
    description:
      'Maximum source characters in this response (2–20000; at least 2000 for literal searches). Choose a page size and follow nextOffset to continue.',
    maximum: 20000,
    minimum: 2,
    type: 'integer',
  },
  offset: {
    description:
      'UTF-16 character offset in the original. Start at 0, copy nextOffset to continue, or choose another source position.',
    minimum: 0,
    type: 'integer',
  },
  query: {
    description:
      'Optional case-insensitive literal text or heading search. Search matches are not exhaustive document coverage.',
    type: 'string',
  },
  snapshot: {
    description:
      'Source fingerprint from the preceding page. Pass unchanged to avoid combining different document versions.',
    type: 'string',
  },
} as const;

export const AgentDocumentsManifest: BuiltinToolManifest = {
  api: [
    {
      description:
        'Create a new agent document. This is the document-create operation (similar intent to touch/create with initial content).',
      name: AgentDocumentsApiName.createDocument,
      parameters: {
        properties: {
          content: {
            description: 'Document content in markdown or plain text.',
            type: 'string',
          },
          title: {
            description: 'Document title.',
            type: 'string',
          },
        },
        required: ['title', 'content'],
        type: 'object',
      },
    },
    {
      description:
        'Read any part of an original agent document by ID. Returns exact source cursors and a snapshot fingerprint. Follow nextOffset automatically until null for complete coverage; do not replace a whole document from a partial read.',
      name: AgentDocumentsApiName.readDocument,
      parameters: {
        properties: {
          ...documentReadProperties,
          id: {
            description: 'Target document ID.',
            type: 'string',
          },
        },
        required: ['id'],
        type: 'object',
      },
    },
    {
      description:
        'Edit an existing agent document content by ID. Use this for content changes, not title rename.',
      name: AgentDocumentsApiName.editDocument,
      parameters: {
        properties: {
          content: {
            description: 'Updated full document content.',
            type: 'string',
          },
          id: {
            description: 'Target document ID.',
            type: 'string',
          },
        },
        required: ['id', 'content'],
        type: 'object',
      },
    },
    {
      description: 'Remove an existing agent document by ID (similar intent to rm/delete).',
      name: AgentDocumentsApiName.removeDocument,
      parameters: {
        properties: {
          id: {
            description: 'Target document ID.',
            type: 'string',
          },
        },
        required: ['id'],
        type: 'object',
      },
    },
    {
      description:
        'Rename an existing document title by ID (similar intent to mv/rename title-level operation).',
      name: AgentDocumentsApiName.renameDocument,
      parameters: {
        properties: {
          id: {
            description: 'Target document ID.',
            type: 'string',
          },
          newTitle: {
            description: 'New title after rename.',
            type: 'string',
          },
        },
        required: ['id', 'newTitle'],
        type: 'object',
      },
    },
    {
      description: 'Copy an existing document to a new document (similar intent to cp/copy).',
      name: AgentDocumentsApiName.copyDocument,
      parameters: {
        properties: {
          id: {
            description: 'Source document ID.',
            type: 'string',
          },
          newTitle: {
            description: 'Optional title for the copied document.',
            type: 'string',
          },
        },
        required: ['id'],
        type: 'object',
      },
    },
    {
      description:
        'List all agent documents. Returns document id, filename, and title for each document.',
      name: AgentDocumentsApiName.listDocuments,
      parameters: {
        properties: {},
        required: [],
        type: 'object',
      },
    },
    {
      description:
        'Read any part of an original agent document by filename when its ID is unknown. Follow nextOffset with snapshot automatically for complete coverage; query searches literal text or a heading.',
      name: AgentDocumentsApiName.readDocumentByFilename,
      parameters: {
        properties: {
          ...documentReadProperties,
          filename: {
            description: 'Target document filename.',
            type: 'string',
          },
        },
        required: ['filename'],
        type: 'object',
      },
    },
    {
      description:
        'Create or update an agent document by filename. If a document with the given filename exists, its content is updated; otherwise a new document is created.',
      name: AgentDocumentsApiName.upsertDocumentByFilename,
      parameters: {
        properties: {
          content: {
            description: 'Document content in markdown or plain text.',
            type: 'string',
          },
          filename: {
            description: 'Target document filename.',
            type: 'string',
          },
        },
        required: ['filename', 'content'],
        type: 'object',
      },
    },
    {
      description:
        'Update agent-document load rules. Use this to control how documents are loaded into runtime context.',
      name: AgentDocumentsApiName.updateLoadRule,
      parameters: {
        properties: {
          id: {
            description: 'Target document ID.',
            type: 'string',
          },
          rule: {
            description: 'New load rule settings.',
            properties: {
              maxTokens: {
                description: 'Maximum token budget for this document when injected.',
                minimum: 0,
                type: 'number',
              },
              priority: {
                description: 'Lower value means higher load priority.',
                minimum: 0,
                type: 'number',
              },
            },
            type: 'object',
          },
        },
        required: ['id', 'rule'],
        type: 'object',
      },
    },
  ],
  identifier: AgentDocumentsIdentifier,
  meta: {
    avatar: '🗂️',
    description: 'Управление документами агента: создание, редактирование, шаблоны',
    title: 'Документы агента',
  },
  systemRole: systemPrompt,
  type: 'builtin',
};
