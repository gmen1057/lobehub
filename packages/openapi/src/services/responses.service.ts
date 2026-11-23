import type { AgentState } from '@lobechat/agent-runtime';
import { LOADING_FLAT } from '@lobechat/const';
import { and, desc, eq, isNull, or } from 'drizzle-orm';

import { FileModel } from '@/database/models/file';
import { messages } from '@/database/schemas';
import {
  STUDIO_CHAT_HOURLY_LIMIT,
  studioChatHourlyLimitError,
} from '@/server/modules/AgentRuntime/llmErrorRecovery';
import {
  isProviderFailureCode,
  providerModelFailure,
} from '@/server/modules/AgentRuntime/providerModelFailure';
import { ARCKEP_REASONING_LEVEL_KEY } from '@/server/modules/AgentRuntime/reasoningLevels';
import type {
  StreamChunkData,
  StreamEvent,
} from '@/server/modules/AgentRuntime/StreamEventManager';
import { AgentRuntimeService } from '@/server/services/agentRuntime';
import { isAbortError } from '@/server/services/agentRuntime/abort';
import {
  extractStreamedPartialFromEvents,
  hasPaidOrMeaningfulAssistantPayload,
  SERVER_SHUTDOWN_PLACEHOLDER_ERROR,
} from '@/server/services/agentRuntime/orphanPlaceholders';
import { AiAgentService } from '@/server/services/aiAgent';
import { FileService } from '@/server/services/file';
import { stripTextFileReceiptForClient } from '@/server/services/textFiles/store';
import { hasInFlightTopicCompaction } from '@/server/services/topic/compactionRegistry';

import { BaseService } from '../common/base.service';
import type {
  CreateResponseRequest,
  FunctionCallOutputItem,
  InputItem,
  OutputItem,
  ResponseError,
  ResponseObject,
  ResponseStreamEvent,
  ResponseUsage,
  Tool,
} from '../types/responses.type';
import {
  beginResponseExecution,
  getInFlightResponseTopicsForUser,
  hasInFlightResponseTopic,
  markResponseExecutionCancelled,
} from './engineSlotActivity';
import { type HubOperation, responsesStreamHub } from './responsesStreamHub';

/**
 * arckep (план chat-next-redesign, E1): настройки одного запроса поверх помощника.
 * `model_override`/`provider_override` — модель на одно сообщение; `reasoning.effort` — ступень
 * рассуждений (серверный резолвер переведёт её в параметр модели, `reasoningLevels.ts`);
 * `search` — режим встроенного поиска; `temperature`/`top_p` — параметры вызова;
 * `disabled_tools` — инструменты помощника, выключенные на этот запрос.
 */
export interface ExecOverrides {
  chatConfigOverride?: Record<string, unknown>;
  deepseekDocumentIds?: string[];
  deepseekDocuments?: Array<{ id: string; filename: string; purpose: string; expires_at?: number }>;
  excludePluginIds?: string[];
  model?: string;
  paramsOverride?: Record<string, unknown>;
  provider?: string;
}

export const buildExecOverrides = (params: CreateResponseRequest): ExecOverrides => {
  const out: ExecOverrides = {};
  if (params.model_override) out.model = params.model_override;
  if (params.provider_override) out.provider = params.provider_override;

  const chatConfig: Record<string, unknown> = {};
  if (params.reasoning?.effort) chatConfig[ARCKEP_REASONING_LEVEL_KEY] = params.reasoning.effort;
  if (params.search) chatConfig.searchMode = params.search;
  if (typeof params.data_guard_protected === 'boolean')
    chatConfig.deepseekDataGuardProtected = params.data_guard_protected;
  if (typeof params.read_url === 'boolean') chatConfig.deepseekReadUrl = params.read_url;
  if (typeof params.safety_check === 'boolean')
    chatConfig.deepseekSafetyCheck = params.safety_check;
  if (params.deepseek_document_ids?.length) out.deepseekDocumentIds = params.deepseek_document_ids;
  if (params.deepseek_documents?.length) out.deepseekDocuments = params.deepseek_documents;
  if (Object.keys(chatConfig).length > 0) out.chatConfigOverride = chatConfig;

  const callParams: Record<string, unknown> = {};
  if (typeof params.temperature === 'number') callParams.temperature = params.temperature;
  if (typeof params.top_p === 'number') callParams.top_p = params.top_p;
  if (Object.keys(callParams).length > 0) out.paramsOverride = callParams;

  const disabled = (params.disabled_tools ?? []).filter(Boolean);
  if (disabled.length > 0) out.excludePluginIds = disabled;
  return out;
};

/** arckep (F8): состояние ответа темы для REST (`GET /responses/:id`). */
export interface ResponseStatusInfo {
  created_at: number;
  id: string;
  operation_id: string;
  /** Историю можно отдать с начала (не переполнилась). */
  resumable: boolean;
  status: 'completed' | 'failed' | 'in_progress' | 'incomplete';
}

const knownModelError = (state?: AgentState): ResponseError | undefined => {
  const body = state?.status === 'error' ? state.error?.body : undefined;
  const code = body?.code;
  if (code === 'studio_insufficient_balance') {
    return { code, message: 'Insufficient balance', status: 402 };
  }
  if (code === STUDIO_CHAT_HOURLY_LIMIT) return studioChatHourlyLimitError(body.reset_at);
  if (isProviderFailureCode(code)) return providerModelFailure(code);
};

const notFound = (message: string): Error => {
  const error = new Error(message);
  error.name = 'NotFoundError';
  return error;
};

const conflict = (message: string): Error => {
  const error = new Error(message);
  error.name = 'ConflictError';
  return error;
};

/**
 * Response API Service
 * Handles OpenResponses protocol request execution via AiAgentService.execAgent
 *
 * The `model` field is treated as an agent ID.
 * Execution is delegated to execAgent (background mode),
 * with executeSync used when synchronous results are needed.
 */
export class ResponsesService extends BaseService {
  /**
   * arckep (17.10.2026): причина незавершённого ответа для REST-клиента. Движок останавливается
   * без результата, когда инструмент должен выполнить клиент (client_tool_execution) или нужно
   * подтверждение человеком (waiting_for_human); в режиме без интерфейса подтвердить некому,
   * и раньше это выглядело как completed с пустым текстом.
   */
  private resolveIncompleteReason(state: AgentState | undefined): string | undefined {
    if (!state) return undefined;
    if (state.status === 'interrupted') return state.interruption?.reason ?? 'interrupted';
    if (state.status === 'waiting_for_human') return 'human_approval_required';
    return undefined;
  }

  /**
   * arckep (19.10.2026): тема из previous_response_id должна быть этого человека. Проверка до начала ответа
   * (в том числе потокового), чтобы чужая или несуществующая тема давала HTTP 404 «Тема не найдена», а не
   * событие response.failed посреди потока. Ту же проверку делает и execAgent (последний рубеж).
   */
  async assertPreviousTopicAccess(params: CreateResponseRequest): Promise<void> {
    if (!params.previous_response_id) return;
    const topicId = this.extractTopicIdFromResponseId(params.previous_response_id);
    if (!topicId) return;
    await new AiAgentService(this.db, this.userId).assertTopicAccess(topicId);
  }

