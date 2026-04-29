import type {
  DocumentSheet,
  GenerateDocumentInput,
  GenerateDocumentResult,
} from '@lobechat/builtin-tool-documents';
import { DocumentFormat, DocumentsIdentifier } from '@lobechat/builtin-tool-documents';
import type { LobeChatDatabase } from '@lobechat/database';
import { TRPCError } from '@trpc/server';
import { sha256 } from 'js-sha256';
import { z } from 'zod';

import { FileService } from '@/server/services/file';
import { MessageService } from '@/server/services/message';

import { auditDocumentToolCall } from './audit';
import type { DocumentRateLimiter } from './rateLimiter';
import { documentRateLimiter } from './rateLimiter';
import { DOCX_MIME_TYPE, renderDocxFromMarkdown } from './renderers/docx';
import { MARKDOWN_MIME_TYPE, renderMarkdownDocument } from './renderers/markdown';
import { generatePdfFromMarkdown } from './renderers/pdf';
import { EXCEL_MIME_TYPE, renderXlsxDocument, resolveSheets } from './renderers/xlsx';
import { sanitizeMarkdown, sanitizeSheets } from './sanitization';

const CONTENT_LIMIT = 100_000;

const cellSchema = z.union([z.string(), z.number(), z.boolean()]);
const sheetSchema = z.object({
  name: z.string().optional(),
  rows: z.array(z.array(cellSchema)),
});

export const generateDocumentInputSchema = z.object({
  contentMarkdown: z.string(),
  filename: z.string(),
  format: z.nativeEnum(DocumentFormat),
  idempotencyKey: z.string().optional(),
  messageId: z.string().optional(),
  sheets: z.array(sheetSchema).optional(),
  title: z.string(),
  toolCallId: z.string().optional(),
  topicId: z.string().nullable().optional(),
});

const extensionByFormat: Record<DocumentFormat, string> = {
  [DocumentFormat.Docx]: 'docx',
  [DocumentFormat.Markdown]: 'md',
  [DocumentFormat.Pdf]: 'pdf',
  [DocumentFormat.Xlsx]: 'xlsx',
};

const mimeByFormat: Record<DocumentFormat, string> = {
  [DocumentFormat.Docx]: DOCX_MIME_TYPE,
  [DocumentFormat.Markdown]: MARKDOWN_MIME_TYPE,
  [DocumentFormat.Pdf]: 'application/pdf',
  [DocumentFormat.Xlsx]: EXCEL_MIME_TYPE,
};

const assertSafeFilename = (filename: string) => {
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid filename' });
  }
};

const sanitizeFilename = (filename: string, format: DocumentFormat) => {
  const withoutExtension = filename.replace(/\.(pdf|docx|xlsx|md)$/i, '');
  const base = withoutExtension
    .toLowerCase()
    .replaceAll(/[^a-z0-9_-]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, 64);

  return `${base || 'document'}.${extensionByFormat[format]}`;
};

const renderDocument = async (
  format: DocumentFormat,
  contentMarkdown: string,
  title: string,
  sheets?: DocumentSheet[],
) => {
  switch (format) {
    case DocumentFormat.Pdf: {
      return generatePdfFromMarkdown(contentMarkdown, title);
    }
    case DocumentFormat.Docx: {
      return renderDocxFromMarkdown(contentMarkdown, title);
    }
    case DocumentFormat.Xlsx: {
      return renderXlsxDocument(resolveSheets(contentMarkdown, sheets, title));
    }
    case DocumentFormat.Markdown: {
      return renderMarkdownDocument(contentMarkdown);
    }
  }
};

export class DocumentsService {
  private fileService: FileService;
  private messageService: MessageService;

  constructor(
    db: LobeChatDatabase,
    private userId: string,
    private rateLimiter: DocumentRateLimiter = documentRateLimiter,
  ) {
    this.fileService = new FileService(db, userId);
    this.messageService = new MessageService(db, userId);
  }

  async generateDocument(input: GenerateDocumentInput): Promise<GenerateDocumentResult> {
    const parsed = generateDocumentInputSchema.parse(input);

    if (parsed.contentMarkdown.length > CONTENT_LIMIT) {
      throw new TRPCError({ code: 'PAYLOAD_TOO_LARGE', message: 'Document content exceeds 100KB' });
    }

    assertSafeFilename(parsed.filename);
    const filename = sanitizeFilename(parsed.filename, parsed.format);
    const topicId = parsed.topicId || 'no-topic';
    const contentMarkdown = sanitizeMarkdown(parsed.contentMarkdown);
    const sheets = sanitizeSheets(parsed.sheets);

    const limit = await this.rateLimiter.check(this.userId);
    if (!limit.allowed) {
      throw new TRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: 'Rate limit reached, try again later',
      });
    }

    const buffer = await renderDocument(parsed.format, contentMarkdown, parsed.title, sheets);
    const mimeType = mimeByFormat[parsed.format];
    const pathname = `documents/${this.userId}/${topicId}/${filename}`;
    const { fileId, key, url } = await this.fileService.uploadFromBuffer(
      buffer,
      mimeType,
      pathname,
    );

    if (parsed.messageId) {
      try {
        const attachResult = await this.messageService.addFilesToMessage(
          parsed.messageId,
          [fileId],
          { topicId: parsed.topicId },
        );
        if (!attachResult.success) {
          throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to attach file' });
        }
      } catch (error) {
        // Cleanup S3 orphan + DB row when attach fails after a successful upload.
        await Promise.allSettled([
          this.fileService.deleteFile(key),
          this.fileService.deleteUserFileRecord(fileId),
        ]).catch((cleanupError) => {
          console.error('[documents] Orphan cleanup failed after attach error:', cleanupError);
        });
        throw error;
      }
    }

    const result = {
      fileId,
      filename,
      mimeType,
      size: buffer.length,
      toolIdentifier: DocumentsIdentifier,
      url,
    } satisfies GenerateDocumentResult;

    auditDocumentToolCall({
      fileId,
      filename,
      format: parsed.format,
      messageId: parsed.messageId,
      mimeType,
      size: buffer.length,
      status: 'success',
      toolCallId: parsed.toolCallId ?? parsed.idempotencyKey ?? sha256(parsed.contentMarkdown),
      topicId: parsed.topicId,
      userId: this.userId,
    });

    return result;
  }
}
