import { TEXT_FILE_TOOL } from '@lobechat/builtin-tools';

import { RECEIPT_PREFIX, TextFileError, TextFileStore } from '@/server/services/textFiles/store';

import type { ServerRuntimeRegistration } from './types';

export const textFileRuntime: ServerRuntimeRegistration = {
  identifier: TEXT_FILE_TOOL,
  factory: ({
    parentMessageId,
    serverDB,
    studioTextFileEnabled,
    studioTextFileRequestId,
    studioTextFileContinueId,
    topicId,
    userId,
    operationId,
  }) => ({
    async writePart(args: unknown) {
      const fields = { operationId, topicId, userId };
      try {
        if (!studioTextFileEnabled || !serverDB || !topicId || !userId || !parentMessageId)
          throw new TextFileError('not_found');
        if (
          studioTextFileContinueId &&
          (args as { documentId?: unknown } | null)?.documentId !== studioTextFileContinueId
        )
          throw new TextFileError('part_conflict');
        const receipt = await new TextFileStore(serverDB, userId, topicId).write(
          operationId ?? parentMessageId,
          args,
          studioTextFileRequestId,
        );
        console.info('[text-file]', {
          ...fields,
          documentId: receipt.documentId,
          lastPart: receipt.part,
          stage: receipt.status,
        });
        return {
          content: RECEIPT_PREFIX + JSON.stringify(receipt),
          state: { documentId: receipt.documentId, part: receipt.part, status: receipt.status },
          success: true,
        };
      } catch (error) {
        const reason = error instanceof TextFileError ? error.code : 'storage_error';
        console.warn('[text-file]', { ...fields, stage: 'write_failed', reason });
        return {
          content: 'ARCKEP_TEXT_FILE_ERROR_V1\n' + JSON.stringify({ reason }),
          success: false,
        };
      }
    },
  }),
};