  /**
   * arckep (chat-resume-guard, Г1): если в теме из previous_response_id уже идёт ответ (!op.done)
   * и это не продолжение клиентского вызова инструмента (function_call_output), отклоняем 409
   * до запуска второго execAgent и создания дублирующих сообщений.
   */
  assertPreviousTopicIdle(params: CreateResponseRequest): void {
    if (!params.previous_response_id) return;
    const previousTopicId = this.extractTopicIdFromResponseId(params.previous_response_id);
    if (!previousTopicId) return;
    if (hasInFlightTopicCompaction(this.userId, previousTopicId)) {
      throw conflict('Compaction is already in progress for this topic');
    }
    if (this.hasFunctionCallOutputs(params.input)) return;
    const op = responsesStreamHub.findByTopic(this.userId, previousTopicId);
    if (
      (op && !op.done && !op.cancelRequested) ||
      hasInFlightResponseTopic(this.userId, previousTopicId)
    ) {
      throw conflict('Response is already in progress for this topic');
    }
  }

  /**
   * arckep (chat-next-redesign, E2): остановить ответ. Id ответа кодирует тему, у темы может
   * быть незавершённая операция — она помечается прерванной, активный LLM-поток обрывается по
   * AbortSignal, а тема сразу снимается с блокировки новых сообщений.
   */
  async cancelResponse(responseId: string): Promise<{ cancelled: number; id: string }> {
    const topicId = this.extractTopicIdFromResponseId(responseId);
    if (!topicId) return { cancelled: 0, id: responseId };
    const agentRuntimeService = new AgentRuntimeService(this.db, this.userId, {
      queueService: null,
      streamEventManager: responsesStreamHub,
    });
    const interrupted = await agentRuntimeService.interruptTopicOperations(topicId);
    const localOp = responsesStreamHub.findByTopic(this.userId, topicId);
    const localCancelled =
      localOp && !localOp.done ? responsesStreamHub.requestCancel(localOp.operationId) : false;
    if (interrupted > 0 || localCancelled || localOp?.cancelRequested) {
      markResponseExecutionCancelled(this.userId, topicId);
    }
    const cancelled = interrupted > 0 ? interrupted : localCancelled ? 1 : 0;
    this.log('info', 'Response cancel requested', {
      cancelled,
      interrupted,
      localCancelled,
      responseId,
      topicId,
    });
    return { cancelled, id: responseId };
  }

  /**
   * Extract hosted builtin tool identifiers from tools array
   */
  private extractHostedToolIds(tools?: Tool[] | null): string[] {
    if (!tools) return [];
    return tools.filter((t) => t.type !== 'function').map((t) => t.type);
  }

  /**
   * Extract function tool definitions from tools array
   */
  private extractFunctionTools(
    tools?: Tool[] | null,
  ): Array<{ description?: string; name: string; parameters?: Record<string, any> }> {
    if (!tools) return [];
    return tools
      .filter((t): t is Tool & { type: 'function' } => t.type === 'function')
      .map((t) => ({
        description: (t as any).description,
        name: (t as any).name,
        parameters: (t as any).parameters,
      }));
  }

  /**
   * Check if input contains function_call_output items (resume flow)
   */
  private hasFunctionCallOutputs(input: string | InputItem[]): boolean {
    if (typeof input === 'string') return false;
    return input.some((item) => item.type === 'function_call_output');
  }

  /**
   * Extract function_call_output items from input
   */
  private extractFunctionCallOutputs(input: string | InputItem[]): FunctionCallOutputItem[] {
    if (typeof input === 'string') return [];
    return input.filter(
      (item): item is FunctionCallOutputItem => item.type === 'function_call_output',
    );
  }

  /**
   * Build a prompt from function_call_output items for the resume flow.
   * Encodes tool results so the LLM can continue the conversation.
   */
  private buildToolResultPrompt(outputs: FunctionCallOutputItem[]): string {
    const parts = outputs.map((o) => `Tool call ${o.call_id} returned: ${o.output}`);
    return parts.join('\n');
  }

  /**
   * Extract a prompt string from OpenResponses input
   */
  private extractPrompt(input: string | InputItem[]): string {
    if (typeof input === 'string') return input;

    // Find the last user message
    for (let i = input.length - 1; i >= 0; i--) {
      const item = input[i];
      if (item.type === 'message' && item.role === 'user') {
        if (typeof item.content === 'string') return item.content;
        return item.content
          .map((part) => {
            if (part.type === 'input_text') return part.text;
            return '';
          })
          .filter(Boolean)
          .join('');
      }
    }

    return '';
  }

  /**
   * arckep: вложения последнего сообщения пользователя (input_image / input_file) → `files` для execAgent.
   * Раньше движок брал из сообщения только input_text, и картинки с файлами до модели не доходили.
   * input_image: https-адрес из нашего хранилища; input_file: file_id → запись файла пользователя → адрес.
   */
  private async extractAttachments(
    input: string | InputItem[],
  ): Promise<
    Array<{ fileId?: string; mimeType?: string; name?: string; size?: number; url: string }>
  > {
    if (typeof input === 'string') return [];
    let content: unknown = null;
    for (let i = input.length - 1; i >= 0; i--) {
      const item = input[i];
      if (item.type === 'message' && item.role === 'user') {
        content = item.content;
        break;
      }
    }
    if (!Array.isArray(content)) return [];

    const files: Array<{
      fileId?: string;
      mimeType?: string;
      name?: string;
      size?: number;
      url: string;
    }> = [];
    const fileModel = new FileModel(this.db, this.userId);
    const fileService = new FileService(this.db, this.userId);
    for (const part of content) {
      if (part.type === 'input_image' && part.image_url?.startsWith('https://')) {
        files.push({ name: 'image', url: part.image_url });
      } else if (part.type === 'input_file' && part.file_id) {
        // findById ищет только среди файлов этого пользователя: чужой file_id вернёт пусто.
        const file = await fileModel.findById(part.file_id);
        if (!file?.url) continue;
        files.push({
          fileId: part.file_id,
          mimeType: file.fileType ?? undefined,
          name: file.name ?? undefined,
          size: file.size ?? undefined,
          url: await fileService.getFullFileUrl(file.url),
        });
      }
    }
    return files;
  }

  /**
   * Extract system/developer instructions from input items
   * These are concatenated and used as additional system prompt
   */
  private extractInputInstructions(input: string | InputItem[]): string {
    if (typeof input === 'string') return '';

    const parts: string[] = [];
    for (const item of input) {
      if (item.type === 'message' && (item.role === 'system' || item.role === 'developer')) {
        if (typeof item.content === 'string') {
          parts.push(item.content);
        } else {
          const text = item.content
            .map((part) => {
              if (part.type === 'input_text') return part.text;
              return '';
            })
            .filter(Boolean)
            .join('');
          if (text) parts.push(text);
        }
      }
    }

    return parts.join('\n\n');
  }

