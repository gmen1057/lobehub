import type { BuiltinToolManifest } from '@lobechat/types';

import { systemPrompt } from './systemRole';
import { DocumentFormat, DocumentsApiName, DocumentsIdentifier } from './types';

const documentFormatEnum = [
  DocumentFormat.Pdf,
  DocumentFormat.Docx,
  DocumentFormat.Xlsx,
  DocumentFormat.Markdown,
];

export const DocumentsManifest: BuiltinToolManifest = {
  api: [
    {
      description:
        'Generate a downloadable file (PDF, DOCX, XLSX, or Markdown) from markdown content.',
      name: DocumentsApiName.generateDocument,
      parameters: {
        properties: {
          contentMarkdown: {
            description:
              'Markdown content (for pdf/docx/md). Tables become spreadsheet content if format=xlsx.',
            type: 'string',
          },
          filename: {
            description: 'Filename without extension',
            type: 'string',
          },
          format: {
            enum: documentFormatEnum,
            type: 'string',
          },
          sheets: {
            description: 'Optional structured XLSX data; only used if format=xlsx',
            items: {
              properties: {
                name: { type: 'string' },
                rows: {
                  items: {
                    items: { type: ['string', 'number', 'boolean'] },
                    type: 'array',
                  },
                  type: 'array',
                },
              },
              required: ['rows'],
              type: 'object',
            },
            type: 'array',
          },
          title: {
            description: 'Document title',
            type: 'string',
          },
        },
        required: ['format', 'title', 'filename', 'contentMarkdown'],
        type: 'object',
      },
      renderDisplayControl: 'alwaysExpand',
    },
  ],
  identifier: DocumentsIdentifier,
  meta: {
    avatar: '📄',
    description: 'Generate downloadable PDF, DOCX, XLSX, and Markdown files from chat content.',
    readme:
      'Create downloadable documents from model-generated markdown. Supports PDF, Word/DOCX, Excel/XLSX, and Markdown files.',
    title: 'Documents',
  },
  systemRole: systemPrompt,
  type: 'builtin',
};

export { DocumentFormat, DocumentsApiName, DocumentsIdentifier } from './types';
