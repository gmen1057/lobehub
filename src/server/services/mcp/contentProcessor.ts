import debug from 'debug';
import pMap from 'p-map';

import { fileEnv } from '@/envs/file';
import { type AudioContent, type ImageContent, type ToolCallContent } from '@/libs/mcp';
import { type FileService } from '@/server/services/file';
import { nanoid } from '@/utils/uuid';

const log = debug('lobe-mcp:content-processor');

export type ProcessContentBlocksFn = (blocks: ToolCallContent[]) => Promise<ToolCallContent[]>;

const MAX_INLINE_BASE64_CHARS = 20_000_000;

const mimeFromFilename = (name: string): string => {
  const ext = name.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'xlsx': {
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    }
    case 'docx': {
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    }
    case 'pptx': {
      return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    }
    case 'pdf': {
      return 'application/pdf';
    }
    case 'csv': {
      return 'text/csv';
    }
    case 'png': {
      return 'image/png';
    }
    case 'jpg':
    case 'jpeg': {
      return 'image/jpeg';
    }
    default: {
      return 'application/octet-stream';
    }
  }
};

const safeFilename = (name: string): string => {
  const base = name.split(/[/\\]/).pop() || 'file';
  const cleaned = base.replaceAll(/[^\w.-]/g, '_').slice(0, 120);
  return cleaned || 'file';
};

/**
 * e2b execute_and_get_file returns JSON with content_base64 in a text block.
 * Dumping that into the chat is not a downloadable file — upload and replace with a URL.
 */
const uploadJsonFilePayload = async (
  text: string,
  fileService: FileService,
  today: string,
): Promise<string | null> => {
  if (!text.includes('content_base64')) return null;

  let parsed: { content_base64?: unknown; filename?: unknown; success?: unknown };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    return null;
  }

  if (parsed.success === false) return null;
  if (typeof parsed.content_base64 !== 'string' || parsed.content_base64.length === 0) return null;
  if (parsed.content_base64.length > MAX_INLINE_BASE64_CHARS) return null;

  const filename = safeFilename(typeof parsed.filename === 'string' ? parsed.filename : 'file');
  const pathname = `${fileEnv.NEXT_PUBLIC_S3_FILE_PATH}/mcp/files/${today}/${nanoid()}-${filename}`;

  const { url } = await fileService.uploadBase64(parsed.content_base64, pathname);
  log(`File payload uploaded, proxy URL: ${url} mime=${mimeFromFilename(filename)}`);

  return `Файл готов: [${filename}](${url})`;
};

/**
 * Process content blocks returned by MCP
 * - Upload images/audio to storage and replace data with proxy URL
 * - Upload JSON file payloads (content_base64) and replace with a download link
 * - Keep other types of blocks unchanged
 */
export const processContentBlocks = async (
  blocks: ToolCallContent[],
  fileService: FileService,
): Promise<ToolCallContent[]> => {
  // Use date-based sharding for privacy compliance (GDPR, CCPA)
  const today = new Date().toISOString().split('T')[0]; // e.g., "2025-11-08"

  return pMap(blocks, async (block) => {
    if (block.type === 'text') {
      const replacement = await uploadJsonFilePayload(block.text, fileService, today);
      if (replacement) return { ...block, text: replacement };
      return block;
    }

    if (block.type === 'image') {
      const imageBlock = block as ImageContent;

      // Extract file extension from mimeType (e.g., "image/png" -> "png")
      const fileExtension = imageBlock.mimeType.split('/')[1] || 'png';

      // Generate unique pathname with date-based sharding
      const pathname = `${fileEnv.NEXT_PUBLIC_S3_FILE_PATH}/mcp/images/${today}/${nanoid()}.${fileExtension}`;

      // Upload base64 image and get proxy URL
      const { url } = await fileService.uploadBase64(imageBlock.data, pathname);

      log(`Image uploaded, proxy URL: ${url}`);

      return { ...block, data: url };
    }

    if (block.type === 'audio') {
      const audioBlock = block as AudioContent;

      // Extract file extension from mimeType (e.g., "audio/mp3" -> "mp3")
      const fileExtension = audioBlock.mimeType.split('/')[1] || 'mp3';

      // Generate unique pathname with date-based sharding
      const pathname = `${fileEnv.NEXT_PUBLIC_S3_FILE_PATH}/mcp/audio/${today}/${nanoid()}.${fileExtension}`;

      // Upload base64 audio and get proxy URL
      const { url } = await fileService.uploadBase64(audioBlock.data, pathname);

      log(`Audio uploaded, proxy URL: ${url}`);

      return { ...block, data: url };
    }

    return block;
  });
};

/**
 * Convert content blocks to string
 * - text: Extract text field
 * - image/audio: Extract data field (usually the proxy URL after upload)
 * - others: Return empty string
 */
export const contentBlocksToString = (blocks: ToolCallContent[] | null | undefined): string => {
  if (!blocks) return '';

  return blocks
    .map((item) => {
      switch (item.type) {
        case 'text': {
          return item.text;
        }

        case 'image': {
          return `![](${item.data})`;
        }

        case 'audio': {
          return `<resource type="${item.type}" url="${item.data}" />`;
        }

        case 'resource': {
          return `<resource type="${item.type}">${JSON.stringify(item.resource)}</resource>}`;
        }

        default: {
          return '';
        }
      }
    })
    .filter(Boolean)
    .join('\n\n');
};