  /**
   * Build combined instructions from request params and input items
   */
  private buildInstructions(params: CreateResponseRequest): string | undefined {
    const inputInstructions = this.extractInputInstructions(params.input);
    const requestInstructions = params.instructions ?? '';

    const combined = [inputInstructions, requestInstructions].filter(Boolean).join('\n\n');
    return combined || undefined;
  }

  /**
   * Extract assistant content from AgentState after execution
   */
  private extractAssistantContent(state: AgentState): string {
    if (!state.messages?.length) return '';

    for (let i = state.messages.length - 1; i >= 0; i--) {
      const msg = state.messages[i];
      if (
        msg.role === 'assistant' &&
        (msg as any).metadata?.internalRepairAttempt !== true &&
        msg.content
      ) {
        return typeof msg.content === 'string' ? msg.content : '';
      }
    }

    return '';
  }

  /**
   * Extract full output items from AgentState messages, including tool calls.
   * Converts assistant tool_calls → function_call items,
   * tool result messages → function_call_output items,
   * and final assistant message → message item.
   */
  private extractOutputItems(
    state: AgentState,
    responseId: string,
  ): { output: OutputItem[]; outputText: string } {
    if (!state.messages?.length) return { output: [], outputText: '' };

    const output: OutputItem[] = [];
    let outputText = '';
    let itemCounter = 0;
    const ignoredSyntheticToolCallIds = new Set<string>();
    const SYNTHETIC_UNRESOLVED_PREFIX = '__arckep_unresolved_tool______';

    // Skip system messages; process assistant and tool messages in order
    for (const msg of state.messages) {
      if (msg.role === 'assistant') {
        if ((msg as any).metadata?.internalRepairAttempt === true) {
          continue;
        }
        const hasToolCalls = msg.tool_calls && msg.tool_calls.length > 0;

        // Emit message item for assistant text content (even when tool_calls are present)
        const content = typeof msg.content === 'string' ? msg.content : '';
        if (content) {
          outputText = content;
          output.push({
            content: [
              {
                annotations:
                  (msg as any).search?.deepseek?.annotations ?? (msg as any).annotations ?? [],
                logprobs: [],
                text: content,
                type: 'output_text' as const,
              },
            ],
            id: `msg_${responseId}_${itemCounter++}`,
            role: 'assistant' as const,
            status: 'completed' as const,
            type: 'message' as const,
          });
        }

        // Handle tool_calls from assistant
        if (hasToolCalls) {
          for (const toolCall of msg.tool_calls) {
            const rawToolName = toolCall.function?.name ?? '';
            if (rawToolName.startsWith(SYNTHETIC_UNRESOLVED_PREFIX)) {
              if (toolCall.id) ignoredSyntheticToolCallIds.add(toolCall.id);
              continue;
            }
            // Decode internal tool name format back to display name
            const fnName = this.decodeToolName(rawToolName);
            output.push({
              arguments: fnName.startsWith('arckep-text-file/')
                ? '{}'
                : (toolCall.function?.arguments ?? '{}'),
              call_id: toolCall.id ?? `call_${itemCounter}`,
              id: `fc_${responseId}_${itemCounter++}`,
              name: fnName,
              status: 'completed' as const,
              type: 'function_call' as const,
            });
          }
        }
      } else if (msg.role === 'tool') {
        if (msg.tool_call_id && ignoredSyntheticToolCallIds.has(msg.tool_call_id)) {
          continue;
        }
        output.push({
          call_id: msg.tool_call_id ?? '',
          id: `fco_${responseId}_${itemCounter++}`,
          output: stripTextFileReceiptForClient(
            typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
          ),
          status: 'completed' as const,
          type: 'function_call_output' as const,
        });
      }
    }

    return { output, outputText };
  }

  /**
   * Decode internal tool name format to display name.
   * - lobe-client-fn____get_weather → get_weather
   * - lobe-cloud-sandbox____executeCode____builtin → lobe-cloud-sandbox/executeCode
   * - my-plugin____myApi → my-plugin/myApi
   */
  private decodeToolName(rawName: string): string {
    const SEPARATOR = '____';
    if (rawName.startsWith(`lobe-client-fn${SEPARATOR}`)) {
      return rawName.slice(`lobe-client-fn${SEPARATOR}`.length);
    }
    const parts = rawName.split(SEPARATOR);
    if (parts.length >= 2) {
      // parts[0] = identifier, parts[1] = apiName, parts[2+] = type (ignored for display)
      return `${parts[0]}/${parts[1]}`;
    }
    return rawName;
  }

  /**
   * Extract usage from AgentState
   */
  private extractUsage(state: AgentState): ResponseUsage {
    const tokens = state.usage?.llm?.tokens;
    return {
      input_tokens: tokens?.input ?? 0,
      output_tokens: tokens?.output ?? 0,
      total_tokens: tokens?.total ?? 0,
    };
  }

