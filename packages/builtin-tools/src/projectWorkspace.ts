/* eslint-disable unicorn/text-encoding-identifier-case */
import type { BuiltinToolManifest } from '@lobechat/types';

export const PROJECT_WORKSPACE_TOOL = 'arckep-workspace';

const READ_ONLY_API_NAMES = new Set(['listProjectFiles', 'readProjectFile']);

export const READ_ONLY_PROJECT_WORKSPACE_SYSTEM_ROLE =
  'Inspect files in the current project workspace (read-only mode: this project currently contains binary documents only). Use listProjectFiles to inspect paths and metadata, readProjectFile for parsed document pages when available, or searchKnowledgeBase for semantic search across indexed documents. If you need to create or modify a text file in the project, first call lobe-activator____activateTools with identifiers: ["arckep-workspace"] to unlock write tools.';

export const ProjectWorkspaceManifest: BuiltinToolManifest = {
  api: [
    {
      description:
        'List active files in the project workspace with revisions, sizes, load modes, and protection flags.',
      name: 'listProjectFiles',
      parameters: {
        additionalProperties: false,
        properties: {
          folder: {
            description: 'Optional relative folder prefix (for example: "src" or "docs/specs").',
            type: 'string',
          },
          includeDisabled: {
            description: 'Include files with disabled load mode. Defaults to false.',
            type: 'boolean',
          },
        },
        type: 'object',
      },
    },
    {
      description:
        'Search literal case-insensitive text across active text files in the project workspace.',
      name: 'searchProjectFiles',
      parameters: {
        additionalProperties: false,
        properties: {
          limit: {
            description: 'Maximum matches to return (1..30, default 30).',
            maximum: 30,
            minimum: 1,
            type: 'integer',
          },
          pathPrefix: {
            description: 'Optional POSIX path prefix filter (for example: "src/").',
            type: 'string',
          },
          query: {
            description: 'Non-empty literal substring to find.',
            minLength: 1,
            type: 'string',
          },
        },
        required: ['query'],
        type: 'object',
      },
    },
    {
      description:
        'Read bounded pages of a project workspace file by path or workspaceFileId. Follow nextStartLine or nextOffset when hasMore is true.',
      name: 'readProjectFile',
      parameters: {
        additionalProperties: false,
        properties: {
          maxLines: {
            description: 'Maximum lines per page when using startLine (default 250, max 500).',
            maximum: 500,
            minimum: 1,
            type: 'integer',
          },
          offset: {
            description: '0-based character offset for sequential character paging.',
            minimum: 0,
            type: 'integer',
          },
          path: {
            description:
              'Relative POSIX path in the project workspace (for example: "src/app.py").',
            type: 'string',
          },
          query: {
            description: 'Optional literal search query inside this file.',
            type: 'string',
          },
          revision: {
            description: 'Optional historical revision number; omit for current revision.',
            minimum: 1,
            type: 'integer',
          },
          startLine: {
            description: '1-based starting line number.',
            minimum: 1,
            type: 'integer',
          },
          workspaceFileId: {
            description: 'Workspace file UUID (alternative to path).',
            type: 'string',
          },
        },
        type: 'object',
      },
    },
    {
      description:
        'Apply an atomic batch of search-and-replace edits to an existing project text file at baseRevision. Protected files (AGENTS.md, rules/**, pinned, locked) create a pending user-approval proposal instead of modifying the active file.',
      name: 'patchProjectFile',
      parameters: {
        additionalProperties: false,
        properties: {
          baseRevision: {
            description: 'Expected current revision number from index or readProjectFile.',
            minimum: 1,
            type: 'integer',
          },
          changeNote: {
            description: 'Short revision note (up to 240 chars).',
            type: 'string',
          },
          edits: {
            description: '1..50 non-overlapping search-and-replace edits.',
            items: {
              additionalProperties: false,
              properties: {
                endLine: {
                  description: 'Optional 1-based inclusive end line to narrow matching.',
                  minimum: 1,
                  type: 'integer',
                },
                newText: {
                  description: 'Replacement text (may be empty string).',
                  type: 'string',
                },
                oldText: {
                  description: 'Exact non-empty fragment to match (without line prefixes).',
                  minLength: 1,
                  type: 'string',
                },
                replaceAll: {
                  description: 'Replace all occurrences instead of requiring a unique match.',
                  type: 'boolean',
                },
                startLine: {
                  description: 'Optional 1-based inclusive start line to narrow matching.',
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
          path: {
            description: 'Relative POSIX path of the target text file.',
            type: 'string',
          },
          reason: {
            description: 'Concise explanation shown to the user when editing a protected file.',
            type: 'string',
          },
          workspaceFileId: {
            description: 'Workspace file UUID (alternative to path).',
            type: 'string',
          },
        },
        required: ['baseRevision', 'edits'],
        type: 'object',
      },
    },
    {
      description:
        'Create a new text file (omit baseRevision or pass 0) or overwrite an existing text file (pass current baseRevision) up to 64 KiB (<= 64 KiB) in the project workspace. For files > 64 KiB (up to 2 MiB), use writeProjectFilePart in sequential chunks up to 64 KiB. Protected paths create a pending user-approval proposal.',
      name: 'writeProjectFile',
      parameters: {
        additionalProperties: false,
        properties: {
          baseRevision: {
            description: '0 or omit when creating a new file; current revision when overwriting.',
            minimum: 0,
            type: 'integer',
          },
          changeNote: {
            description: 'Short revision note (up to 240 chars).',
            type: 'string',
          },
          content: {
            description: 'Full plain-text or source content without markdown code fences.',
            type: 'string',
          },
          encoding: {
            description: 'Text encoding (defaults to existing file encoding or utf-8).',
            enum: ['utf-8', 'utf-8-bom', 'windows-1251'],
            type: 'string',
          },
          lineEnding: {
            description: 'Line ending style (LF or CRLF).',
            enum: ['LF', 'CRLF'],
            type: 'string',
          },
          path: {
            description:
              'Relative POSIX path in the project workspace (allowed text/code extension).',
            type: 'string',
          },
          reason: {
            description: 'Concise explanation shown to the user when targeting a protected path.',
            type: 'string',
          },
        },
        required: ['path', 'content'],
        type: 'object',
      },
    },
    {
      description:
        'Write a large text file (> 64 KiB, up to 2 MiB total) to the project workspace in sequential chunks up to 64 KiB UTF-8 each. Start with part=1 (final=false), pass the returned uploadId on parts 2..N, and pass final=true on the last chunk to atomically commit the file (or create a proposal for protected files).',
      name: 'writeProjectFilePart',
      parameters: {
        additionalProperties: false,
        properties: {
          baseRevision: {
            description:
              '0 or omit when creating a new file; expected current revision when overwriting an existing file.',
            minimum: 0,
            type: 'integer',
          },
          changeNote: {
            description:
              'Short revision note or reason for editing a protected file (up to 240 chars).',
            type: 'string',
          },
          encoding: {
            description: 'Text encoding (defaults to existing file encoding or utf-8).',
            enum: ['utf-8', 'utf-8-bom', 'windows-1251'],
            type: 'string',
          },
          final: {
            description:
              'false for intermediate chunks; true on the final chunk to atomically save the file.',
            type: 'boolean',
          },
          lineEnding: {
            description: 'Line ending style (lf/crlf or LF/CRLF).',
            enum: ['lf', 'crlf', 'LF', 'CRLF'],
            type: 'string',
          },
          part: {
            description: '1-based sequential chunk index (1..64).',
            maximum: 64,
            minimum: 1,
            type: 'integer',
          },
          path: {
            description:
              'Relative POSIX path of the project text file (allowed text/code extension).',
            type: 'string',
          },
          text: {
            description: 'Chunk text content (up to 64 KiB UTF-8 per part).',
            type: 'string',
          },
          uploadId: {
            description: 'Upload session identifier returned on part=1 (required when part > 1).',
            type: 'string',
          },
        },
        required: ['path', 'part', 'text', 'final'],
        type: 'object',
      },
    },
    {
      description:
        'Delete (soft-delete) a project workspace file at baseRevision. Protected files create a delete proposal awaiting user approval.',
      name: 'deleteProjectFile',
      parameters: {
        additionalProperties: false,
        properties: {
          baseRevision: {
            description: 'Expected current revision number of the file.',
            minimum: 1,
            type: 'integer',
          },
          path: {
            description: 'Relative POSIX path of the file to delete.',
            type: 'string',
          },
          reason: {
            description: 'Concise reason for deletion (shown on protected-file proposals).',
            type: 'string',
          },
          workspaceFileId: {
            description: 'Workspace file UUID (alternative to path).',
            type: 'string',
          },
        },
        required: ['baseRevision'],
        type: 'object',
      },
    },
  ],
  identifier: PROJECT_WORKSPACE_TOOL,
  meta: {
    avatar: '🗂️',
    description:
      'Чтение, поиск, создание и точечная правка постоянных файлов и правил рабочего пространства проекта',
    title: 'Файлы проекта',
  },
  systemRole:
    'Manage persistent files in the current project workspace. Read on-demand files via readProjectFile or searchProjectFiles before editing. Prefer patchProjectFile with baseRevision for existing text files; use writeProjectFile for new files or full rewrites <= 64 KiB, and writeProjectFilePart in sequential <= 64 KiB chunks for larger text files (> 64 KiB up to 2 MiB). Writes/deletes on protected files (AGENTS.md, rules/**, pinned, or locked) create a pending_user_approval proposal without changing the active version — do not retry submitting the same proposal.',
  type: 'builtin',
};

export const buildReadOnlyProjectWorkspaceManifest = <
  T extends { api: BuiltinToolManifest['api']; systemRole?: string } = BuiltinToolManifest,
>(
  manifest: T = ProjectWorkspaceManifest as unknown as T,
): T => ({
  ...manifest,
  api: manifest.api.filter((api) => READ_ONLY_API_NAMES.has(api.name)),
  systemRole: READ_ONLY_PROJECT_WORKSPACE_SYSTEM_ROLE,
});
