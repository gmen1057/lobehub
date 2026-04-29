import type { BuiltinToolContext, BuiltinToolResult } from '@lobechat/types';
import { BaseExecutor } from '@lobechat/types';

import { toolsClient } from '@/libs/trpc/client';

import { DocumentsExecutionRuntime } from '../ExecutionRuntime';
import { DocumentsIdentifier } from '../manifest';
import type { DocumentsRuntimeService, GenerateDocumentInput } from '../types';
import { DocumentsApiName } from '../types';

class ClientDocumentsService implements DocumentsRuntimeService {
  constructor(private context: BuiltinToolContext) {}

  async generateDocument(input: GenerateDocumentInput) {
    return toolsClient.documents.generateDocument.mutate({
      ...input,
      messageId: input.messageId ?? this.context.messageId,
      topicId: input.topicId ?? this.context.topicId,
    });
  }
}

class DocumentsExecutor extends BaseExecutor<typeof DocumentsApiName> {
  readonly identifier = DocumentsIdentifier;
  protected readonly apiEnum = DocumentsApiName;

  private getRuntime(ctx: BuiltinToolContext): DocumentsExecutionRuntime {
    return new DocumentsExecutionRuntime(new ClientDocumentsService(ctx));
  }

  generateDocument = async (
    params: GenerateDocumentInput,
    ctx: BuiltinToolContext,
  ): Promise<BuiltinToolResult> => {
    const runtime = this.getRuntime(ctx);
    const result = await runtime.generateDocument(params);

    return {
      content: result.content,
      error: result.error
        ? { body: result.error, message: result.content, type: 'DocumentGenerationError' }
        : undefined,
      state: result.state,
      success: result.success,
    };
  };
}

export const documentsExecutor = new DocumentsExecutor();
