import type { BuiltinServerRuntimeOutput } from '@lobechat/types';

import { DocumentsIdentifier } from '../manifest';
import type {
  DocumentsRuntimeService,
  GenerateDocumentInput,
  GenerateDocumentState,
} from '../types';

interface DocumentsExecutionContext {
  messageId?: string;
  toolCallId?: string;
  topicId?: null | string;
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class DocumentsExecutionRuntime {
  constructor(private service: DocumentsRuntimeService) {}

  async generateDocument(
    args: GenerateDocumentInput,
    context?: DocumentsExecutionContext,
  ): Promise<BuiltinServerRuntimeOutput> {
    try {
      const result = await this.service.generateDocument({
        ...args,
        messageId: args.messageId ?? context?.messageId,
        toolCallId: args.toolCallId ?? context?.toolCallId,
        topicId: args.topicId ?? context?.topicId,
      });
      const state: GenerateDocumentState = {
        ...result,
        format: args.format,
        status: 'success',
        title: args.title,
        toolIdentifier: DocumentsIdentifier,
      };

      return {
        content: `Document generated: ${result.filename}\nDownload URL: ${result.url}`,
        state,
        success: true,
      };
    } catch (error) {
      const message = errorMessage(error);
      return {
        content: `Document generation failed: ${message}`,
        error,
        state: {
          error: message,
          filename: args.filename,
          format: args.format,
          status: 'error',
          title: args.title,
        } satisfies GenerateDocumentState,
        success: false,
      };
    }
  }
}