  /**
   * Create a response (non-streaming)
   * Calls execAgent with autoStart: false, then executeSync to wait for completion
   */
  async createResponse(params: CreateResponseRequest): Promise<ResponseObject> {
    this.assertPreviousTopicIdle(params);
    const createdAt = Math.floor(Date.now() / 1000);
    const previousTopicId = params.previous_response_id
      ? this.extractTopicIdFromResponseId(params.previous_response_id)
      : null;
    const functionCallOutputs = this.extractFunctionCallOutputs(params.input);
    const isResumeFlow = Boolean(functionCallOutputs.length > 0 && previousTopicId);
    const execTracker = beginResponseExecution({
      initialTopicId: previousTopicId,
      isResumeFlow,
      userId: this.userId,
    });

    try {
      if (previousTopicId && !responsesStreamHub.hasTopic(previousTopicId, { activeOnly: true })) {
        try {
          await new AgentRuntimeService(this.db, this.userId, {
            queueService: null,
          }).reapOrphanTopicPlaceholders(previousTopicId);
        } catch (reapError) {
          this.log('warn', 'Failed to reap orphan placeholders before createResponse', {
            error: reapError,
            previousTopicId,
          });
        }
      }

      const model = params.model;
      const instructions = this.buildInstructions(params);

      const prompt = isResumeFlow
        ? this.buildToolResultPrompt(functionCallOutputs)
        : this.extractPrompt(params.input);

      this.log('info', 'Creating response via execAgent', {
        hasInstructions: !!instructions,
        isResumeFlow,
        model,
        previousTopicId,
        prompt: prompt.slice(0, 50),
      });

      // 1. Create agent operation without auto-start
      // model field is used as agentId
      const additionalPluginIds = this.extractHostedToolIds(params.tools);
      const functionTools = this.extractFunctionTools(params.tools);
      const aiAgentService = new AiAgentService(this.db, this.userId);
      const attachments = isResumeFlow ? [] : await this.extractAttachments(params.input);
      const execResult = await aiAgentService.execAgent({
        ...buildExecOverrides(params),
        additionalPluginIds: additionalPluginIds.length > 0 ? additionalPluginIds : undefined,
        agentId: model,
        appContext: previousTopicId ? { topicId: previousTopicId } : undefined,
        autoStart: false,
        files: attachments.length > 0 ? attachments : undefined,
        functionTools: functionTools.length > 0 ? functionTools : undefined,
        instructions,
        prompt,
        securityBlacklist: [],
        stream: false,
        userInterventionConfig: { approvalMode: 'auto-run' },
      });

      if (!execResult.success) {
        throw new Error(execResult.error || 'Failed to create agent operation');
      }

      // Generate response ID encoding topicId for multi-turn support
      const responseId = this.generateResponseId(execResult.topicId);
      execTracker.setOperation(execResult.operationId, execResult.topicId ?? responseId);

      // 2. Execute synchronously to completion
      const agentRuntimeService = new AgentRuntimeService(this.db, this.userId, {
        queueService: null,
      });
      const finalState = await agentRuntimeService.executeSync(execResult.operationId);

      // 3. Extract results from final state
      const { output, outputText } = this.extractOutputItems(finalState, responseId);
      const usage = this.extractUsage(finalState);

      const incompleteReason = this.resolveIncompleteReason(finalState);
      const isClientToolInterrupt = !!incompleteReason;

      return this.buildResponseObject({
        completedAt: isClientToolInterrupt ? null : Math.floor(Date.now() / 1000),
        createdAt,
        error: knownModelError(finalState),
        id: responseId,
        incompleteDetails: incompleteReason ? { reason: incompleteReason } : undefined,
        output,
        outputText,
        params,
        status: isClientToolInterrupt
          ? 'incomplete'
          : finalState.status === 'error'
            ? 'failed'
            : 'completed',
        usage,
      });
    } catch (error) {
      const errorResponseId = this.generateResponseId();
      this.log('error', 'Response creation failed', { error, responseId: errorResponseId });

      return this.buildResponseObject({
        createdAt,
        error: {
          code: 'server_error',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
        id: errorResponseId,
        output: [],
        outputText: '',
        params,
        status: 'failed',
      });
    } finally {
      execTracker.finish();
    }
  }

  /**
   * Create a streaming response with real token-level streaming
   * Subscribes to Agent Runtime stream events and converts to OpenResponses SSE events
   */
  async *createStreamingResponse(
    params: CreateResponseRequest,
    signal?: AbortSignal,
    studioWebChat = false,
  ): AsyncGenerator<ResponseStreamEvent> {
    this.assertPreviousTopicIdle(params);
    const createdAt = Math.floor(Date.now() / 1000);
    let sequenceNumber = 0;
    const previousTopicId = params.previous_response_id
      ? this.extractTopicIdFromResponseId(params.previous_response_id)
      : null;
    const functionCallOutputs = this.extractFunctionCallOutputs(params.input);
    const isResumeFlow = Boolean(functionCallOutputs.length > 0 && previousTopicId);
    const execTracker = beginResponseExecution({
      initialTopicId: previousTopicId,
      isResumeFlow,
      userId: this.userId,
    });
    let backgroundExecutionStarted = false;

    try {
      if (previousTopicId && !responsesStreamHub.hasTopic(previousTopicId, { activeOnly: true })) {
        try {
          await new AgentRuntimeService(this.db, this.userId, {
            queueService: null,
          }).reapOrphanTopicPlaceholders(previousTopicId);
        } catch (reapError) {
          this.log('warn', 'Failed to reap orphan placeholders before createResponse', {
            error: reapError,
            previousTopicId,
          });
        }
      }

      const model = params.model;
      const instructions = this.buildInstructions(params);

      const prompt = isResumeFlow
        ? this.buildToolResultPrompt(functionCallOutputs)
        : this.extractPrompt(params.input);

      // 1. Create agent operation (before generating responseId so we have topicId)
      // model field is used as agentId
      const additionalPluginIds = this.extractHostedToolIds(params.tools);
      const functionTools = this.extractFunctionTools(params.tools);
      const aiAgentService = new AiAgentService(this.db, this.userId);
      const attachments = isResumeFlow ? [] : await this.extractAttachments(params.input);
      const execResult = await aiAgentService.execAgent({
        ...buildExecOverrides(params),
        additionalPluginIds: additionalPluginIds.length > 0 ? additionalPluginIds : undefined,
        agentId: model,
        appContext: previousTopicId ? { topicId: previousTopicId } : undefined,
        autoStart: false,
        files: attachments.length > 0 ? attachments : undefined,
        functionTools: functionTools.length > 0 ? functionTools : undefined,
        instructions,
        prompt,
        securityBlacklist: [],
        stream: true,
        studioTextFilesEnabled: studioWebChat && params.studioTextFilesEnabled === true,
        studioCodeFileContinueId: studioWebChat ? params.studioCodeFileContinueId : undefined,
        studioWebChat,
        userInterventionConfig: { approvalMode: 'auto-run' },
      });

      if (!execResult.success) {
        throw new Error(execResult.error || 'Failed to create agent operation');
      }

      const operationId = execResult.operationId;

      // Generate response ID encoding topicId for multi-turn support
      const responseId = this.generateResponseId(execResult.topicId);
      const resolvedTopicId = execResult.topicId ?? responseId;
      execTracker.setOperation(operationId, resolvedTopicId);

      const agentRuntimeService = new AgentRuntimeService(this.db, this.userId, {
        queueService: null,
        streamEventManager: responsesStreamHub,
      });

      let shutdownFinalizedPromise: Promise<AgentState | undefined> | null = null;
      const finalizeOnServerShutdown = (
        _reason: string,
        hubOp: HubOperation,
        completedState?: AgentState,
      ) => {
        if (!shutdownFinalizedPromise) {
          shutdownFinalizedPromise = this.finalizeTopicTurnOnServerShutdown({
            completedState,
            createdAtSec: createdAt,
            hubOp,
            topicId: resolvedTopicId,
          });
        }
        return shutdownFinalizedPromise;
      };

      // Register in hub BEFORE first yield so even if client aborts on chunk 1 or consumer
      // pauses generator before reading chunk 2, the operation is already tracked in hub.
      const op = responsesStreamHub.register({
        onShutdownFinalize: (reason, hubOp) => finalizeOnServerShutdown(reason, hubOp),
        onShutdownInterrupt: async () => {
          await agentRuntimeService.interruptOperation(operationId);
        },
        operationId,
        params,
        responseId,
        topicId: resolvedTopicId,
        userId: this.userId,
      });

      const response = this.buildResponseObject({
        createdAt,
        id: responseId,
        output: [],
        outputText: '',
        params,
        status: 'in_progress',
      });

      backgroundExecutionStarted = true;
      void agentRuntimeService
        .executeSync(operationId)
        .then(
          async (state) => {
            let effectiveState = state;
            if (responsesStreamHub.isShuttingDown()) {
              const overrideState = await finalizeOnServerShutdown('SIGTERM', op, state);
              if (overrideState) effectiveState = overrideState;
            }
            responsesStreamHub.markDone(operationId, effectiveState);
          },
          async (err) => {
            const wasCancelled =
              op.cancelRequested || (isAbortError(err) && err.message === 'user_cancelled');
            if (!wasCancelled) {
              this.log('error', 'Streaming execution failed', { error: err, responseId });
            }
            let effectiveState: AgentState = wasCancelled
              ? ({
                  interruption: {
                    canResume: false,
                    interruptedAt: new Date().toISOString(),
                    reason: 'user_cancelled',
                  },
                  status: 'interrupted',
                } as unknown as AgentState)
              : ({ status: 'error' } as AgentState);
            if (responsesStreamHub.isShuttingDown()) {
              const overrideState = await finalizeOnServerShutdown('SIGTERM', op, effectiveState);
              if (overrideState) effectiveState = overrideState;
            }
            responsesStreamHub.markDone(operationId, effectiveState);
          },
        )
        .finally(() => {
          execTracker.finish();
        });

      // Emit response.created + response.in_progress
      yield { response, sequence_number: sequenceNumber++, type: 'response.created' as const };
      yield {
        response,
        sequence_number: sequenceNumber++,
        type: 'response.in_progress' as const,
      };

      // 3. События ответа — из реестра, тем же путём, что и при переподключении
      yield* this.streamOperationEvents(op, response, sequenceNumber, signal);
    } catch (error) {
      const errorResponseId = this.generateResponseId();
      this.log('error', 'Streaming response failed', { error, responseId: errorResponseId });

      const errorResponse = this.buildResponseObject({
        createdAt,
        error: {
          code: 'server_error',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
        id: errorResponseId,
        output: [],
        outputText: '',
        params,
        status: 'failed',
      });

      yield {
        response: errorResponse,
        sequence_number: sequenceNumber,
        type: 'response.failed' as const,
      };
    } finally {
      if (!backgroundExecutionStarted) {
        execTracker.finish();
      }
    }
  }

  /**
   * arckep (F8): переподключиться к ответу темы — история событий с начала и живой хвост.
   * Нет ответа (не было, вычищен через FINISHED_TTL_MS после конца или история переполнилась) —
   * NotFoundError (404). Завершённый, но ещё не вычищенный ответ отдаётся целиком и сразу закрывается.
   */
  async *resumeStreamingResponse(
    topicId: string,
    signal?: AbortSignal,
  ): AsyncGenerator<ResponseStreamEvent> {
    const op = this.findOperation(topicId);
    if (!op) throw notFound(`No response is running for ${topicId}`);
    if (op.truncated) throw notFound(`Response history for ${topicId} is too long to resume`);
    const response = this.buildResponseObject({
      createdAt: op.createdAt,
      id: op.responseId,
      output: [],
      outputText: '',
      params: op.params,
      status: 'in_progress',
    });
    let sequenceNumber = 0;
    yield { response, sequence_number: sequenceNumber++, type: 'response.created' as const };
    yield { response, sequence_number: sequenceNumber++, type: 'response.in_progress' as const };
    yield* this.streamOperationEvents(op, response, sequenceNumber, signal);
  }

  /**
   * arckep (chat-resume-guard, В1): лёгкое ожидание завершения ответа темы (`?mode=wait`).
   * Работает даже при `op.truncated === true` (`resumable === false`): шлёт `response.created` и
   * `response.in_progress`, пропускает промежуточные чанки, дожидается `op.done` (с отпиской по
   * `signal`) и шлёт финальное `response.completed` / `response.incomplete` из `op.finalState`.
   */
  async *waitStreamingResponse(
    topicId: string,
    signal?: AbortSignal,
  ): AsyncGenerator<ResponseStreamEvent> {
    const op = this.findOperation(topicId);
    if (!op) throw notFound(`No response is running for ${topicId}`);
    const response = this.buildResponseObject({
      createdAt: op.createdAt,
      id: op.responseId,
      output: [],
      outputText: '',
      params: op.params,
      status: 'in_progress',
    });
    let sequenceNumber = 0;
    yield { response, sequence_number: sequenceNumber++, type: 'response.created' as const };
    yield { response, sequence_number: sequenceNumber++, type: 'response.in_progress' as const };

    if (!op.done) {
      let onAbort: (() => void) | undefined;
      let unsubscribe: (() => void) | undefined;
      try {
        await new Promise<void>((resolve) => {
          const attachment = responsesStreamHub.attach(op.operationId, {
            onDone: () => resolve(),
            onEvents: () => undefined,
          });
          unsubscribe = attachment.unsubscribe;
          if (attachment.done || signal?.aborted) {
            attachment.unsubscribe();
            resolve();
            return;
          }
          if (signal) {
            onAbort = () => {
              attachment.unsubscribe();
              resolve();
            };
            signal.addEventListener('abort', onAbort, { once: true });
          }
        });
      } finally {
        unsubscribe?.();
        if (signal && onAbort) {
          signal.removeEventListener('abort', onAbort);
        }
      }
    }

    if (signal?.aborted) return;
    yield this.buildFinalStreamEvent(op, response, sequenceNumber);
  }

  /** arckep (F8): состояние ответа темы; null — ответа нет или он уже вычищен из реестра. */
  getResponseStatus(topicId: string): ResponseStatusInfo | null {
    const op = this.findOperation(topicId);
    if (!op) return null;
    let status: ResponseStatusInfo['status'] = 'in_progress';
    if (op.done) {
      if (op.finalState?.status === 'error') status = 'failed';
      else if (this.resolveIncompleteReason(op.finalState)) status = 'incomplete';
      else status = 'completed';
    } else if (op.cancelRequested) {
      status = 'incomplete';
    }
    return {
      created_at: op.createdAt,
      id: op.responseId,
      operation_id: op.operationId,
      resumable: !op.truncated,
      status,
    };
  }

  /** arckep (F8): темы этого человека, в которых ответ ещё идёт. */
  listRunningTopics(): string[] {
    return [
      ...new Set([
        ...responsesStreamHub.runningTopics(this.userId),
        ...getInFlightResponseTopicsForUser(this.userId),
      ]),
    ];
  }

  private findOperation(topicId: string): HubOperation | undefined {
    if (!topicId) return undefined;
    return responsesStreamHub.findByTopic(this.userId, topicId);
  }

  /**
   * arckep (F8): события ответа из реестра — одинаково для отправки и для переподключения.
   * Сначала уже накопленная история, дальше живые события; конец — по markDone реестра.
   * `signal` — обрыв соединения клиента: отписываемся и выходим, сам ответ идёт дальше.
   */
  private async *streamOperationEvents(
    op: HubOperation,
    response: ResponseObject,
    sequenceNumber: number,
    signal?: AbortSignal,
  ): AsyncGenerator<ResponseStreamEvent> {
    const responseId = op.responseId;
    const eventQueue: StreamEvent[] = [];
    let resolveWaiting: (() => void) | null = null;
    let executionDone = false;
    const wake = () => {
      if (resolveWaiting) {
        resolveWaiting();
        resolveWaiting = null;
      }
    };
    const attachment = responsesStreamHub.attach(op.operationId, {
      onDone: () => {
        executionDone = true;
        wake();
      },
      onEvents: (events) => {
        eventQueue.push(...events);
        wake();
      },
    });
    eventQueue.push(...attachment.history);
    executionDone = attachment.done;
    const onAbort = () => {
      attachment.unsubscribe();
      wake();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const waitForEvents = (): Promise<void> =>
      new Promise((resolve) => {
        if (eventQueue.length > 0 || executionDone || signal?.aborted) {
          resolve();
        } else {
          resolveWaiting = resolve;
        }
      });

    try {
      // 5. Process stream events and emit output items
      let accumulatedText = '';
      let currentGrounding: any;
      let currentOutputIndex = 0;
      let itemCounter = 0;
      let textMessageStarted = false;

      // Track active (in-progress) tool calls for proper incremental streaming
      const activeToolCalls = new Map<
        string,
        { fcItemId: string; name: string; outputIndex: number; prevArguments: string }
      >();
      let currentTextItemId = '';

      const startTextMessage = function* (seq: { n: number }) {
        if (textMessageStarted) return;
        textMessageStarted = true;
        currentTextItemId = `msg_${responseId}_${itemCounter++}`;
        const item: OutputItem = {
          content: [{ annotations: [], logprobs: [], text: '', type: 'output_text' as const }],
          id: currentTextItemId,
          role: 'assistant' as const,
          status: 'in_progress' as const,
          type: 'message' as const,
        };
        yield {
          item,
          output_index: currentOutputIndex,
          sequence_number: seq.n++,
          type: 'response.output_item.added' as const,
        };
        yield {
          content_index: 0,
          item_id: currentTextItemId,
          output_index: currentOutputIndex,
          part: { annotations: [], logprobs: [], text: '', type: 'output_text' as const },
          sequence_number: seq.n++,
          type: 'response.content_part.added' as const,
        };
      };

      const finishTextMessage = function* (seq: { n: number }, text: string) {
        if (!textMessageStarted) return;
        textMessageStarted = false;

        yield {
          content_index: 0,
          item_id: currentTextItemId,
          logprobs: [],
          output_index: currentOutputIndex,
          sequence_number: seq.n++,
          text,
          type: 'response.output_text.done' as const,
        };
        yield {
          content_index: 0,
          item_id: currentTextItemId,
          output_index: currentOutputIndex,
          part: {
            annotations: currentGrounding?.deepseek?.annotations ?? [],
            logprobs: [],
            text,
            type: 'output_text' as const,
          },
          sequence_number: seq.n++,
          type: 'response.content_part.done' as const,
        };
        yield {
          item: {
            content: [
              {
                annotations: currentGrounding?.deepseek?.annotations ?? [],
                logprobs: [],
                text,
                type: 'output_text' as const,
              },
            ],
            id: currentTextItemId,
            role: 'assistant' as const,
            status: 'completed' as const,
            type: 'message' as const,
          } as OutputItem,
          output_index: currentOutputIndex,
          sequence_number: seq.n++,
          type: 'response.output_item.done' as const,
        };
        currentOutputIndex++;
      };

      const finishActiveToolCalls = function* (seq: { n: number }) {
        for (const [callId, tc] of activeToolCalls) {
          yield {
            arguments: tc.prevArguments || '{}',
            item_id: tc.fcItemId,
            output_index: tc.outputIndex,
            sequence_number: seq.n++,
            type: 'response.function_call_arguments.done' as const,
          };
          yield {
            item: {
              arguments: tc.prevArguments || '{}',
              call_id: callId,
              id: tc.fcItemId,
              name: tc.name,
              status: 'completed' as const,
              type: 'function_call' as const,
            } as OutputItem,
            output_index: tc.outputIndex,
            sequence_number: seq.n++,
            type: 'response.output_item.done' as const,
          };
        }
        if (activeToolCalls.size > 0) {
          currentOutputIndex += activeToolCalls.size;
          activeToolCalls.clear();
        }
      };

      // Shared mutable sequence counter for generators
      const seq = { n: sequenceNumber };

      while (!executionDone || eventQueue.length > 0) {
        await waitForEvents();
        if (signal?.aborted) return;

        while (eventQueue.length > 0) {
          const event = eventQueue.shift()!;

          if (event.type === 'stream_chunk') {
            const chunk = event.data as StreamChunkData;

            if (chunk.chunkType === 'grounding' && chunk.grounding) {
              currentGrounding = chunk.grounding;
              if (currentGrounding.deepseek?.finish_reason === 'content_filter')
                accumulatedText = '';
              yield {
                grounding: currentGrounding,
                sequence_number: seq.n++,
                type: 'response.grounding' as const,
              };
            } else if (chunk.chunkType === 'text' && chunk.content) {
              // Start text message output item if not already started
              yield* startTextMessage(seq);

              accumulatedText += chunk.content;
              yield {
                content_index: 0,
                delta: chunk.content,
                item_id: currentTextItemId,
                logprobs: [],
                output_index: currentOutputIndex,
                sequence_number: seq.n++,
                type: 'response.output_text.delta' as const,
              };
            } else if (chunk.chunkType === 'tools_calling' && chunk.toolsCalling) {
              // Close any open text message before emitting tool calls
              yield* finishTextMessage(seq, accumulatedText);
              accumulatedText = '';

              // Stream tool call deltas incrementally within stable output items
              for (const toolCall of chunk.toolsCalling) {
                const callId = toolCall.id;
                const existing = activeToolCalls.get(callId);

                if (!existing) {
                  // First time seeing this tool call — emit output_item.added
                  const fcItemId = `fc_${responseId}_${itemCounter++}`;
                  const isClientTool = toolCall.identifier === 'lobe-client-fn';
                  const toolDisplayName = isClientTool
                    ? toolCall.apiName
                    : `${toolCall.identifier}/${toolCall.apiName}`;
                  const outputIndex = currentOutputIndex + activeToolCalls.size;

                  activeToolCalls.set(callId, {
                    fcItemId,
                    name: toolDisplayName,
                    outputIndex,
                    prevArguments: '',
                  });

                  yield {
                    item: {
                      arguments: '',
                      call_id: callId,
                      id: fcItemId,
                      name: toolDisplayName,
                      status: 'in_progress' as const,
                      type: 'function_call' as const,
                    } as OutputItem,
                    output_index: outputIndex,
                    sequence_number: seq.n++,
                    type: 'response.output_item.added' as const,
                  };

                  // Emit initial delta if arguments already present
                  if (toolCall.arguments) {
                    activeToolCalls.get(callId)!.prevArguments = toolCall.arguments;
                    yield {
                      delta: toolCall.arguments,
                      item_id: fcItemId,
                      output_index: outputIndex,
                      sequence_number: seq.n++,
                      type: 'response.function_call_arguments.delta' as const,
                    };
                  }
                } else {
                  // Subsequent chunk — compute incremental delta
                  const currentArgs = toolCall.arguments ?? '';
                  const delta = currentArgs.slice(existing.prevArguments.length);

                  if (delta) {
                    existing.prevArguments = currentArgs;
                    yield {
                      delta,
                      item_id: existing.fcItemId,
                      output_index: existing.outputIndex,
                      sequence_number: seq.n++,
                      type: 'response.function_call_arguments.delta' as const,
                    };
                  }
                }
              }
            } else if (chunk.chunkType === 'reasoning' && chunk.reasoning) {
              // arckep (chat-next-redesign, E1): рассуждения — отдельным событием, не в тексте
              // ответа (раньше здесь только открывался текстовый item, а текст рассуждений терялся)
              yield {
                delta: chunk.reasoning,
                item_id: `rs_${responseId}`,
                output_index: currentOutputIndex,
                sequence_number: seq.n++,
                type: 'response.reasoning_text.delta' as const,
              };
            }
          } else if (event.type === 'tool_end') {
            // Finalize any remaining active tool calls before emitting tool output
            yield* finishActiveToolCalls(seq);

            // Emit function_call_output for completed tool execution
            const toolData = event.data as {
              isSuccess: boolean;
              payload: { toolCalling: { id: string } };
              result: { content: string };
            };
            const fcoItemId = `fco_${responseId}_${itemCounter++}`;
            const clientToolOutput = stripTextFileReceiptForClient(toolData.result?.content ?? '');

            yield {
              item: {
                call_id: toolData.payload.toolCalling.id,
                id: fcoItemId,
                output: clientToolOutput,
                status: 'completed' as const,
                type: 'function_call_output' as const,
              } as OutputItem,
              output_index: currentOutputIndex,
              sequence_number: seq.n++,
              type: 'response.output_item.added' as const,
            };
            yield {
              item: {
                call_id: toolData.payload.toolCalling.id,
                id: fcoItemId,
                output: clientToolOutput,
                status: 'completed' as const,
                type: 'function_call_output' as const,
              } as OutputItem,
              output_index: currentOutputIndex,
              sequence_number: seq.n++,
              type: 'response.output_item.done' as const,
            };
            currentOutputIndex++;
          } else if (event.type === 'stream_retry') {
            // LLM retry — discard stale tool call state from the failed attempt
            // so we don't emit phantom function_calls on final flush
            activeToolCalls.clear();
            if ((event.data as { resetText?: boolean } | undefined)?.resetText === true) {
              accumulatedText = '';
            }
          }
        }
      }

      // Finalize any in-progress tool calls
      yield* finishActiveToolCalls(seq);

      // Close any remaining open text message
      yield* finishTextMessage(seq, accumulatedText);
      sequenceNumber = seq.n;

      if (signal?.aborted) return;
      yield this.buildFinalStreamEvent(op, response, sequenceNumber, accumulatedText);
    } finally {
      attachment.unsubscribe();
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /**
   * Сборка терминального SSE-события (`response.completed` или `response.incomplete`) по `op.finalState`
   * — общая для полного потока (`streamOperationEvents`) и режима ожидания (`waitStreamingResponse`).
   */
  private buildFinalStreamEvent(
    op: HubOperation,
    response: ResponseObject,
    sequenceNumber: number,
    fallbackText: string = '',
  ): ResponseStreamEvent {
    const finalState = op.finalState;
    let text = fallbackText;
    if (!text && finalState) {
      text = this.extractAssistantContent(finalState);
    }

    const usage = finalState
      ? this.extractUsage(finalState)
      : { input_tokens: 0, output_tokens: 0, total_tokens: 0 };

    const fullOutput = finalState
      ? this.extractOutputItems(finalState, op.responseId)
      : { output: [], outputText: text };

    const incompleteReason = this.resolveIncompleteReason(finalState);
    if (incompleteReason) {
      return {
        response: {
          ...response,
          completed_at: null,
          incomplete_details: { reason: incompleteReason },
          output: fullOutput.output,
          output_text: fullOutput.outputText || text,
          status: 'incomplete' as any,
          usage: {
            input_tokens: usage.input_tokens,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: usage.output_tokens,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: usage.total_tokens,
          },
        },
        sequence_number: sequenceNumber,
        type: 'response.incomplete' as const,
      };
    }

    // arckep: при ошибке модели (например, отказ биллинг-прокси) клиенту нужен текст ошибки,
    // а не пустой ответ со status=failed (план lobechat-engine-studio-chat, Phase 2).
    const stateError = finalState?.status === 'error' ? finalState.error : undefined;
    const stateErrorMessage =
      stateError?.error?.message || stateError?.message || stateError?.errorType;
    return {
      response: {
        ...response,
        completed_at: Math.floor(Date.now() / 1000),
        error:
          knownModelError(finalState) ??
          (stateError
            ? {
                code: 'model_error' as const,
                message: String(stateErrorMessage || 'Model execution failed'),
                status: stateError.body?.status,
              }
            : null),
        output: fullOutput.output,
        output_text: fullOutput.outputText || text,
        status: (finalState?.status === 'error' ? 'failed' : 'completed') as any,
        usage: {
          input_tokens: usage.input_tokens,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: usage.output_tokens,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: usage.total_tokens,
        },
      },
      sequence_number: sequenceNumber,
      type: 'response.completed' as const,
    };
  }

  /**
   * Finalize an in-flight topic turn during SIGTERM graceful shutdown:
   * - Preserves any already-saved paid partial output/reasoning/tools/images and full multi-step
   *   `completedState` (`messages`, `usage`, `cost`) without overwriting or duplicating text across steps.
   * - If the current step's DB row is still `LOADING_FLAT` (`'...'`) while `ResponsesStreamHub` already
   *   streamed text/reasoning for THIS step's assistant message, persists that partial content onto the DB row.
   * - Only when the ENTIRE turn produced zero output/tools/reasoning/media before SIGTERM, replaces
   *   `LOADING_FLAT` with an explicit server-shutdown error (`SERVER_SHUTDOWN_PLACEHOLDER_ERROR`).
   */
  private async finalizeTopicTurnOnServerShutdown(params: {
    completedState?: AgentState;
    createdAtSec: number;
    hubOp: HubOperation;
    topicId: string;
  }): Promise<AgentState | undefined> {
    const { completedState, createdAtSec, hubOp, topicId } = params;
    const baseState = completedState ?? hubOp.finalState;
    const streamed = extractStreamedPartialFromEvents(hubOp.events);

    const hasPriorStateWork = Boolean(
      baseState?.messages?.some((msg) => {
        if (msg.role === 'tool') return true;
        if (msg.role !== 'assistant') return false;
        if ((msg as any).metadata?.internalRepairAttempt === true) return false;
        const text = typeof msg.content === 'string' ? msg.content.trim() : '';
        if (text.length > 0 && text !== LOADING_FLAT) return true;
        return Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
      }),
    );

    const buildInterruptedState = (appendText?: string): AgentState => {
      const existingMessages = [...(baseState?.messages ?? [])];
      while (
        existingMessages.length > 0 &&
        existingMessages.at(-1)?.role === 'assistant' &&
        (!existingMessages.at(-1)?.content || existingMessages.at(-1)?.content === LOADING_FLAT) &&
        !existingMessages.at(-1)?.tool_calls?.length
      ) {
        existingMessages.pop();
      }
      if (appendText) {
        const last = existingMessages.at(-1);
        if (!(
          last?.role === 'assistant' &&
          last.content === appendText &&
          !last.tool_calls?.length
        )) {
          existingMessages.push({ content: appendText, role: 'assistant' });
        }
      }
      return {
        ...baseState,
        interruption: baseState?.interruption ?? {
          canResume: false,
          interruptedAt: new Date().toISOString(),
          reason: 'user_cancelled',
        },
        messages: existingMessages,
        status: 'interrupted',
      } as unknown as AgentState;
    };

    const buildShutdownErrorState = (): AgentState =>
      ({
        ...baseState,
        error: SERVER_SHUTDOWN_PLACEHOLDER_ERROR,
        messages: baseState?.messages ?? [],
        status: 'error',
      }) as unknown as AgentState;

    if (this.db && typeof (this.db as any).select === 'function' && this.userId && topicId) {
      try {
        const recentRows = await this.db
          .select({
            content: messages.content,
            createdAt: messages.createdAt,
            error: messages.error,
            id: messages.id,
            metadata: messages.metadata,
            reasoning: messages.reasoning,
            role: messages.role,
            tools: messages.tools,
            updatedAt: messages.updatedAt,
          })
          .from(messages)
          .where(
            and(
              eq(messages.userId, this.userId),
              eq(messages.topicId, topicId),
              eq(messages.role, 'assistant'),
            ),
          )
          .orderBy(desc(messages.createdAt))
          .limit(5);

        const turnFloorMs = (createdAtSec - 5) * 1000;
        const turnRows = recentRows.filter((row) => {
          const ts = row.createdAt ? new Date(row.createdAt).getTime() : Number.NaN;
          return !Number.isFinite(ts) || ts >= turnFloorMs;
        });
        const turnRow = turnRows[0];
        const priorDbWork = turnRows
          .slice(1)
          .some((row) => hasPaidOrMeaningfulAssistantPayload(row));
        const hasAnyPriorTurnWork = priorDbWork || hasPriorStateWork;

        if (turnRow) {
          if (hasPaidOrMeaningfulAssistantPayload(turnRow)) {
            return undefined;
          }

          const canApplyStreamedToRow =
            !streamed.assistantMessageId || streamed.assistantMessageId === turnRow.id;

          if (canApplyStreamedToRow && (streamed.text || streamed.reasoning)) {
            await this.db
              .update(messages)
              .set({
                content: streamed.text,
                metadata: {
                  ...(turnRow.metadata && typeof turnRow.metadata === 'object'
                    ? (turnRow.metadata as Record<string, unknown>)
                    : {}),
                  finishReason: 'interrupted',
                },
                ...(streamed.reasoning ? { reasoning: { content: streamed.reasoning } } : {}),
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(messages.id, turnRow.id),
                  eq(messages.userId, this.userId),
                  or(eq(messages.content, LOADING_FLAT), eq(messages.content, '')),
                ),
              );

            return buildInterruptedState(streamed.text);
          }

          if (hasAnyPriorTurnWork) {
            if (turnRow.content === LOADING_FLAT) {
              await this.db
                .update(messages)
                .set({
                  content: '',
                  metadata: {
                    ...(turnRow.metadata && typeof turnRow.metadata === 'object'
                      ? (turnRow.metadata as Record<string, unknown>)
                      : {}),
                    finishReason: 'interrupted',
                  },
                  updatedAt: new Date(),
                })
                .where(
                  and(
                    eq(messages.id, turnRow.id),
                    eq(messages.userId, this.userId),
                    eq(messages.content, LOADING_FLAT),
                  ),
                );
            }
            return buildInterruptedState();
          }

          if (!turnRow.error) {
            await this.db
              .update(messages)
              .set({
                content: '',
                error: SERVER_SHUTDOWN_PLACEHOLDER_ERROR,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(messages.id, turnRow.id),
                  eq(messages.userId, this.userId),
                  or(eq(messages.content, LOADING_FLAT), eq(messages.content, '')),
                  isNull(messages.error),
                ),
              );
          }

          return buildShutdownErrorState();
        }
      } catch (dbError) {
        this.log('warn', 'Failed to finalize assistant row on server shutdown', {
          error: dbError,
          topicId,
        });
      }
    }

    if (streamed.text || streamed.reasoning) {
      return buildInterruptedState(streamed.text);
    }

    if (hasPriorStateWork) {
      return buildInterruptedState();
    }

    return buildShutdownErrorState();
  }

  /**
   * Generate a response ID.
   * Uses topicId directly as the response ID for multi-turn support.
   * When no topicId is available, generates a random ID.
   */
  private generateResponseId(topicId?: string): string {
    if (topicId) return topicId;

    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let id = '';
    for (let i = 0; i < 24; i++) {
      id += chars[Math.floor(Math.random() * chars.length)];
    }
    return id;
  }

  /**
   * Extract topicId from a response ID (previous_response_id).
   * Since response ID is the topicId itself, just return it directly.
   */
  private extractTopicIdFromResponseId(responseId: string): string | null {
    return responseId || null;
  }

  private buildResponseObject(opts: {
    completedAt?: number | null;
    createdAt: number;
    error?: ResponseError;
    id: string;
    incompleteDetails?: { reason: string };
    output: OutputItem[];
    outputText: string;
    params: CreateResponseRequest;
    status: ResponseObject['status'];
    usage?: ResponseUsage;
  }): ResponseObject {
    const p = opts.params as Record<string, any>;
    return {
      background: p.background ?? false,
      completed_at: opts.completedAt ?? null,
      created_at: opts.createdAt,
      error: opts.error ?? null,
      frequency_penalty: p.frequency_penalty ?? 0,
      id: opts.id,
      incomplete_details: opts.incompleteDetails ?? null,
      instructions: opts.params.instructions ?? null,
      max_output_tokens: opts.params.max_output_tokens ?? null,
      max_tool_calls: p.max_tool_calls ?? null,
      metadata: opts.params.metadata ?? {},
      model: opts.params.model,
      object: 'response',
      output: opts.output,
      output_text: opts.outputText,
      parallel_tool_calls: opts.params.parallel_tool_calls ?? true,
      presence_penalty: p.presence_penalty ?? 0,
      previous_response_id: opts.params.previous_response_id ?? null,
      prompt_cache_key: p.prompt_cache_key ?? null,
      reasoning: opts.params.reasoning ?? null,
      safety_identifier: p.safety_identifier ?? null,
      service_tier: p.service_tier ?? 'default',
      status: opts.status,
      store: p.store ?? true,
      temperature: opts.params.temperature ?? 1,
      text: { format: { type: 'text' } },
      tool_choice: opts.params.tool_choice ?? 'auto',
      tools: opts.params.tools?.map((t: any) => ({ ...t, strict: t.strict ?? null })) ?? [],
      top_logprobs: p.top_logprobs ?? 0,
      top_p: opts.params.top_p ?? 1,
      truncation:
        opts.params.truncation && typeof opts.params.truncation === 'object'
          ? opts.params.truncation.type
          : (opts.params.truncation ?? 'disabled'),
      usage: {
        input_tokens: opts.usage?.input_tokens ?? 0,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: opts.usage?.output_tokens ?? 0,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: opts.usage?.total_tokens ?? 0,
      },
      user: opts.params.user ?? null,
    } as any;
  }
}
