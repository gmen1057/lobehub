import { type ChatCompletionErrorPayload, type ModelRuntime } from '@lobechat/model-runtime';
import { AGENT_RUNTIME_ERROR_SET } from '@lobechat/model-runtime';
import { ChatErrorType } from '@lobechat/types';

import { checkAuth } from '@/app/(backend)/middleware/auth';
import {
  createTraceOptions,
  initModelRuntimeFromDB,
  normalizeAssistantMessageId,
} from '@/server/modules/ModelRuntime';
import { type ChatStreamPayload } from '@/types/openai/chat';
import { createErrorResponse } from '@/utils/errorResponse';
import { getTracePayload } from '@/utils/trace';

// If user don't use fluid compute, will build  failed
// this enforce user to enable fluid compute
export const maxDuration = 300;

export const POST = checkAuth(
  async (req: Request, { params, userId, serverDB, createRuntime, jwtPayload }) => {
    const provider = (await params)!.provider!;

    try {
      // ============  1. init chat model   ============ //
      // Browser sends conversation ids (chat/index.ts); forward into billing proxy.
      const sessionId = req.headers.get('x-session-id') ?? undefined;
      const topicId = req.headers.get('x-topic-id') ?? undefined;
      const assistantMessageId = normalizeAssistantMessageId(
        req.headers.get('x-assistant-message-id'),
      );

      let modelRuntime: ModelRuntime;
      if (createRuntime) {
        // Legacy support for custom runtime creation
        modelRuntime = createRuntime(jwtPayload);
      } else {
        // Read user's provider config from database
        modelRuntime = await initModelRuntimeFromDB(serverDB, userId, provider, {
          sessionId,
          topicId,
          assistantMessageId,
        });
      }

      // ============  2. create chat completion   ============ //

      const data = (await req.json()) as ChatStreamPayload;

      const clientTrace = getTracePayload(req);
      let traceOptions = {};
      // Arckep: trace every billed chat to Langfuse when the server flag is on.
      // Read process.env here (not getLangfuseConfig) so route tests stay isolated.
      // Do not honor the client telemetry opt-out — owner requires all users.
      if (process.env.ENABLE_LANGFUSE === '1') {
        traceOptions = createTraceOptions(data, {
          provider,
          trace: {
            ...clientTrace,
            enabled: true,
            sessionId: clientTrace?.sessionId || sessionId,
            topicId: clientTrace?.topicId || topicId,
            userId: clientTrace?.userId || userId,
          },
        });
      }

      return await modelRuntime.chat(data, {
        user: userId,
        ...traceOptions,
        signal: req.signal,
      });
    } catch (e) {
      const {
        errorType = ChatErrorType.InternalServerError,
        error: errorContent,
        ...res
      } = e as ChatCompletionErrorPayload;

      const error = errorContent || e;

      const logMethod = AGENT_RUNTIME_ERROR_SET.has(errorType as string) ? 'warn' : 'error';
      // track the error at server side
      // eslint-disable-next-line no-console
      console[logMethod](`Route: [${provider}] ${errorType}:`, error);

      return createErrorResponse(errorType, { error, ...res, provider });
    }
  },
);
