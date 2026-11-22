import { TEXT_FILE_TOOL } from '@lobechat/builtin-tools';

import { RECEIPT_PREFIX, TextFileError, TextFileStore } from '@/server/services/textFiles/store';

import type { ToolExecutionContext } from '../types';
import type { ServerRuntimeRegistration } from './types';

export const textFileRuntime: ServerRuntimeRegistration = {
  identifier: TEXT_FILE_TOOL,
  factory: ({
    agentId,
    operationId,
    parentMessageId,
    serverDB,
    studioTextFileContinueId,
    studioTextFileEnabled,
    studioTextFileRequestId,
    toolCallId,
    topicId,
    userId,
  }) => ({
    async patchFile(args: unknown, callContext?: ToolExecutionContext) {
      const effectiveAgentId = callContext?.agentId ?? agentId;
      const effectiveToolCallId = callContext?.toolCallId ?? toolCallId;
      const fields = { action: 'patch', operationId, topicId, userId };
      try {
        if (!studioTextFileEnabled || !serverDB || !topicId || !userId || !parentMessageId)
          throw new TextFileError('not_found');
        if (
          studioTextFileContinueId &&
          (args as { documentId?: unknown } | null)?.documentId !== studioTextFileContinueId
        )
          throw new TextFileError('part_conflict');

        const result = await new TextFileStore(serverDB, userId, topicId).patch(
          operationId ?? parentMessageId,
          args,
          {
            agentId: effectiveAgentId,
            requestMessageId: studioTextFileRequestId,
            toolCallId: effectiveToolCallId,
          },
        );

        console.info('[text-file]', {
          ...fields,
          appliedEdits: result.appliedEdits,
          documentId: result.receipt.documentId,
          lastPart: result.receipt.part,
          replayed: result.replayed ?? false,
          stage: result.receipt.status,
        });

        return {
          content: RECEIPT_PREFIX + JSON.stringify(result.receipt) + '\n' + result.diffSummary,
          state: {
            documentId: result.receipt.documentId,
            part: result.receipt.part,
            status: result.receipt.status,
          },
          success: true,
        };
      } catch (error) {
        const isTextFileError = error instanceof TextFileError;
        const reason = isTextFileError ? error.code : 'storage_error';
        const errorPayload: Record<string, unknown> = { reason };
        if (isTextFileError) {
          if (error.detailsMessage) errorPayload.message = error.detailsMessage;
          if (error.diagnostics?.length) errorPayload.diagnostics = error.diagnostics;
        }
        console.warn('[text-file]', { ...fields, reason, stage: 'patch_failed' });
        return {
          content: 'ARCKEP_TEXT_FILE_ERROR_V1\n' + JSON.stringify(errorPayload),
          ...(isTextFileError ? { error: { code: 'INVALID_ARGUMENT', message: reason } } : {}),
          success: false,
        };
      }
    },

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
