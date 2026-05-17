import { type FetchSSEOptions } from '@lobechat/fetch-sse';
import {
  type RuntimeInitialContext,
  type RuntimeStepContext,
  type TracePayload,
} from '@lobechat/types';

export interface FetchOptions extends FetchSSEOptions {
  agentId?: string;
  /**
   * Assistant message id (placeholder created by aiChat.sendMessageInServer).
   * Threaded into the `x-assistant-message-id` request header so the upstream
   * billing proxy can persist the resolved chat content directly to LobeChat's
   * `messages` table even if the client disconnects mid-stream (iOS background
   * tab suspend). See plan: chat-streaming-resilience phase 2.
   */
  assistantMessageId?: string;
  historySummary?: string;
  /** Initial context for page editor (captured at operation start) */
  initialContext?: RuntimeInitialContext;
  signal?: AbortSignal | undefined;
  /** Step context for page editor (updated each step) */
  stepContext?: RuntimeStepContext;
  topicId?: string;
  trace?: TracePayload;
}
