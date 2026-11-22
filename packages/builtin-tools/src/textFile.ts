import type { BuiltinToolManifest } from '@lobechat/types';

export const TEXT_FILE_TOOL = 'arckep-text-file';

export const TextFileManifest: BuiltinToolManifest = {
  api: [
    {
      name: 'writePart',
      description:
        'Save one consecutive piece of an exact UTF-8 source file in this conversation. For a module, script, config or other long source, write the whole deliverable with multiple calls. Use small complete sections (usually 2000–4000 characters), one call at a time. Start with part 1, omit documentId. Use the returned documentId and increment part for every append. Keep the exact fileName. Each text is appended verbatim including whitespace. Mark final only when the entire requested file is ready. Continue making calls within this turn; do not ask the user between parts. Never invent file links; the UI shows the server receipt.',
      parameters: {
        additionalProperties: false,
        properties: {
          documentId: {
            type: 'string',
            description: 'Server-issued UUID, omit for the first part.',
          },
          fileName: {
            type: 'string',
            description: 'Exact basename, including extension if desired.',
          },
          final: { type: 'boolean' },
          part: { type: 'integer', minimum: 1 },
          text: {
            type: 'string',
            description: 'Only the next source bytes as UTF-8 text; no markdown wrapper.',
          },
        },
        required: ['fileName', 'part', 'text', 'final'],
        type: 'object',
      },
    },
    {
      name: 'patchFile',
      description:
        'Apply an atomic batch of 1–50 targeted search-and-replace edits to an existing text or source file in this conversation and save a new downloadable snapshot. Prefer patchFile over writePart whenever modifying an uploaded file, knowledge file, code artifact, or prior document. Pass either sourceFileId (first edit of an existing file) or documentId (follow-up edit of an existing text-file document, even if already ready) — never both. All edits are matched against the original file and must be non-overlapping; if any edit fails, nothing is saved and per-edit diagnostics are returned. Provide enough context in oldText to be unique, or pass 1-based startLine/endLine (from readKnowledge/getTopicContext with startLine) to narrow the match window. Pass exact source text without markdown fences or L123: prefixes. Never invent file links; the UI shows the server receipt.',
      parameters: {
        additionalProperties: false,
        properties: {
          documentId: {
            description:
              'Server-issued UUID of an existing text-file document to patch further (mutually exclusive with sourceFileId).',
            type: 'string',
          },
          edits: {
            description:
              'Ordered list of 1–50 atomic search-and-replace edits matched against the original snapshot.',
            items: {
              additionalProperties: false,
              properties: {
                endLine: {
                  description:
                    'Optional 1-based inclusive ending line number to narrow the search window.',
                  minimum: 1,
                  type: 'integer',
                },
                newText: {
                  description: 'Replacement UTF-8 text (may be empty string to delete oldText).',
                  type: 'string',
                },
                oldText: {
                  description:
                    'Non-empty exact source fragment to locate in the original file (no markdown wrapper or line-number prefixes).',
                  minLength: 1,
                  type: 'string',
                },
                replaceAll: {
                  description:
                    'Replace every matching occurrence instead of requiring a unique match. Defaults to false.',
                  type: 'boolean',
                },
                startLine: {
                  description:
                    'Optional 1-based inclusive starting line number to narrow the search window.',
                  minimum: 1,
                  type: 'integer',
                },
              },
              required: ['oldText', 'newText'],
              type: 'object',
            },
            maxItems: 50,
            minItems: 1,
            type: 'array',
          },
          fileName: {
            description:
              'Optional exact basename for the resulting file; defaults to the source file or existing document name.',
            type: 'string',
          },
          final: {
            description:
              'Mark the patched snapshot ready for download (defaults to true). Set false only if more edits/parts will follow.',
            type: 'boolean',
          },
          sourceFileId: {
            description:
              'Existing file ID from this conversation (attachment, knowledge file, or code artifact) to patch for the first time (mutually exclusive with documentId).',
            type: 'string',
          },
        },
        required: ['edits'],
        type: 'object',
      },
    },
  ],
  systemRole:
    'Prefer patchFile to atomically edit existing uploaded text/source files or previously saved documents (pass sourceFileId for the first edit or documentId for follow-up edits). Use consecutive writePart calls only when creating a brand-new long text or source file from scratch.',
  identifier: TEXT_FILE_TOOL,
  meta: {
    avatar: '📄',
    description:
      'Создать файл с полным модулем, скриптом, конфигурацией или длинным текстом либо точечно отредактировать существующий файл (patchFile)',
    title: 'Текстовый файл',
  },
  type: 'builtin',
};
