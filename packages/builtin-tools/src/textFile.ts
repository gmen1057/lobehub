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
  ],
  systemRole: 'Save complete text and source files with consecutive writePart calls.',
  identifier: TEXT_FILE_TOOL,
  meta: { avatar: '📄', description: 'Запись исходного текста по частям', title: 'Текстовый файл' },
  type: 'builtin',
};
