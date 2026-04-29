import type { GenerateDocumentInput } from '@lobechat/builtin-tool-documents';
import { DocumentsExecutionRuntime, DocumentsIdentifier } from '@lobechat/builtin-tool-documents';

import { DocumentsService } from '@/server/services/documents';

import type { ToolExecutionContext } from '../types';
import type { ServerRuntimeRegistration } from './types';

interface DocumentToolExecutionContext extends ToolExecutionContext {
  messageId?: string;
  toolCallId?: string;
}

export const documentsRuntime: ServerRuntimeRegistration = {
  factory: (context) => {
    if (!context.userId || !context.serverDB) {
      throw new Error('userId and serverDB are required for Documents execution');
    }

    const service = new DocumentsService(context.serverDB, context.userId);

    return new DocumentsExecutionRuntime({
      generateDocument: (input: GenerateDocumentInput) => service.generateDocument(input),
    }) as DocumentsExecutionRuntime & {
      generateDocument: (
        args: GenerateDocumentInput,
        runtimeContext?: DocumentToolExecutionContext,
      ) => ReturnType<DocumentsExecutionRuntime['generateDocument']>;
    };
  },
  identifier: DocumentsIdentifier,
};
