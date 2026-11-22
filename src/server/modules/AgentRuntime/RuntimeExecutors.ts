import {
  type AgentEvent,
  type AgentInstruction,
  type AgentInstructionCompressContext,
  type AgentState,
  calculatePromptTokens,
  type CallLLMPayload,
  estimateTokens,
  findActiveTurnStartIndex,
  type GeneralAgentCallLLMResultPayload,
  type GeneralAgentCompressionResultPayload,
  hasRepeatedToolCall,
  type InstructionExecutor,
  isEmptyAssistantPlaceholder,
  resolveAssistantParentId,
  TOOL_CALL_REPEAT_STOP_MESSAGE,
  updateToolCallRepeatGuard,
  UsageCounter,
} from '@lobechat/agent-runtime';
import { LobeActivatorIdentifier } from '@lobechat/builtin-tool-activator';
import { ArckepLayoutIdentifier } from '@lobechat/builtin-tool-arckep-layout';
import { LocalSystemManifest } from '@lobechat/builtin-tool-local-system';
import { SkillsIdentifier } from '@lobechat/builtin-tool-skills';
import { TEXT_FILE_TOOL } from '@lobechat/builtin-tools';
import {
  AGENT_DOCUMENT_INJECTION_POSITIONS,
  type AgentContextDocument,
  buildStepSkillDelta,
  buildStepToolDelta,
  extractToolResultImages,
  hydrateGroupMessages,
  type LobeToolManifest,
  type OperationToolSet,
  type ResolvedToolSet,
  resolveTopicReferences,
  rewriteSavedCodeArtifactTagsForLLM,
  rewriteStoredMessageContentForLLM,
  SkillResolver,
  ToolNameResolver,
  ToolResolver,
} from '@lobechat/context-engine';
import { parse } from '@lobechat/conversation-flow';
import { type ChatStreamPayload, consumeStreamUntilDone } from '@lobechat/model-runtime';
import {
  chainCompressContext,
  chatHistoryPrompts,
  compressContextSystemPrompt,
  compressContextUserPrompt,
  fileReferences,
} from '@lobechat/prompts';
import { type ChatToolPayload, type MessageToolCall, type UIChatMessage } from '@lobechat/types';
import { serializePartsForStorage } from '@lobechat/utils';
import debug from 'debug';

import { type MessageModel, MessageModel as MessageModelClass } from '@/database/models/message';
import { TopicModel } from '@/database/models/topic';
import { type LobeChatDatabase } from '@/database/type';
import { fileEnv } from '@/envs/file';
import { serverMessagesEngine } from '@/server/modules/Mecha/ContextEngineering';
import { createToolImageUrlResolver } from '@/server/modules/Mecha/ContextEngineering/toolResultImageUrl';
import { type EvalContext } from '@/server/modules/Mecha/ContextEngineering/types';
import { initModelRuntimeFromDB } from '@/server/modules/ModelRuntime';
import { AgentDocumentsService } from '@/server/services/agentDocuments';
import { throwIfAborted, waitForRetry } from '@/server/services/agentRuntime/abort';
import { saveLongCodeArtifacts } from '@/server/services/aiAgent/codeArtifacts';
import { HtmlArtifactStreamGate } from '@/server/services/arckepLayout/htmlSyntax';
import { FileService } from '@/server/services/file';
import { MessageService } from '@/server/services/message';
import { compactWriterContext } from '@/server/services/textFiles/context';
import {
  type ToolExecutionResultResponse,
  type ToolExecutionService,
} from '@/server/services/toolExecution';
import { shouldAutoAttachSpreadsheet } from '@/utils/spreadsheet';
import { nanoid } from '@/utils/uuid';

import { resolveServerEnabledSearch } from './arckepSearch';
import {
  DATA_GUARD_COMPRESSION_MODEL,
  isDeepSeekDataGuardProtected,
} from './compressionThresholds';
import { assertDeepSeekDocumentsGuardCompatible } from './deepseekDocumentGuard';
import { classifyLLMError, type LLMErrorKind } from './llmErrorClassification';
import { createEngineTraceCallbacks, withEngineTrace } from './llmTrace';
import { formatPersistedLLMError, rememberPersistedLLMError } from './persistedLLMError';
import { persistFailedLLM } from './persistFailedLLM';
import { persistInterruptedLLM } from './persistInterruptedLLM';
import { fitRejectedPrompt } from './rejectedPrompt';
import { resolveServerModelParams } from './serverModelParams';
import { type IStreamEventManager } from './types';

const log = debug('lobe-server:agent-runtime:streaming-executors');
const timing = debug('lobe-server:agent-runtime:timing');

const VALID_DOCUMENT_POSITIONS = new Set<AgentContextDocument['loadPosition']>(
  AGENT_DOCUMENT_INJECTION_POSITIONS,
);

const normalizeDocumentPosition = (
  position: string | null | undefined,
): AgentContextDocument['loadPosition'] | undefined => {
  if (!position) return undefined;
  return VALID_DOCUMENT_POSITIONS.has(position as AgentContextDocument['loadPosition'])
    ? (position as AgentContextDocument['loadPosition'])
    : undefined;
};

const DEEPSEEK_SUMMARIZER_USER_TURN_BUDGET_TOKENS = 20_000;
const DEEPSEEK_CHUNK_ACK = 'Фрагмент истории принят.';
const SUMMARIZER_TOOL_BODY_MAX_CHARS = 8_000;
const SUMMARIZER_TOOL_HEAD_CHARS = 5_500;
const SUMMARIZER_TOOL_TAIL_CHARS = 2_000;
const VIRTUAL_GROUP_ROLES = new Set([
  'agentCouncil',
  'assistantGroup',
  'compare',
  'groupTasks',
  'supervisor',
  'tasks',
]);

const truncateForSummarizer = (text: string, label: string): string => {
  if (text.length <= SUMMARIZER_TOOL_BODY_MAX_CHARS) return text;
  const omittedChars = text.length - SUMMARIZER_TOOL_HEAD_CHARS - SUMMARIZER_TOOL_TAIL_CHARS;
  return (
    text.slice(0, SUMMARIZER_TOOL_HEAD_CHARS) +
    `\n\n[... ${omittedChars} chars of ${label} omitted during summarization; full original is preserved in getTopicContext(mode="archive") ...]\n\n` +
    text.slice(-SUMMARIZER_TOOL_TAIL_CHARS)
  );
};

export const prepareMessageForSummarizer = (message: UIChatMessage): UIChatMessage => {
  let nextContent = message.content;
  let contentChanged = false;
  if (
    message.role === 'tool' &&
    typeof message.content === 'string' &&
    message.content.length > SUMMARIZER_TOOL_BODY_MAX_CHARS
  ) {
    nextContent = truncateForSummarizer(message.content, 'tool result');
    contentChanged = true;
  } else if (
    (message.role === 'assistant' || message.role === 'assistantGroup') &&
    typeof message.content === 'string'
  ) {
    const rewritten = rewriteStoredMessageContentForLLM(message.content) as string;
    if (rewritten !== message.content) {
      nextContent = rewritten;
      contentChanged = true;
    }
  }

  let nextChildren = (message as any).children;
  let childrenChanged = false;
  if (message.role === 'assistantGroup' && Array.isArray(nextChildren)) {
    const mappedChildren = nextChildren.map((child: any) => {
      if (child && typeof child.content === 'string') {
        const rewritten = rewriteStoredMessageContentForLLM(child.content) as string;
        if (rewritten !== child.content) {
          childrenChanged = true;
          return { ...child, content: rewritten };
        }
      }
      return child;
    });
    if (childrenChanged) {
      nextChildren = mappedChildren;
    }
  }

  let nextTools = message.tools;
  let toolsChanged = false;
  if (
    Array.isArray(message.tools) &&
    message.tools.some(
      (tool) =>
        typeof tool?.arguments === 'string' &&
        tool.arguments.length > SUMMARIZER_TOOL_BODY_MAX_CHARS,
    )
  ) {
    nextTools = message.tools.map((tool) =>
      typeof tool?.arguments === 'string' && tool.arguments.length > SUMMARIZER_TOOL_BODY_MAX_CHARS
        ? { ...tool, arguments: truncateForSummarizer(tool.arguments, 'tool arguments') }
        : tool,
    );
    toolsChanged = true;
  }

  if (!contentChanged && !toolsChanged && !childrenChanged) return message;
  return {
    ...message,
    ...(contentChanged ? { content: nextContent } : {}),
    ...(childrenChanged ? { children: nextChildren } : {}),
    ...(toolsChanged ? { tools: nextTools } : {}),
  };
};

/**
 * Conservative per-user-turn token estimator for DeepSeek's 32,768 single-user-turn limit.
 * `tokenx` has no Cyrillic language rule (~4.0-4.6 chars/token on Russian prose vs real DeepSeek
 * BPE ~2.0-2.5 chars/token). Taking the max with `ceil(utf8Bytes / 3)` caps Russian (2 UTF-8
 * bytes/char) at <= ~30K chars (<= 60K bytes, ~12K-15K real tokens) within a 20K budget.
 */
export const estimateDeepSeekUserTurnTokens = (text: string): number => {
  if (!text) return 0;
  return Math.max(estimateTokens(text), Math.ceil(Buffer.byteLength(text, 'utf8') / 3));
};

const extractTextForDeepSeekTurn = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part: unknown) => {
        if (!part || typeof part !== 'object') return '';
        if ('text' in part && typeof (part as { text?: unknown }).text === 'string') {
          return (part as { text: string }).text;
        }
        if ('thinking' in part && typeof (part as { thinking?: unknown }).thinking === 'string') {
          return (part as { thinking: string }).thinking;
        }
        return '';
      })
      .join('\n');
  }
  return content ? JSON.stringify(content) : '';
};

const estimateDeepSeekPromptUserTurnTokens = (message: {
  content?: unknown;
  role?: string;
}): number => {
  const text = extractTextForDeepSeekTurn(message.content);
  return Math.max(
    calculatePromptTokens([message as any]),
    estimateDeepSeekUserTurnTokens(text) + 4,
  );
};

const hasOversizedDeepSeekUserTurn = (
  promptMessages: ChatStreamPayload['messages'],
  budgetTokens: number,
): boolean => {
  let consecutiveUserCount = 0;
  let consecutiveUserRunTokens = 0;

  for (const msg of promptMessages) {
    if (msg.role === 'user') {
      consecutiveUserCount += 1;
      consecutiveUserRunTokens += estimateDeepSeekPromptUserTurnTokens(msg);
      if (consecutiveUserCount > 1 || consecutiveUserRunTokens > budgetTokens) {
        return true;
      }
    } else {
      consecutiveUserCount = 0;
      consecutiveUserRunTokens = 0;
    }
  }

  return false;
};

const isSurrogatePairAt = (text: string, index: number): boolean => {
  if (index < 0 || index + 1 >= text.length) return false;
  const high = text.charCodeAt(index);
  const low = text.charCodeAt(index + 1);
  return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
};

const adjustSliceEndForSurrogatePair = (text: string, start: number, end: number): number => {
  if (end <= start + 1 || end >= text.length) return end;
  const lastCodeUnit = text.charCodeAt(end - 1);
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) {
    return end - 1;
  }
  return end;
};

export const splitTextToTokenBudget = (text: string, maxTokens: number): string[] => {
  if (!text) return [];
  const budget = Math.max(1, Math.floor(maxTokens));
  if (estimateDeepSeekUserTurnTokens(text) <= budget) return [text];

  const slices: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    const remainingText = text.slice(offset);
    if (estimateDeepSeekUserTurnTokens(remainingText) <= budget) {
      slices.push(remainingText);
      break;
    }

    const minEnd = isSurrogatePairAt(text, offset) ? offset + 2 : offset + 1;
    // Every UTF-16 code unit encodes to at least 1 UTF-8 byte, so `budget * 3` code units
    // is a strict upper bound for `ceil(utf8Bytes / 3) <= budget`.
    let low = minEnd;
    let high = Math.min(text.length, Math.max(minEnd, offset + budget * 3));
    let best = minEnd;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (estimateDeepSeekUserTurnTokens(text.slice(offset, mid)) <= budget) {
        best = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    let end = adjustSliceEndForSurrogatePair(text, offset, best);
    if (end < minEnd) end = minEnd;
    while (end > minEnd && estimateDeepSeekUserTurnTokens(text.slice(offset, end)) > budget) {
      end = Math.max(minEnd, adjustSliceEndForSurrogatePair(text, offset, end - 1));
    }

    slices.push(text.slice(offset, end));
    offset = end;
  }
  return slices;
};

/**
 * DeepSeek accepts up to 1M total context in one call, but rejects any single or consecutive
 * `role: 'user'` turn above 32,768 tokens. When the formatted compression prompt exceeds our
 * safe per-user-turn budget (~20K tokens), split `<existing_summary>` and `<chat_history>`
 * into alternating `user` chunks separated by a short `assistant` acknowledgment, ending with
 * a short final `user` instruction so the entire compression still runs in ONE LLM call.
 */
const buildDeepSeekAlternatingCompressionMessages = (params: {
  existingSummary?: string;
  messages: UIChatMessage[];
  priorCompressedGroups: UIChatMessage[];
}): ChatStreamPayload['messages'] => {
  const { existingSummary, messages, priorCompressedGroups } = params;
  const result: ChatStreamPayload['messages'] = [
    { content: compressContextSystemPrompt, role: 'system' },
  ];

  const pushAlternatingUserSegment = (content: string) => {
    result.push({ content, role: 'user' }, { content: DEEPSEEK_CHUNK_ACK, role: 'assistant' });
  };

  const trimmedSummary = existingSummary?.trim();
  if (trimmedSummary) {
    const summarySlices = splitTextToTokenBudget(
      trimmedSummary,
      DEEPSEEK_SUMMARIZER_USER_TURN_BUDGET_TOKENS - 256,
    );
    for (let i = 0; i < summarySlices.length; i++) {
      const tag =
        summarySlices.length === 1
          ? '<existing_summary>'
          : `<existing_summary part="${i + 1}/${summarySlices.length}">`;
      pushAlternatingUserSegment(`${tag}\n${summarySlices[i]}\n</existing_summary>`);
    }
  }

  const maxSingleMessageTokens = DEEPSEEK_SUMMARIZER_USER_TURN_BUDGET_TOKENS - 512;
  const expandedMessages: UIChatMessage[] = [];
  for (const msg of messages) {
    const rawBody =
      `${typeof msg.content === 'string' ? msg.content : ''}` +
      (msg.tools?.length ? `\nTool calls: ${JSON.stringify(msg.tools)}` : '');
    const headerPrefix = `[source_message_id: ${msg.id}]\n`;
    if (estimateDeepSeekUserTurnTokens(headerPrefix + rawBody) <= maxSingleMessageTokens) {
      expandedMessages.push({ ...msg, content: headerPrefix + rawBody, tools: undefined });
    } else {
      const parts = splitTextToTokenBudget(rawBody, maxSingleMessageTokens - 64);
      for (let partIdx = 0; partIdx < parts.length; partIdx++) {
        expandedMessages.push({
          ...msg,
          content: `[source_message_id: ${msg.id} part ${partIdx + 1}/${parts.length}]\n${parts[partIdx]}`,
          tools: undefined,
        });
      }
    }
  }

  let chunk: UIChatMessage[] = [];
  let chunkApproxTokens = 0;
  const flushChunk = () => {
    if (chunk.length === 0) return;
    pushAlternatingUserSegment(chatHistoryPrompts(chunk));
    chunk = [];
    chunkApproxTokens = 0;
  };

  for (const msg of expandedMessages) {
    const msgTokens = estimateDeepSeekUserTurnTokens(msg.content) + 32;
    if (
      chunk.length > 0 &&
      chunkApproxTokens + msgTokens > DEEPSEEK_SUMMARIZER_USER_TURN_BUDGET_TOKENS - 256
    ) {
      flushChunk();
    }
    chunk.push(msg);
    chunkApproxTokens += msgTokens;
    if (
      chunk.length > 1 &&
      estimateDeepSeekPromptUserTurnTokens({ content: chatHistoryPrompts(chunk), role: 'user' }) >
        DEEPSEEK_SUMMARIZER_USER_TURN_BUDGET_TOKENS
    ) {
      const overflow = chunk.pop()!;
      flushChunk();
      chunk.push(overflow);
      chunkApproxTokens = msgTokens;
    }
  }
  flushChunk();

  const fileReferenceSources =
    priorCompressedGroups.length > 0 ? [...priorCompressedGroups, ...messages] : messages;
  const fileRefsText = fileReferences(fileReferenceSources).trim();
  const finalInstructionContent = fileRefsText
    ? `${fileRefsText}\n\n${compressContextUserPrompt}`
    : compressContextUserPrompt;

  if (
    estimateDeepSeekPromptUserTurnTokens({ content: finalInstructionContent, role: 'user' }) <=
    DEEPSEEK_SUMMARIZER_USER_TURN_BUDGET_TOKENS
  ) {
    result.push({ content: finalInstructionContent, role: 'user' });
  } else {
    const refSlices = splitTextToTokenBudget(
      fileRefsText,
      DEEPSEEK_SUMMARIZER_USER_TURN_BUDGET_TOKENS - 256,
    );
    for (const slice of refSlices) {
      pushAlternatingUserSegment(slice);
    }
    result.push({ content: compressContextUserPrompt, role: 'user' });
  }

  return result;
};

// Tool pricing configuration (USD per call)
const TOOL_PRICING: Record<string, number> = {
  'lobe-web-browsing/craw': 0,
  'lobe-web-browsing/search': 0,
};

const TOOL_MAX_RETRIES = 2;
const DOCUMENTS_TOOL_IDENTIFIER = 'lobe-documents';
export const UNRESOLVED_TOOL_FEEDBACK_LIMIT = 2;
const UNRESOLVED_TOOL_IDENTIFIER = '__arckep_unresolved_tool__';
const UNRESOLVED_TOOL_STOP_MESSAGE =
  'Не удалось выполнить запрос: модель повторно обратилась к недоступному инструменту. Попробуйте переформулировать задачу или включить нужный инструмент.';

type UnresolvedToolCallItem = ReturnType<
  ToolNameResolver['resolveWithDiagnostics']
>['unresolved'][number];

const stripSyntheticManifest = (
  map: Record<string, LobeToolManifest> | undefined,
): Record<string, LobeToolManifest> =>
  Object.fromEntries(
    Object.entries(map ?? {}).filter(([key]) => key !== UNRESOLVED_TOOL_IDENTIFIER),
  );

const diagnosticToolCall = (call: ChatToolPayload) =>
  call.identifier === 'arckep-text-file'
    ? { identifier: call.identifier, apiName: call.apiName, id: call.id }
    : call;

const getDocumentFileId = (result: ToolExecutionResultResponse) => {
  const state = result.state;
  if (!state || typeof state !== 'object') return;

  const record = state as Record<string, unknown>;
  if (record.toolIdentifier !== DOCUMENTS_TOOL_IDENTIFIER) return;

  return typeof record.fileId === 'string' ? record.fileId : undefined;
};

const LLM_MAX_RETRIES = 5;
const LLM_RETRY_BASE_DELAY_MS = 1000;
const LLM_RETRY_MAX_DELAY_MS = 30_000;
/**
 * Hard wall-clock ceiling for automatic same-turn LLM replay: if an attempt already
 * ran for >= 60s before failing (e.g. long thinking timeout, client/socket abort, or
 * mid-stream reset without retrySafe metadata), never restart another multi-minute run.
 */
export const LONG_LLM_ATTEMPT_NO_RETRY_MS = 60_000;

type ToolFailureKind = 'replan' | 'retry' | 'stop';

const getToolFailureKind = (result: ToolExecutionResultResponse): ToolFailureKind | undefined => {
  if (!result.error || typeof result.error !== 'object') return;

  const { kind } = result.error as { kind?: unknown };
  return kind === 'replan' || kind === 'retry' || kind === 'stop' ? kind : undefined;
};

const shouldRetryTool = (kind: ToolFailureKind | undefined, attempt: number, maxRetries: number) =>
  kind === 'retry' && attempt <= maxRetries;

const shouldRetryLLM = (kind: LLMErrorKind, attempt: number, maxRetries: number) =>
  kind === 'retry' && attempt <= maxRetries;

const getLLMRetryDelayMs = (attempt: number) =>
  Math.min(LLM_RETRY_BASE_DELAY_MS * 2 ** Math.max(attempt - 1, 0), LLM_RETRY_MAX_DELAY_MS);

const isOperationInterrupted = async (ctx: RuntimeExecutorContext) => {
  if (ctx.signal?.aborted) return true;
  if (!ctx.loadAgentState) return false;

  try {
    const latestState = await ctx.loadAgentState(ctx.operationId);
    return latestState?.status === 'interrupted';
  } catch (error) {
    console.error('[RuntimeExecutors] Failed to load operation state for retry guard:', error);
    return false;
  }
};

// Встроенный поиск моделей и «Поиск Arckep» — в ./arckepSearch (здесь остаётся реэкспорт для тестов и вызовов).
export { resolveServerEnabledSearch };

const executeToolWithRetry = async (
  execute: () => Promise<ToolExecutionResultResponse>,
  params: {
    isInterrupted?: () => Promise<boolean>;
    maxRetries: number;
    operationLogId: string;
    toolName: string;
  },
): Promise<{ attempts: number; result: ToolExecutionResultResponse }> => {
  const maxAttempts = params.maxRetries + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await execute();

    if (result.success) return { attempts: attempt, result };

    const kind = getToolFailureKind(result);

    if (shouldRetryTool(kind, attempt, params.maxRetries)) {
      if (await params.isInterrupted?.()) {
        return { attempts: attempt, result };
      }

      log(
        '[%s] Tool %s failed with kind=%s (attempt %d/%d), retrying ...',
        params.operationLogId,
        params.toolName,
        kind,
        attempt,
        maxAttempts,
      );
      continue;
    }

    return { attempts: attempt, result };
  }

  throw new Error('Tool execution retry loop exited unexpectedly');
};

/**
 * arckep (19.10.2026): манифест есть в карте операции, но в <available_tools> не показывается — модель
 * получает эти инструменты от `activateSkill`, а не выбирает сама. Сейчас так скрыты инструменты навыков
 * и проверка/запись HTML-артефактов (`arckep-layout`).
 */
const HIDDEN_FROM_DISCOVERY = new Set<string>([ArckepLayoutIdentifier, SkillsIdentifier]);

export const buildToolDiscoveryConfig = (
  operationToolSet: OperationToolSet,
  enabledToolIds: string[],
) => {
  const enabledToolSet = new Set(enabledToolIds);
  const disabledToolSet = new Set(operationToolSet.disabledToolIds ?? []);

  if (!enabledToolSet.has(LobeActivatorIdentifier)) return undefined;

  const availableTools = Object.entries(operationToolSet.manifestMap)
    .filter(
      ([identifier]) =>
        !enabledToolSet.has(identifier) &&
        !disabledToolSet.has(identifier) &&
        !HIDDEN_FROM_DISCOVERY.has(identifier),
    )
    .map(([identifier, manifest]) => ({
      description: manifest.meta?.description || '',
      identifier,
      name: manifest.meta?.title || identifier,
    }));

  if (availableTools.length === 0) return undefined;

  return { availableTools };
};

const buildUnresolvedToolErrorMessage = (
  unresolvedCall: UnresolvedToolCallItem,
  toolDiscoveryConfig: ReturnType<typeof buildToolDiscoveryConfig>,
  operationManifestMap: Record<string, LobeToolManifest>,
): string => {
  const { rawName, reason } = unresolvedCall;
  const availableTools = toolDiscoveryConfig?.availableTools ?? [];
  const availableIds = new Set(availableTools.map((t) => t.identifier));
  const prefixCandidates = [
    rawName,
    rawName.split('____')[0],
    rawName.split('__')[0],
    rawName.split('/')[0],
    rawName.split('.')[0],
  ].filter(Boolean);
  const isDiscoverable =
    reason !== 'disabled' &&
    (prefixCandidates.some((candidate) => availableIds.has(candidate)) ||
      availableTools.some((t) =>
        operationManifestMap[t.identifier]?.api?.some((api) => api.name === rawName),
      ));

  if (isDiscoverable) {
    return `Tool "${rawName}" is not active in this step. Call lobe-activator____activateTools first to activate it, or choose from currently enabled tools.`;
  }
  if (reason === 'disabled') {
    return `Tool "${rawName}" is disabled in this conversation and cannot be used.`;
  }
  return `Tool "${rawName}" is not available in this step. Check active tool names (format: identifier____apiName) and try again.`;
};

// A model can repeat a function name from conversation history even when its schema is absent.
const canWriteTextFile = (state: AgentState) =>
  state.metadata?.studioTextFileEnabled === true &&
  (state.operationToolSet?.enabledToolIds.includes(TEXT_FILE_TOOL) === true ||
    state.activatedStepTools?.some((tool) => tool.id === TEXT_FILE_TOOL) === true);

const formatErrorEventData = (error: unknown, phase: string) => {
  let errorMessage = 'Unknown error';
  let errorType: string | undefined;

  if (error && typeof error === 'object') {
    const payload = error as { error?: unknown; errorType?: unknown; message?: unknown };

    if (typeof payload.errorType === 'string') {
      errorType = payload.errorType;
    }

    if (typeof payload.message === 'string' && payload.message.length > 0) {
      errorMessage = payload.message;
    } else if (typeof payload.error === 'string' && payload.error.length > 0) {
      errorMessage = payload.error;
    } else if (
      payload.error &&
      typeof payload.error === 'object' &&
      'message' in payload.error &&
      typeof payload.error.message === 'string'
    ) {
      errorMessage = payload.error.message;
    } else if (error instanceof Error && error.message.length > 0) {
      errorMessage = error.message;
    } else if (errorType) {
      errorMessage = errorType;
    }
  } else if (error instanceof Error && error.message.length > 0) {
    errorMessage = error.message;
    errorType = error.name;
  } else if (typeof error === 'string' && error.length > 0) {
    errorMessage = error;
  }

  if (!errorType && error instanceof Error && error.name) {
    errorType = error.name;
  }

  return {
    error: errorMessage,
    errorType,
    phase,
  };
};

export interface RuntimeExecutorContext {
  agentConfig?: any;
  botPlatformContext?: any;
  discordContext?: any;
  evalContext?: EvalContext;
  fileService?: any;
  loadAgentState?: (operationId: string) => Promise<AgentState | null>;
  messageModel: MessageModel;
  operationId: string;
  serverDB: LobeChatDatabase;
  signal?: AbortSignal;
  stepIndex: number;
  stream?: boolean;
  streamManager: IStreamEventManager;
  toolExecutionService: ToolExecutionService;
  topicId?: string;
  userId?: string;
  userTimezone?: string;
}

export const createRuntimeExecutors = (
  ctx: RuntimeExecutorContext,
): Partial<Record<AgentInstruction['type'], InstructionExecutor>> => ({
  /**
   * Create streaming LLM executor
   * Integrates Agent Runtime and stream event publishing
   */
  call_llm: async (instruction, state) => {
    const { payload } = instruction as Extract<AgentInstruction, { type: 'call_llm' }>;
    const llmPayload = payload as CallLLMPayload;
    const { operationId, stepIndex, streamManager } = ctx;
    const events: AgentEvent[] = [];

    // Fallback to state's modelRuntimeConfig if not in payload
    const model = llmPayload.model || state.modelRuntimeConfig?.model;
    const provider = llmPayload.provider || state.modelRuntimeConfig?.provider;
    // Resolve tools via ToolResolver (unified tool injection)
    const activeDeviceId = state.metadata?.activeDeviceId;
    const operationToolSet: OperationToolSet = state.operationToolSet
      ? {
          ...state.operationToolSet,
          manifestMap: stripSyntheticManifest(state.operationToolSet.manifestMap),
        }
      : {
          enabledToolIds: [],
          manifestMap: stripSyntheticManifest(state.toolManifestMap),
          sourceMap: state.toolSourceMap ?? {},
          tools: state.tools ?? [],
        };

    const stepDelta = buildStepToolDelta({
      activeDeviceId,
      enabledToolIds: operationToolSet.enabledToolIds,
      forceFinish: state.forceFinish,
      localSystemManifest: LocalSystemManifest as unknown as LobeToolManifest,
      operationManifestMap: operationToolSet.manifestMap,
    });

    const toolResolver = new ToolResolver();
    const resolved: ResolvedToolSet = toolResolver.resolve(
      operationToolSet,
      stepDelta,
      state.activatedStepTools ?? [],
    );

    const tools = resolved.tools.length > 0 ? resolved.tools : undefined;
    const toolDiscoveryConfig = buildToolDiscoveryConfig(operationToolSet, resolved.enabledToolIds);

    if (stepDelta.activatedTools.length > 0) {
      log(
        `[${operationId}:${stepIndex}] ToolResolver injected %d step-level tools: %o`,
        stepDelta.activatedTools.length,
        stepDelta.activatedTools.map((t) => t.id),
      );
    }

    // Resolve skills via SkillResolver (unified skill injection)
    // arckep (21.10.2026): навыки, подключённые шагом activateSkill, уже возвращены модели
    // в сообщении роли tool — не дублируем их второй раз в верхний системный промпт и не
    // перестраиваем <available_skills>, чтобы не сбивать префиксный кэш провайдера.
    const skillResolver = new SkillResolver();
    const stepSkillDelta = buildStepSkillDelta();
    const resolvedSkills = state.metadata?.operationSkillSet
      ? skillResolver.resolve(state.metadata.operationSkillSet, stepSkillDelta, [])
      : undefined;

    if (!model || !provider) {
      throw new Error('Model and provider are required for call_llm instruction');
    }

    assertDeepSeekDocumentsGuardCompatible(
      !!(ctx.agentConfig?.chatConfig as any)?.deepseekDataGuardProtected,
      llmPayload.messages as any[],
    );

    // Type assertion to ensure payload correctness
    const operationLogId = `${operationId}:${stepIndex}`;

    const stagePrefix = `[${operationLogId}][call_llm]`;

    log(`${stagePrefix} Starting operation`);

    // Get parentId from payload (parentId or parentMessageId depending on payload type)
    let parentId = llmPayload.parentId || (llmPayload as any).parentMessageId;
    if (ctx.messageModel && state.metadata?.topicId) {
      const dbMessages = await ctx.messageModel.query({
        agentId: state.metadata?.agentId,
        threadId: state.metadata?.threadId,
        topicId: state.metadata.topicId,
      });
      parentId = resolveAssistantParentId(dbMessages, parentId);
    } else {
      parentId = resolveAssistantParentId(state.messages || [], parentId);
    }

    // Get or create assistant message
    // If assistantMessageId is provided in payload (or reused after a pure synthetic unresolved-tool step),
    // use existing message instead of creating an orphan empty assistant row in DB.
    const existingAssistantMessageId =
      (llmPayload as any).assistantMessageId ||
      (state.metadata?.reuseAssistantMessageId as string | undefined);
    let assistantMessageItem: { id: string };

    if (existingAssistantMessageId) {
      // Use existing assistant message (created by execAgent)
      assistantMessageItem = { id: existingAssistantMessageId };
      log(`${stagePrefix} Using existing assistant message: %s`, existingAssistantMessageId);
    } else {
      // Create new assistant message (legacy behavior)
      assistantMessageItem = await ctx.messageModel.create({
        agentId: state.metadata!.agentId!,
        content: '',
        model,
        parentId,
        provider,
        role: 'assistant',
        threadId: state.metadata?.threadId,
        topicId: state.metadata?.topicId,
      });
      log(`${stagePrefix} Created new assistant message: %s`, assistantMessageItem.id);
    }

    // Publish stream start event
    await streamManager.publishStreamEvent(operationId, {
      data: { assistantMessage: assistantMessageItem, model, provider },
      stepIndex,
      type: 'stream_start',
    });

    try {
      type ContentPart = { text: string; type: 'text' } | { image: string; type: 'image' };

      // Process messages through serverMessagesEngine to inject system role, knowledge, etc.
      // Rebuild params from agentConfig at execution time (capabilities built dynamically)
      const agentConfig = ctx.agentConfig;
      let processedMessages;
      let wireSourceIds: (string | undefined)[] = [];
      if (agentConfig) {
        const { LOBE_DEFAULT_MODEL_LIST } = await import('model-bank');

        // Extract <refer_topic> tags from messages and fetch summaries.
        // Skip if messages already contain injected topic_reference_context
        // (e.g., from client-side contextEngineering preprocessing) to avoid double injection.
        let topicReferences;
        const alreadyHasTopicRefs = (
          llmPayload.messages as Array<{ content: string | unknown }>
        ).some(
          (m) => typeof m.content === 'string' && m.content.includes('topic_reference_context'),
        );

        if (!alreadyHasTopicRefs && ctx.serverDB && ctx.userId) {
          const topicModel = new TopicModel(ctx.serverDB, ctx.userId);
          const messageModel = new MessageModelClass(ctx.serverDB, ctx.userId);
          topicReferences = await resolveTopicReferences(
            llmPayload.messages as Array<{ content: string | unknown }>,
            async (topicId) => topicModel.findById(topicId),
            async (topicId) => {
              const topic = await topicModel.findById(topicId);
              return messageModel.query({
                agentId: topic?.agentId ?? undefined,
                groupId: topic?.groupId ?? undefined,
                topicId,
              });
            },
          );
        }

        // Fetch agent documents for context injection
        let agentDocuments: AgentContextDocument[] | undefined;
        const agentId = state.metadata?.agentId;
        if (agentId && ctx.serverDB && ctx.userId) {
          try {
            const agentDocService = new AgentDocumentsService(ctx.serverDB, ctx.userId);
            const docs = await agentDocService.getAgentDocuments(agentId);
            if (docs.length > 0) {
              agentDocuments = docs.map((doc) => ({
                content: doc.content,
                description: doc.description ?? undefined,
                filename: doc.filename,
                id: doc.id,
                loadPosition: normalizeDocumentPosition(
                  doc.policy?.context?.position || doc.policyLoadPosition,
                ),
                loadRules: doc.loadRules,
                policyId: doc.templateId,
                policyLoad: doc.policyLoad as 'always' | 'progressive',
                policyLoadFormat: doc.policy?.context?.policyLoadFormat || doc.policyLoadFormat,
                title: doc.title,
              }));
              log('Resolved %d agent documents for agent %s', agentDocuments.length, agentId);
            }
          } catch (error) {
            log('Failed to resolve agent documents for agent %s: %O', agentId, error);
          }
        }

        const hasHistoricalSyntheticUnresolved =
          state.metadata?.deliverUnresolvedToolFeedback !== true &&
          (llmPayload.messages as any[]).some((m) =>
            JSON.stringify(
              m?.tools ?? m?.tool_calls ?? (Array.isArray(m?.children) ? m.children : ''),
            ).includes(UNRESOLVED_TOOL_IDENTIFIER),
          );
        const baseDisabledIds =
          operationToolSet.disabledToolIds !== undefined
            ? operationToolSet.disabledToolIds.filter((id) => !resolved.enabledToolIds.includes(id))
            : undefined;
        const disabledToolIdentifiers = hasHistoricalSyntheticUnresolved
          ? [...new Set([...(baseDisabledIds ?? []), UNRESOLVED_TOOL_IDENTIFIER])]
          : baseDisabledIds;

        const contextEngineInput = {
          agentDocuments,
          additionalVariables: state.metadata?.deviceSystemInfo,
          userTimezone: ctx.userTimezone,
          capabilities: {
            isCanUseFC: (m: string, p: string) => {
              const info = LOBE_DEFAULT_MODEL_LIST.find(
                (item) => item.id === m && item.providerId === p,
              );
              return info?.abilities?.functionCall ?? true;
            },
            isCanUseVideo: (m: string, p: string) => {
              const info = LOBE_DEFAULT_MODEL_LIST.find(
                (item) => item.id === m && item.providerId === p,
              );
              return info?.abilities?.video ?? false;
            },
            isCanUseVision: (m: string, p: string) => {
              const info = LOBE_DEFAULT_MODEL_LIST.find(
                (item) => item.id === m && item.providerId === p,
              );
              return info?.abilities?.vision ?? true;
            },
          },
          botPlatformContext: ctx.botPlatformContext,
          discordContext: ctx.discordContext,
          enableHistoryCount: agentConfig.chatConfig?.enableHistoryCount ?? undefined,
          evalContext: ctx.evalContext,
          forceFinish: state.forceFinish,
          historyCount: agentConfig.chatConfig?.historyCount ?? undefined,
          knowledge: {
            fileContents: agentConfig.files
              ?.filter((f: { enabled?: boolean | null }) => f.enabled === true)
              .map((f: { content?: string | null; id?: string; name?: string }) => ({
                content: f.content ?? '',
                fileId: f.id ?? '',
                filename: f.name ?? '',
              })),
            knowledgeBases: agentConfig.knowledgeBases
              ?.filter((kb: { enabled?: boolean | null }) => kb.enabled === true)
              .map((kb: { id?: string; name?: string }) => ({
                id: kb.id ?? '',
                name: kb.name ?? '',
              })),
          },
          messages: llmPayload.messages as UIChatMessage[],
          model,
          provider,
          systemRole: agentConfig.systemRole ?? undefined,
          toolDiscoveryConfig,
          toolsConfig: {
            ...(disabledToolIdentifiers !== undefined && { disabledToolIdentifiers }),
            manifests: Object.values(resolved.manifestMap),
            tools: resolved.enabledToolIds,
          },
          // arckep (19.10.2026): картинки из результатов инструментов текущего хода (Figma get_screenshot и т. п.)
          // — моделям со зрением, отдельным user-сообщением после группы tool-сообщений; адрес — подписанная
          // ссылка хранилища. Без пользователя или базы картинки не передаются (в тексте остаётся ссылка).
          ...(ctx.serverDB && ctx.userId
            ? {
                toolResultImages: {
                  resolveImageUrl: createToolImageUrlResolver(ctx.serverDB, ctx.userId),
                },
              }
            : {}),
          ...(state.metadata?.topicCacheWarm !== undefined ||
          state.metadata?.topicCacheTtlMs !== undefined
            ? {
                toolResultTrim: {
                  cacheTtlMs: state.metadata?.topicCacheTtlMs,
                  cacheWarm: state.metadata?.topicCacheWarm,
                },
              }
            : {}),
          userMemory: state.metadata?.userMemory,

          // Skills configuration for <available_skills> injection
          ...(resolvedSkills?.enabledSkills?.length && {
            skillsConfig: { enabledSkills: resolvedSkills.enabledSkills },
          }),

          // Topic reference summaries
          ...(topicReferences && { topicReferences }),
        };

        processedMessages = await serverMessagesEngine({
          ...contextEngineInput,
          onSourceIds: (ids) => {
            wireSourceIds = ids;
          },
        });

        // Emit context engine event for tracing
        // Omit large/redundant fields to reduce snapshot size:
        // - input.messages: reconstructible from step's messagesBaseline + messagesDelta
        // - input.toolsConfig: static per operation, ~47KB of manifests repeated every call_llm step
        // Keep output (processedMessages) — needed by inspect CLI for --env, --system-role, -m
        const {
          messages: _inputMsgs,
          toolResultImages: _toolResultImages,
          toolsConfig: _toolsConfig,
          ...contextEngineInputLite
        } = contextEngineInput;
        events.push({
          input: {
            ...contextEngineInputLite,
            toolCount: _toolsConfig?.tools?.length ?? 0,
          },
          output: processedMessages,
          type: 'context_engine_result',
        } as any);
      } else {
        processedMessages = llmPayload.messages;
      }

      // Initialize ModelRuntime (read user's keyVaults from database).
      // Pass conversation ids so billing proxy can attribute charges (site cost).
      const modelRuntime = await initModelRuntimeFromDB(ctx.serverDB, ctx.userId!, provider, {
        assistantMessageId: assistantMessageItem.id,
        retryOwner: 'engine',
        sessionId: state.metadata?.sessionId,
        studioWebChat: state.metadata?.studioWebChat === true,
        topicId: state.metadata?.topicId ?? ctx.topicId,
      });

      // Construct ChatStreamPayload
      const stream = ctx.stream ?? true;
      // arckep: встроенный поиск модели в серверном контуре (REST-движок студии, боты, cron).
      // Клиентский чат включает его через getSearchConfig; здесь те же правила.
      const enabledSearch = await resolveServerEnabledSearch(agentConfig, model, provider);
      // arckep (chat-next-redesign, E1): температура помощника и параметры рассуждений — как в
      // браузерном чате; раньше серверный вызов их не передавал вовсе.
      const modelParams = await resolveServerModelParams(agentConfig, model, provider);
      log(`[${operationLogId}] model params: %o`, modelParams);
      let chatPayload = {
        ...(modelParams as unknown as Partial<ChatStreamPayload>),
        messages: processedMessages,
        model,
        stream,
        tools,
        ...(enabledSearch ? { enabledSearch: true } : {}),
        ...(provider === 'deepseek' && model === 'deepseek-flash'
          ? {
              read_url: !!(agentConfig?.chatConfig as any)?.deepseekReadUrl,
              safety_check: !!(agentConfig?.chatConfig as any)?.deepseekSafetyCheck,
            }
          : {}),
      };

      // Buffer: accumulate text and reasoning, send every 50ms
      const BUFFER_INTERVAL = 50;
      let textBuffer = '';
      let reasoningBuffer = '';

      let textBufferTimer: NodeJS.Timeout | null = null;
      let reasoningBufferTimer: NodeJS.Timeout | null = null;

      const flushTextBuffer = async () => {
        const delta = textBuffer;
        textBuffer = '';

        if (!!delta) {
          log(`[${operationLogId}] flushTextBuffer:`, delta);

          // Build standard Agent Runtime event
          events.push({
            chunk: { text: delta, type: 'text' },
            type: 'llm_stream',
          });

          const publishStart = Date.now();
          await streamManager.publishStreamChunk(operationId, stepIndex, {
            chunkType: 'text',
            content: delta,
          });
          timing(
            '[%s] flushTextBuffer published at %d, took %dms, length: %d',
            operationLogId,
            publishStart,
            Date.now() - publishStart,
            delta.length,
          );
        }
      };

      const flushReasoningBuffer = async () => {
        const delta = reasoningBuffer;

        reasoningBuffer = '';

        if (!!delta) {
          log(`[${operationLogId}] flushReasoningBuffer:`, delta);

          events.push({
            chunk: { text: delta, type: 'reasoning' },
            type: 'llm_stream',
          });

          const publishStart = Date.now();
          await streamManager.publishStreamChunk(operationId, stepIndex, {
            chunkType: 'reasoning',
            reasoning: delta,
          });
          timing(
            '[%s] flushReasoningBuffer published at %d, took %dms, length: %d',
            operationLogId,
            publishStart,
            Date.now() - publishStart,
            delta.length,
          );
        }
      };

      const maxAttempts = LLM_MAX_RETRIES + 1;
      let recoveredInput = false;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        let content = '';
        let rawContent = '';
        let toolsCalling: ChatToolPayload[] = [];
        let tool_calls: MessageToolCall[] = [];
        let resolvedToolCalls: ChatToolPayload[] = [];
        let unresolvedToolCalls: UnresolvedToolCallItem[] = [];
        let thinkingContent = '';
        const imageList: any[] = [];
        let grounding: any = null;
        let currentStepUsage: any = undefined;
        let streamError: any = undefined;
        const contentParts: ContentPart[] = [];
        const reasoningParts: ContentPart[] = [];
        let hasContentImages = false;
        let hasReasoningImages = false;
        const htmlStreamGate = new HtmlArtifactStreamGate();
        textBuffer = '';
        reasoningBuffer = '';

        // Upload a base64 image from a Gemini-3 / image-preview multimodal stream to S3
        // and return the proxy URL + fileId. Falls back to the data URI on error so that
        // the user still sees something and the rest of the message is preserved.
        const uploadStreamImage = async (
          base64Content: string,
          mimeType: string | undefined,
        ): Promise<{ fileId?: string; url: string }> => {
          const dataUri = `data:${mimeType || 'image/png'};base64,${base64Content}`;
          if (!ctx.serverDB || !ctx.userId) {
            return { url: dataUri };
          }

          try {
            const extension = (mimeType || 'image/png').split('/')[1] || 'png';
            const today = new Date().toISOString().split('T')[0];
            const pathname = `${fileEnv.NEXT_PUBLIC_S3_FILE_PATH}/agent-runtime/images/${today}/${nanoid()}.${extension}`;
            const fileService = new FileService(ctx.serverDB, ctx.userId);
            const { fileId, url } = await fileService.uploadBase64(base64Content, pathname);
            return { fileId, url };
          } catch (uploadError) {
            console.error(
              `[${operationLogId}][content_part] Image upload failed, keeping data URI:`,
              uploadError,
            );
            return { url: dataUri };
          }
        };

        const appendTextToContentParts = (text: string) => {
          const last = contentParts.at(-1);
          if (last && last.type === 'text') {
            last.text += text;
          } else {
            contentParts.push({ text, type: 'text' });
          }
        };

        const appendTextToReasoningParts = (text: string) => {
          const last = reasoningParts.at(-1);
          if (last && last.type === 'text') {
            last.text += text;
          } else {
            reasoningParts.push({ text, type: 'text' });
          }
        };

        const clearAttemptBuffers = () => {
          if (textBufferTimer) {
            clearTimeout(textBufferTimer);
            textBufferTimer = null;
          }

          if (reasoningBufferTimer) {
            clearTimeout(reasoningBufferTimer);
            reasoningBufferTimer = null;
          }

          textBuffer = '';
          reasoningBuffer = '';
        };

        const preservePartialResponse = () =>
          persistInterruptedLLM(ctx, state, {
            assistantMessageId: assistantMessageItem.id,
            content: hasContentImages ? serializePartsForStorage(contentParts) : content,
            grounding,
            imageList,
            isMultimodal: hasContentImages,
            model,
            provider,
            reasoning: hasReasoningImages
              ? { content: serializePartsForStorage(reasoningParts), isMultimodal: true }
              : thinkingContent
                ? { content: thinkingContent }
                : undefined,
            usage: currentStepUsage,
          });

        let attemptStartedAt = Date.now();

        try {
          throwIfAborted(ctx.signal);
          log(
            `${stagePrefix} calling model-runtime chat (attempt %d/%d, model: %s, messages: %d, tools: %d)`,
            attempt,
            maxAttempts,
            model,
            chatPayload.messages.length,
            tools?.length ?? 0,
          );

          // arckep (19.10.2026): трасса Langfuse, как в браузерном пути (ENABLE_LANGFUSE=1); её колбэки
          // добавляются к колбэкам ниже, ошибка трассы ответ не ломает
          const engineTrace = createEngineTraceCallbacks(
            chatPayload as unknown as ChatStreamPayload,
            {
              provider,
              sessionId: state.metadata?.sessionId,
              topicId: state.metadata?.topicId ?? ctx.topicId,
              userId: ctx.userId,
            },
          );

          // Call model-runtime chat
          attemptStartedAt = Date.now();
          const response = await modelRuntime.chat(chatPayload, {
            callback: withEngineTrace(engineTrace, {
              onCompletion: async (data) => {
                // Capture usage (may or may not include cost)
                if (data.usage) {
                  currentStepUsage = data.usage;
                }
              },
              onUsage: async (usage) => {
                currentStepUsage = usage;
              },
              onGrounding: async (groundingData) => {
                log(`[${operationLogId}][grounding] %O`, groundingData);
                grounding = groundingData;
                if (groundingData?.deepseek?.finish_reason === 'content_filter') {
                  clearAttemptBuffers();
                  content = '';
                  rawContent = '';
                  thinkingContent = '';
                  toolsCalling = [];
                  tool_calls = [];
                  resolvedToolCalls = [];
                  unresolvedToolCalls = [];
                  contentParts.length = 0;
                  reasoningParts.length = 0;
                  imageList.length = 0;
                  hasContentImages = false;
                  hasReasoningImages = false;
                }

                await streamManager.publishStreamChunk(operationId, stepIndex, {
                  chunkType: 'grounding',
                  grounding: groundingData,
                });
              },
              onText: async (text) => {
                timing(
                  '[%s] onText received chunk at %d, length: %d',
                  operationLogId,
                  Date.now(),
                  text.length,
                );
                rawContent += text;
                const safeText = htmlStreamGate.push(text);
                content += safeText;

                if (safeText) {
                  textBuffer += safeText;

                  // If no timer exists, create one
                  if (!textBufferTimer) {
                    textBufferTimer = setTimeout(async () => {
                      await flushTextBuffer();
                      textBufferTimer = null;
                    }, BUFFER_INTERVAL);
                  }
                }
              },
              onThinking: async (reasoning) => {
                timing(
                  '[%s] onThinking received chunk at %d, length: %d',
                  operationLogId,
                  Date.now(),
                  reasoning.length,
                );
                thinkingContent += reasoning;

                // Buffer reasoning content
                reasoningBuffer += reasoning;

                // If no timer exists, create one
                if (!reasoningBufferTimer) {
                  reasoningBufferTimer = setTimeout(async () => {
                    await flushReasoningBuffer();
                    reasoningBufferTimer = null;
                  }, BUFFER_INTERVAL);
                }
              },
              onToolsCalling: async ({ toolsCalling: raw }) => {
                const passthroughIdentifiers = Object.entries(resolved.sourceMap)
                  .filter(([, source]) => source === 'client')
                  .map(([id]) => id);
                const enforceActiveManifests =
                  Object.keys(operationToolSet.manifestMap).length > 0 ||
                  (operationToolSet.disabledToolIds?.length ?? 0) > 0;
                const resolver = new ToolNameResolver();
                const diagnostics = resolver.resolveWithDiagnostics(raw, resolved.manifestMap, {
                  disabledToolIds: operationToolSet.disabledToolIds,
                  enforceActiveManifests,
                  passthroughIdentifiers,
                });

                for (const tc of raw) {
                  const repaired = diagnostics.repairedNames[tc.id];
                  if (repaired && tc.function) {
                    tc.function.name = repaired;
                  }
                }

                // Add source field from resolved sourceMap for routing tool execution
                const resolvedPayload = diagnostics.resolved.map((p) => ({
                  ...p,
                  source: resolved.sourceMap[p.identifier],
                }));
                resolvedToolCalls = resolvedPayload;
                unresolvedToolCalls = diagnostics.unresolved;
                toolsCalling = resolvedPayload;
                tool_calls = raw;

                // If textBuffer exists, flush it first
                if (!!textBuffer) {
                  await flushTextBuffer();
                }

                if (resolvedPayload.length > 0) {
                  await streamManager.publishStreamChunk(operationId, stepIndex, {
                    chunkType: 'tools_calling',
                    toolsCalling: resolvedPayload.map((call) =>
                      call.identifier === 'arckep-text-file' ? { ...call, arguments: '{}' } : call,
                    ),
                  });
                }
              },
              onError: async (errorData) => {
                streamError = errorData;
                console.error(`[${operationLogId}][stream_error]`, errorData);
              },
              // Multimodal output from Gemini 3 / image-preview models emits
              // `content_part` / `reasoning_part` events instead of `text` /
              // `reasoning`. Without these callbacks image parts are silently
              // dropped: the assistant message is persisted with empty content
              // and the user is still billed. See packages/model-runtime/src/
              // core/streams/google/index.ts (shouldUseMultimodalProcessing).
              onContentPart: async (data) => {
                if (data.partType === 'text') {
                  const text = data.content;
                  if (!text) return;

                  rawContent += text;
                  const safeText = htmlStreamGate.push(text);
                  content += safeText;
                  if (safeText) {
                    appendTextToContentParts(safeText);

                    textBuffer += safeText;
                    if (!textBufferTimer) {
                      textBufferTimer = setTimeout(async () => {
                        await flushTextBuffer();
                        textBufferTimer = null;
                      }, BUFFER_INTERVAL);
                    }
                  }
                  return;
                }

                if (data.partType === 'image') {
                  hasContentImages = true;

                  if (textBuffer) {
                    await flushTextBuffer();
                  }

                  const { fileId, url } = await uploadStreamImage(data.content, data.mimeType);
                  contentParts.push({ image: url, type: 'image' });
                  // Only link a file in `messages_files` when we actually
                  // uploaded to S3 (non-null fileId). If upload fell back to a
                  // data URI, no DB file row exists — inserting the nanoid
                  // would violate the FK to globalFiles.
                  if (fileId) {
                    imageList.push({
                      alt: 'generated-image',
                      id: fileId,
                      url,
                    });
                  }

                  await streamManager.publishStreamChunk(operationId, stepIndex, {
                    chunkType: 'content_part',
                    contentParts: [{ image: url, type: 'image' }],
                  });
                }
              },
              onReasoningPart: async (data) => {
                if (data.partType === 'text') {
                  const text = data.content;
                  if (!text) return;

                  thinkingContent += text;
                  appendTextToReasoningParts(text);

                  reasoningBuffer += text;
                  if (!reasoningBufferTimer) {
                    reasoningBufferTimer = setTimeout(async () => {
                      await flushReasoningBuffer();
                      reasoningBufferTimer = null;
                    }, BUFFER_INTERVAL);
                  }
                  return;
                }

                if (data.partType === 'image') {
                  hasReasoningImages = true;

                  if (reasoningBuffer) {
                    await flushReasoningBuffer();
                  }

                  const { url } = await uploadStreamImage(data.content, data.mimeType);
                  reasoningParts.push({ image: url, type: 'image' });

                  await streamManager.publishStreamChunk(operationId, stepIndex, {
                    chunkType: 'reasoning_part',
                    reasoningParts: [{ image: url, type: 'image' }],
                  });
                }
              },
            }),
            metadata: {
              operationId,
              topicId: state.metadata?.topicId,
              trigger: state.metadata?.trigger,
            },
            signal: ctx.signal,
            user: ctx.userId,
          });

          // Consume stream to ensure all callbacks complete execution
          await consumeStreamUntilDone(response, ctx.signal);
          throwIfAborted(ctx.signal);

          // If a stream error was captured via onError callback, throw to propagate the error
          if (streamError) {
            const streamExecutionError = new Error(
              typeof streamError.message === 'string'
                ? `LLM stream error: ${streamError.message}`
                : `LLM stream error: ${JSON.stringify(streamError)}`,
            );
            const { message: _message, ...restStreamError } = streamError as Record<
              string,
              unknown
            >;
            Object.assign(streamExecutionError, restStreamError);
            throw streamExecutionError;
          }

          if (grounding?.deepseek?.finish_reason === 'content_filter') {
            content = 'Модель отказалась отвечать на этот запрос.';
            rawContent = content;
            textBuffer = content;
          }
          const prevCodeArtifactRepairAttempts =
            (state.metadata?.codeArtifactRepairAttempts as number | undefined) ?? 0;
          const canTentativelyRepairCodeArtifact =
            toolsCalling.length === 0 &&
            tool_calls.length === 0 &&
            !state.forceFinish &&
            prevCodeArtifactRepairAttempts + 1 <= 2 &&
            !ctx.signal?.aborted &&
            !(await isOperationInterrupted(ctx));

          let htmlGateDiagnostics: string[] = [];
          let codeArtifactGateDiagnostics: string[] = [];
          let codeArtifactSanitizedAttempt: string | undefined;
          let codeArtifactFallbackContent: string | undefined;
          let codeArtifactFallbackDelta: string | undefined;
          let suppressedCodeArtifactFallback = false;
          if (rawContent.includes('<lobeArtifact') || rawContent !== content) {
            const gateResult = await htmlStreamGate.finalize({
              suppressCodeArtifactFallback: canTentativelyRepairCodeArtifact,
            });
            if (gateResult.postStreamDelta) {
              textBuffer += gateResult.postStreamDelta;
              if (hasContentImages) {
                appendTextToContentParts(gateResult.postStreamDelta);
              }
            }
            content = gateResult.finalContent;
            if (!gateResult.valid) {
              htmlGateDiagnostics = gateResult.diagnostics;
              codeArtifactGateDiagnostics = gateResult.codeArtifactDiagnostics;
              codeArtifactSanitizedAttempt = gateResult.sanitizedAttemptContent;
              if (
                canTentativelyRepairCodeArtifact &&
                gateResult.codeArtifactDiagnostics.length > 0 &&
                gateResult.codeArtifactFallbackContent !== undefined
              ) {
                suppressedCodeArtifactFallback = true;
                codeArtifactFallbackContent = gateResult.codeArtifactFallbackContent;
                codeArtifactFallbackDelta = gateResult.codeArtifactFallbackDelta ?? '';
              }
            }
          }

          await flushTextBuffer();
          await flushReasoningBuffer();
          clearAttemptBuffers();

          log(
            `[${operationLogId}] finish model-runtime calling | content: %d chars | reasoning: %d chars | tools: %d | usage: %s`,
            content.length,
            thinkingContent.length,
            toolsCalling.length,
            currentStepUsage ? 'yes' : 'none',
          );

          if (thinkingContent) {
            log(`[${operationLogId}][reasoning]`, thinkingContent);
          }
          if (content) {
            log(`[${operationLogId}][content]`, content);
          }
          if (toolsCalling.length > 0) {
            log(`[${operationLogId}][toolsCalling] `, toolsCalling.map(diagnosticToolCall));
          }

          // Log usage information
          if (currentStepUsage) {
            log(`[${operationLogId}][usage] %O`, currentStepUsage);
          }

          // arckep: tool-call repeat guard (tracks only real resolved calls)
          const toolCallRepeatGuard = updateToolCallRepeatGuard(
            state.toolCallRepeatGuard,
            resolvedToolCalls,
          );
          let blockedRepeatedToolCall = false;
          if (hasRepeatedToolCall(toolCallRepeatGuard) && !(await isOperationInterrupted(ctx))) {
            content = TOOL_CALL_REPEAT_STOP_MESSAGE;
            hasContentImages = false;
            toolsCalling = [];
            tool_calls = [];
            resolvedToolCalls = [];
            unresolvedToolCalls = [];
            blockedRepeatedToolCall = true;
          }

          const prevUnresolved = Number(state.metadata?.consecutiveUnresolvedToolCalls ?? 0);
          let nextConsecutiveUnresolved: number | undefined;
          let blockedUnresolvedToolCall = false;
          const pendingUnresolvedErrors: Record<string, string> = {};
          const syntheticManifestApis: Array<{
            description: string;
            humanIntervention: any;
            name: string;
            parameters: Record<string, any>;
          }> = [];

          if (!blockedRepeatedToolCall) {
            if (unresolvedToolCalls.length === 0 && resolvedToolCalls.length > 0) {
              nextConsecutiveUnresolved = 0;
            } else if (unresolvedToolCalls.length > 0) {
              nextConsecutiveUnresolved = resolvedToolCalls.length > 0 ? 0 : prevUnresolved + 1;

              if (
                resolvedToolCalls.length === 0 &&
                nextConsecutiveUnresolved >= UNRESOLVED_TOOL_FEEDBACK_LIMIT &&
                !(await isOperationInterrupted(ctx))
              ) {
                toolsCalling = [];
                tool_calls = [];
                if (!content.trim() && !hasContentImages) {
                  content = UNRESOLVED_TOOL_STOP_MESSAGE;
                  textBuffer += UNRESOLVED_TOOL_STOP_MESSAGE;
                  await flushTextBuffer();
                }
                blockedUnresolvedToolCall = true;
              } else {
                const resolver = new ToolNameResolver();
                const syntheticById = new Map<string, ChatToolPayload>();
                for (const u of unresolvedToolCalls) {
                  const safeApiName = (u.rawName.replaceAll(/[^\w-]/g, '_') || 'unknown').slice(
                    0,
                    32,
                  );
                  const safeWireName = resolver.generate(UNRESOLVED_TOOL_IDENTIFIER, safeApiName);
                  const matchingRaw = tool_calls.find((tc) => tc.id === u.toolCall.id);
                  if (matchingRaw?.function) {
                    matchingRaw.function.name = safeWireName;
                  }
                  const errorMessage = buildUnresolvedToolErrorMessage(
                    u,
                    toolDiscoveryConfig,
                    operationToolSet.manifestMap,
                  );
                  pendingUnresolvedErrors[u.toolCall.id] = errorMessage;
                  syntheticById.set(u.toolCall.id, {
                    apiName: safeApiName,
                    arguments: '{}',
                    id: u.toolCall.id,
                    identifier: UNRESOLVED_TOOL_IDENTIFIER,
                    type: 'builtin',
                  });
                  syntheticManifestApis.push({
                    description: 'Synthetic unresolved tool placeholder',
                    humanIntervention: {
                      dynamic: { default: 'never', type: '__arckep_unresolved_noop__' },
                    } as any,
                    name: safeApiName,
                    parameters: { properties: {}, type: 'object' },
                  });
                }
                const resolvedById = new Map(resolvedToolCalls.map((c) => [c.id, c]));
                toolsCalling = tool_calls
                  .map((tc) => resolvedById.get(tc.id) ?? syntheticById.get(tc.id))
                  .filter((c): c is ChatToolPayload => Boolean(c));
              }
            }
          }

          const htmlSyntaxRepairAttempts =
            htmlGateDiagnostics.length > 0
              ? ((state.metadata?.htmlSyntaxRepairAttempts as number | undefined) ?? 0) + 1
              : ((state.metadata?.htmlSyntaxRepairAttempts as number | undefined) ?? 0);
          const canScheduleSyntaxRepair =
            htmlGateDiagnostics.length > 0 &&
            !blockedRepeatedToolCall &&
            !blockedUnresolvedToolCall &&
            toolsCalling.length === 0 &&
            !state.forceFinish &&
            htmlSyntaxRepairAttempts <= 2 &&
            !ctx.signal?.aborted &&
            !(await isOperationInterrupted(ctx));
          const htmlArtifactSyntaxError = canScheduleSyntaxRepair
            ? htmlGateDiagnostics.join('\n\n')
            : undefined;

          const codeArtifactRepairAttempts =
            codeArtifactGateDiagnostics.length > 0 && !htmlArtifactSyntaxError
              ? prevCodeArtifactRepairAttempts + 1
              : prevCodeArtifactRepairAttempts;
          const canScheduleCodeArtifactRepair =
            codeArtifactGateDiagnostics.length > 0 &&
            !htmlArtifactSyntaxError &&
            !blockedRepeatedToolCall &&
            !blockedUnresolvedToolCall &&
            toolsCalling.length === 0 &&
            !state.forceFinish &&
            codeArtifactRepairAttempts <= 2 &&
            !ctx.signal?.aborted &&
            !(await isOperationInterrupted(ctx));
          const codeArtifactRepairError = canScheduleCodeArtifactRepair
            ? codeArtifactGateDiagnostics.join('\n\n')
            : undefined;

          if (
            codeArtifactGateDiagnostics.length > 0 &&
            !canScheduleCodeArtifactRepair &&
            !canScheduleSyntaxRepair &&
            suppressedCodeArtifactFallback &&
            codeArtifactFallbackContent !== undefined
          ) {
            if (codeArtifactFallbackDelta) {
              textBuffer += codeArtifactFallbackDelta;
              if (hasContentImages) {
                appendTextToContentParts(codeArtifactFallbackDelta);
              }
              await flushTextBuffer();
            }
            content = codeArtifactFallbackContent;
          }

          if (
            htmlGateDiagnostics.length > 0 &&
            !canScheduleSyntaxRepair &&
            !canScheduleCodeArtifactRepair &&
            toolsCalling.length === 0
          ) {
            const fallbackNotice =
              'Не удалось показать готовую HTML-страницу: в коде скрипта осталась синтаксическая ошибка. Попробуйте повторить запрос или уточнить задачу.';
            content = content.trim() ? `${content.trim()}\n\n${fallbackNotice}` : fallbackNotice;
          }

          const artifactTopicId = state.metadata?.topicId ?? ctx.topicId;
          let originalCodeArtifactContent: string | undefined;
          if (
            state.metadata?.studioWebChat === true &&
            ctx.serverDB &&
            ctx.userId &&
            artifactTopicId &&
            toolsCalling.length === 0 &&
            !htmlArtifactSyntaxError &&
            !codeArtifactRepairError
          ) {
            originalCodeArtifactContent = hasContentImages
              ? serializePartsForStorage(contentParts)
              : content;
            const { serverDB, userId } = ctx;
            let fileService: FileService | undefined;
            const artifactOptions = {
              fileService: () => (fileService ??= new FileService(serverDB, userId)),
              messageId: assistantMessageItem.id,
              signal: ctx.signal,
              topicId: artifactTopicId,
              userId,
            };
            if (hasContentImages) {
              const textParts = contentParts.filter((part) => part.type === 'text');
              const originalText = textParts.map((part) => part.text).join('');
              for (const [index, part] of contentParts.entries()) {
                if (part.type === 'text') {
                  part.text = await saveLongCodeArtifacts(part.text, {
                    ...artifactOptions,
                    contentPartIndex: index,
                  });
                }
              }
              if (content === originalText) {
                content = textParts.map((part) => part.text).join('');
              }
            } else {
              content = await saveLongCodeArtifacts(content, artifactOptions);
            }
            throwIfAborted(ctx.signal);
          }

          // Add a complete llm_stream event (including all streaming chunks)
          // Compute final content NOW (before emitting llm_result) so the
          // state machine downstream sees a non-empty content string when
          // the model returned image-only multimodal output. Otherwise
          // GeneralChatAgent sees content='' + no tool_calls, assumes the
          // step produced nothing and schedules another call_llm — which
          // silently re-runs image generation, billing the user twice
          // and leaving the operation stuck in "processing".
          const finalContent = hasContentImages ? serializePartsForStorage(contentParts) : content;

          events.push({
            result: {
              content: finalContent,
              ...(blockedRepeatedToolCall
                ? { finishReason: 'tool_call_repeat_limit' }
                : blockedUnresolvedToolCall
                  ? { finishReason: 'unresolved_tool_call_limit' }
                  : {}),
              reasoning: thinkingContent,
              tool_calls,
              usage: currentStepUsage,
            },
            type: 'llm_result',
          });

          // Publish stream end event
          await streamManager.publishStreamEvent(operationId, {
            data: {
              finalContent,
              grounding,
              imageList: imageList.length > 0 ? imageList : undefined,
              reasoning: thinkingContent || undefined,
              toolsCalling: toolsCalling.filter(
                (call) => call.identifier !== UNRESOLVED_TOOL_IDENTIFIER,
              ),
              usage: currentStepUsage,
            },
            stepIndex,
            type: 'stream_end',
          });

          if (htmlArtifactSyntaxError || codeArtifactRepairError) {
            await streamManager.publishStreamEvent(operationId, {
              data: {
                reason: htmlArtifactSyntaxError ? 'html_artifact_repair' : 'code_artifact_repair',
                resetText: true,
              },
              stepIndex,
              type: 'stream_retry',
            });
          }

          log('[%s:%d] call_llm completed', operationId, stepIndex);

          // Determine final reasoning - handle multimodal reasoning
          let finalReasoning: any = undefined;
          if (hasReasoningImages) {
            // Has images, use multimodal format
            finalReasoning = {
              content: serializePartsForStorage(reasoningParts),
              isMultimodal: true,
            };
          } else if (thinkingContent) {
            // Has text from reasoning but no images
            finalReasoning = {
              content: thinkingContent,
            };
          }

          const persistedToolsCalling = toolsCalling.filter(
            (call) => call.identifier !== UNRESOLVED_TOOL_IDENTIFIER,
          );
          const shouldReuseAssistantForFollowUp =
            toolsCalling.length > 0 &&
            persistedToolsCalling.length === 0 &&
            !finalContent.trim() &&
            !hasContentImages &&
            !finalReasoning;

          try {
            // Build metadata object
            const metadata: Record<string, any> = {};
            if (currentStepUsage && typeof currentStepUsage === 'object') {
              Object.assign(metadata, currentStepUsage);
            }
            if (hasContentImages) {
              metadata.isMultimodal = true;
            }
            if (
              originalCodeArtifactContent !== undefined &&
              originalCodeArtifactContent !== finalContent
            ) {
              metadata.codeArtifactFallback = originalCodeArtifactContent;
            }

            await ctx.messageModel.update(assistantMessageItem.id, {
              content: finalContent,
              imageList: imageList.length > 0 ? imageList : undefined,
              metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
              reasoning: finalReasoning,
              search: grounding,
              tools:
                persistedToolsCalling.length > 0
                  ? persistedToolsCalling.map((call) =>
                      call.identifier === 'arckep-text-file' ? { ...call, arguments: '{}' } : call,
                    )
                  : undefined,
            });
          } catch (error) {
            console.error('[call_llm] Failed to update message:', error);
          }

          if (
            ctx.serverDB &&
            ctx.userId &&
            toolsCalling.length === 0 &&
            !htmlArtifactSyntaxError &&
            !codeArtifactRepairError &&
            shouldAutoAttachSpreadsheet(
              finalContent,
              llmPayload.messages as Array<{ content?: unknown; role?: string }>,
            )
          ) {
            try {
              const messageService = new MessageService(ctx.serverDB, ctx.userId);
              await messageService.createSpreadsheetFile(assistantMessageItem.id);
            } catch (error) {
              log('[%s] Failed to auto-attach spreadsheet: %O', operationLogId, error);
            }
          }

          // ===== 2. Then accumulate to AgentState =====
          const newState = structuredClone(state);
          newState.toolCallRepeatGuard = toolCallRepeatGuard;
          if (shouldReuseAssistantForFollowUp) {
            newState.metadata = {
              ...newState.metadata,
              reuseAssistantMessageId: assistantMessageItem.id,
            };
          } else if (newState.metadata?.reuseAssistantMessageId) {
            newState.metadata = {
              ...newState.metadata,
              reuseAssistantMessageId: undefined,
            };
          }
          if (newState.metadata?.deliverUnresolvedToolFeedback) {
            newState.metadata = {
              ...newState.metadata,
              deliverUnresolvedToolFeedback: undefined,
            };
          }
          if (nextConsecutiveUnresolved !== undefined) {
            newState.metadata = {
              ...newState.metadata,
              consecutiveUnresolvedToolCalls: nextConsecutiveUnresolved,
            };
          }
          if (Object.keys(pendingUnresolvedErrors).length > 0) {
            newState.metadata = {
              ...newState.metadata,
              pendingUnresolvedToolErrors: {
                ...newState.metadata?.pendingUnresolvedToolErrors,
                ...pendingUnresolvedErrors,
              },
            };
            const existingApis = newState.toolManifestMap?.[UNRESOLVED_TOOL_IDENTIFIER]?.api ?? [];
            const apiMap = new Map<string, any>();
            for (const api of [...existingApis, ...syntheticManifestApis]) {
              apiMap.set(api.name, api);
            }
            newState.toolManifestMap = {
              ...newState.toolManifestMap,
              [UNRESOLVED_TOOL_IDENTIFIER]: {
                api: [...apiMap.values()],
                humanIntervention: {
                  dynamic: { default: 'never', type: '__arckep_unresolved_noop__' },
                } as any,
                identifier: UNRESOLVED_TOOL_IDENTIFIER,
                meta: { title: 'Unresolved Tool' },
                type: 'builtin',
              } as any,
            };
          }
          if (htmlGateDiagnostics.length > 0) {
            newState.metadata = {
              ...newState.metadata,
              htmlSyntaxRepairAttempts,
            };
          }
          if (codeArtifactGateDiagnostics.length > 0 && !htmlArtifactSyntaxError) {
            newState.metadata = {
              ...newState.metadata,
              codeArtifactRepairAttempts,
            };
          }

          if (htmlArtifactSyntaxError) {
            newState.messages.push(
              {
                content:
                  codeArtifactGateDiagnostics.length > 0
                    ? (codeArtifactSanitizedAttempt ?? rawContent)
                    : rawContent,
                id: assistantMessageItem.id,
                metadata: { internalRepairAttempt: true },
                role: 'assistant',
              },
              {
                content: `${htmlArtifactSyntaxError}\n\nИсправь синтаксическую ошибку и пересоздай артефакт через writeArtifact({ identifier, title, content }) либо выдай полный исправленный <lobeArtifact type="text/html"> без экранирования кавычек и переносов.`,
                role: 'user',
              },
            );
            const layoutManifest = operationToolSet.manifestMap[ArckepLayoutIdentifier];
            if (layoutManifest) {
              const existingActivations = newState.activatedStepTools ?? [];
              if (!existingActivations.some((item) => item.id === ArckepLayoutIdentifier)) {
                newState.activatedStepTools = [
                  ...existingActivations,
                  {
                    activatedAtStep: stepIndex,
                    id: ArckepLayoutIdentifier,
                    manifest: layoutManifest,
                    source: 'discovery',
                  },
                ];
              }
            }
          } else if (codeArtifactRepairError) {
            newState.messages.push(
              {
                content: codeArtifactSanitizedAttempt ?? content,
                id: assistantMessageItem.id,
                metadata: { internalRepairAttempt: true },
                role: 'assistant',
              },
              {
                content: `${codeArtifactRepairError}\n\nВ твоём предыдущем ответе вместо реального кода оказался пустой служебный тег ссылки на файл (/chat/code-artifact/...). Такие теги создаёт только сервер автоматически — никогда не пиши <lobeArtifact> с /chat/code-artifact/. Повтори ответ целиком, выдав запрошенный код обычным Markdown-блоком кода с языком и именем файла (например \`\`\`vba Module1.bas) или через инструмент arckep-text-file/writePart.`,
                role: 'user',
              },
            );
          } else {
            newState.messages.push({
              content,
              ...(provider === 'qwen' && model === 'qwen4-max' && thinkingContent
                ? { reasoning_content: thinkingContent }
                : {}),
              search: grounding,
              ...(grounding?.deepseek
                ? {
                    server_tool_calls: grounding.deepseek.server_tool_calls,
                    reasoning_content: grounding.deepseek.reasoning_content,
                    annotations: grounding.deepseek.annotations,
                  }
                : {}),
              role: 'assistant',
              tool_calls: tool_calls.length > 0 ? tool_calls : undefined,
            });
          }

          if (currentStepUsage) {
            // Use UsageCounter to uniformly accumulate usage and cost
            const { usage, cost } = UsageCounter.accumulateLLM({
              cost: newState.cost,
              model: llmPayload.model,
              modelUsage: currentStepUsage,
              provider: llmPayload.provider,
              usage: newState.usage,
            });

            newState.usage = usage;
            if (cost) newState.cost = cost;
          }

          return {
            events,
            newState,
            nextContext: {
              payload: {
                ...(codeArtifactRepairError ? { codeArtifactRepairError } : {}),
                hasToolsCalling: toolsCalling.length > 0,
                ...(htmlArtifactSyntaxError ? { htmlArtifactSyntaxError } : {}),
                // Pass assistant message ID as parentMessageId for tool calls
                parentMessageId: assistantMessageItem.id,
                result: { content, tool_calls },
                toolsCalling,
              } as GeneralAgentCallLLMResultPayload,
              phase: 'llm_result',
              session: {
                eventCount: events.length,
                messageCount: newState.messages.length,
                sessionId: operationId,
                status: 'running',
                stepCount: state.stepCount + 1,
              },
              stepUsage: currentStepUsage,
            },
          };
        } catch (error) {
          if (ctx.signal?.aborted) {
            clearAttemptBuffers();
            return preservePartialResponse();
          }

          // Retrying an emitted/billable response would replace received output
          // and may charge again. Keep it on the same assistant, then report the
          // failure; only an empty transient attempt can restart automatically.
          const hasReceivedResult = Boolean(
            rawContent ||
            thinkingContent ||
            hasContentImages ||
            hasReasoningImages ||
            toolsCalling.length ||
            tool_calls.length ||
            currentStepUsage,
          );
          if (hasReceivedResult) {
            try {
              await persistFailedLLM(ctx, {
                assistantMessageId: assistantMessageItem.id,
                content: hasContentImages ? serializePartsForStorage(contentParts) : content,
                grounding,
                imageList,
                isMultimodal: hasContentImages,
                model,
                provider,
                reasoning: hasReasoningImages
                  ? { content: serializePartsForStorage(reasoningParts), isMultimodal: true }
                  : thinkingContent
                    ? { content: thinkingContent }
                    : undefined,
                usage: currentStepUsage,
              });
              await flushTextBuffer();
              await flushReasoningBuffer();
            } finally {
              clearAttemptBuffers();
            }
          } else {
            clearAttemptBuffers();
          }

          const attemptElapsedMs = Date.now() - attemptStartedAt;
          const classified = classifyLLMError(error);
          const effectiveKind: LLMErrorKind =
            attemptElapsedMs >= LONG_LLM_ATTEMPT_NO_RETRY_MS ? 'stop' : classified.kind;
          if (classified.kind === 'retry' && effectiveKind === 'stop') {
            log(
              '[%s] Suppressing LLM retry after long attempt (%dms >= %dms)',
              operationLogId,
              attemptElapsedMs,
              LONG_LLM_ATTEMPT_NO_RETRY_MS,
            );
          }
          const interrupted = await isOperationInterrupted(ctx);

          // A permanent input refusal forbids replaying the request. Only send a different
          // prompt once, when the proxy and this attempt both confirm no work/output/usage.
          if (
            classified.rejectedInput &&
            !recoveredInput &&
            !grounding &&
            !hasReceivedResult &&
            !interrupted &&
            attempt < maxAttempts &&
            attemptElapsedMs < LONG_LLM_ATTEMPT_NO_RETRY_MS
          ) {
            const messages = fitRejectedPrompt(
              chatPayload,
              llmPayload.messages,
              wireSourceIds,
              classified.rejectedInput,
              [classified.message, error],
            );
            if (messages) {
              recoveredInput = true;
              chatPayload = { ...chatPayload, messages };
              log(
                '[%s] Reduced rejected input for the same assistant (provider tokens: %d, limit: %d)',
                operationLogId,
                classified.rejectedInput.inputTokens,
                classified.rejectedInput.maxTokens,
              );
              continue;
            }
          }

          if (
            !hasReceivedResult &&
            !interrupted &&
            shouldRetryLLM(effectiveKind, attempt, LLM_MAX_RETRIES)
          ) {
            const delayMs = getLLMRetryDelayMs(attempt);

            log(
              '[%s] LLM call failed with kind=%s (attempt %d/%d), retrying in %dms ...',
              operationLogId,
              classified.kind,
              attempt,
              maxAttempts,
              delayMs,
            );

            await streamManager.publishStreamEvent(operationId, {
              data: { attempt: attempt + 1, delayMs, maxAttempts },
              stepIndex,
              type: 'stream_retry',
            });

            try {
              await waitForRetry(delayMs, ctx.signal);
            } catch (retryError) {
              if (ctx.signal?.aborted) return preservePartialResponse();
              throw retryError;
            }

            if (await isOperationInterrupted(ctx)) {
              throw error;
            }

            continue;
          }

          throw error;
        }
      }

      throw new Error('LLM execution retry loop exited unexpectedly');
    } catch (error) {
      throwIfAborted(ctx.signal);
      const messageError = formatPersistedLLMError(error);
      // The failed assistant must keep its cause when the stream/operation has expired.
      try {
        await ctx.messageModel.update(assistantMessageItem.id, { error: messageError });
      } catch (persistenceError) {
        console.error('[StreamingLLMExecutor] Failed to persist message error', persistenceError);
      }
      // Publish error event
      await streamManager.publishStreamEvent(operationId, {
        data: {
          ...messageError.body,
          error: messageError.message,
          errorType: messageError.type,
          phase: 'llm_execution',
        },
        stepIndex,
        type: 'error',
      });

      console.error(
        `[StreamingLLMExecutor][${operationId}:${stepIndex}] LLM execution failed:`,
        error,
      );
      throw rememberPersistedLLMError(error, messageError);
    }
  },

  compress_context: async (instruction, state) => {
    const { payload } = instruction as AgentInstructionCompressContext;
    const {
      assistantMessageId: incomingAssistantMessageId,
      existingSummary: payloadExistingSummary,
      messages,
      currentTokenCount,
      parentMessageId: incomingParentMessageId,
    } = payload;
    const { operationId, stepIndex } = ctx;
    const operationLogId = `${operationId}:${stepIndex}`;
    const stagePrefix = `[${operationLogId}][compress_context]`;
    const events: AgentEvent[] = [];
    const newState = structuredClone(state);
    const topicId = state.metadata?.topicId;
    const compressedMessagesFallback = [...messages];
    const assistantPlaceholderPatch = incomingAssistantMessageId
      ? { assistantMessageId: incomingAssistantMessageId }
      : {};
    const dataGuardProtected = isDeepSeekDataGuardProtected(
      ctx.agentConfig ?? state.metadata?.agentConfig,
    );
    const compressionModel = dataGuardProtected
      ? DATA_GUARD_COMPRESSION_MODEL
      : newState.modelRuntimeConfig?.compressionModel || newState.modelRuntimeConfig;
    const compressionEffort = dataGuardProtected
      ? undefined
      : newState.modelRuntimeConfig?.compressionModel?.effort;
    let summaryUsage: any;

    if (!topicId || !ctx.userId) {
      return {
        events,
        newState,
        nextContext: {
          payload: {
            ...assistantPlaceholderPatch,
            compressedMessages: compressedMessagesFallback,
            groupId: '',
            parentMessageId: incomingParentMessageId,
            skipped: true,
          } as GeneralAgentCompressionResultPayload,
          phase: 'compression_result',
          session: {
            messageCount: newState.messages.length,
            sessionId: operationId,
            status: 'running',
            stepCount: state.stepCount + 1,
          },
        },
      };
    }

    try {
      const dbMessages = await ctx.messageModel.query({
        agentId: state.metadata?.agentId,
        threadId: state.metadata?.threadId,
        topicId,
      });

      // Preserve the entire active turn in DB (from the last persisted user message through
      // all in-flight assistant/tool/task rows of the active turn) plus incomingAssistantMessageId.
      // Only history strictly before the active user turn is eligible for rolling compression.
      const lastDbUserIndex = dbMessages.findLastIndex((message) => message.role === 'user');
      const historyDbRows =
        lastDbUserIndex >= 0 ? dbMessages.slice(0, lastDbUserIndex) : dbMessages;
      const activeTurnDbRows = lastDbUserIndex >= 0 ? dbMessages.slice(lastDbUserIndex) : [];

      const preservedMessageIds = new Set<string>(
        activeTurnDbRows.map((message) => message.id).filter((id): id is string => Boolean(id)),
      );
      if (incomingAssistantMessageId) {
        preservedMessageIds.add(incomingAssistantMessageId);
      }

      const priorCompressedGroups = historyDbRows.filter(
        (message) => message.role === 'compressedGroup',
      );
      // Exclude the active turn, incomingAssistantMessageId, and any historical empty/loading
      // assistant stubs without tools or reasoning.
      const messagesToSummarize = historyDbRows.filter(
        (message) =>
          message.role !== 'compressedGroup' &&
          Boolean(message.id) &&
          !preservedMessageIds.has(message.id) &&
          !isEmptyAssistantPlaceholder(message),
      );
      const messageIds = messagesToSummarize.map((message) => message.id);

      const dbExistingSummary = priorCompressedGroups
        .map((group) => (typeof group.content === 'string' ? group.content.trim() : ''))
        .filter(Boolean)
        .join('\n\n');
      const existingSummary = dbExistingSummary || payloadExistingSummary?.trim() || undefined;

      // Allow running when there are new prior-turn messages to roll in OR >= 2 legacy stacked
      // compressedGroups to consolidate into a single rolling summary.
      if (messageIds.length === 0 && priorCompressedGroups.length <= 1) {
        return {
          events,
          newState,
          nextContext: {
            payload: {
              ...assistantPlaceholderPatch,
              compressedMessages: compressedMessagesFallback,
              groupId: '',
              parentMessageId: incomingParentMessageId,
              skipped: true,
            } as GeneralAgentCompressionResultPayload,
            phase: 'compression_result',
            session: {
              messageCount: newState.messages.length,
              sessionId: operationId,
              status: 'running',
              stepCount: state.stepCount + 1,
            },
          },
        };
      }

      const latestAssistantMessage = dbMessages.findLast(
        (message) =>
          message.role === 'assistant' &&
          message.id !== incomingAssistantMessageId &&
          !isEmptyAssistantPlaceholder(message),
      );
      const followUpParentId = incomingParentMessageId ?? latestAssistantMessage?.id;
      const messageService = new MessageService(ctx.serverDB, ctx.userId);

      if (!compressionModel?.model || !compressionModel?.provider) {
        return {
          events,
          newState,
          nextContext: {
            payload: {
              ...assistantPlaceholderPatch,
              compressedMessages: compressedMessagesFallback,
              groupId: '',
              parentMessageId: followUpParentId,
              skipped: true,
            } as GeneralAgentCompressionResultPayload,
            phase: 'compression_result',
            session: {
              messageCount: newState.messages.length,
              sessionId: operationId,
              status: 'running',
              stepCount: state.stepCount + 1,
            },
          },
        };
      }

      const preparedMessages = messagesToSummarize.map(prepareMessageForSummarizer);
      const sanitizedExistingSummary = existingSummary
        ? rewriteSavedCodeArtifactTagsForLLM(existingSummary)
        : existingSummary;
      const sanitizedPriorCompressedGroups = priorCompressedGroups.map((group) => {
        if (typeof group.content !== 'string') return group;
        const rewritten = rewriteSavedCodeArtifactTagsForLLM(group.content);
        return rewritten !== group.content ? { ...group, content: rewritten } : group;
      });
      const compressOptions =
        sanitizedExistingSummary || sanitizedPriorCompressedGroups.length > 0
          ? {
              ...(sanitizedExistingSummary ? { existingSummary: sanitizedExistingSummary } : {}),
              ...(sanitizedPriorCompressedGroups.length > 0
                ? { priorMessages: sanitizedPriorCompressedGroups }
                : {}),
            }
          : undefined;
      const compressionPayload = compressOptions
        ? chainCompressContext(preparedMessages, compressOptions)
        : chainCompressContext(preparedMessages);
      const rawPromptMessages = compressionPayload.messages ?? [];
      const needsDeepSeekTurnChunking =
        compressionModel.provider === 'deepseek' &&
        hasOversizedDeepSeekUserTurn(
          rawPromptMessages,
          DEEPSEEK_SUMMARIZER_USER_TURN_BUDGET_TOKENS,
        );
      const compressionMessages = needsDeepSeekTurnChunking
        ? buildDeepSeekAlternatingCompressionMessages({
            existingSummary: sanitizedExistingSummary,
            messages: preparedMessages,
            priorCompressedGroups: sanitizedPriorCompressedGroups,
          })
        : rawPromptMessages;

      // Do NOT forward assistantMessageId here: billing_proxy's _persist_assistant_message_content
      // writes any x-assistant-message-id stream directly into LobeChat's messages row when
      // content is '...' (LOADING_FLAT) or reasoning is NULL, which would leak the internal
      // compression summary/thinking into the user's assistant bubble. Billing attribution uses
      // x-session-id + x-topic-id.
      const compressionRuntime = await initModelRuntimeFromDB(
        ctx.serverDB,
        ctx.userId,
        compressionModel.provider,
        {
          sessionId: state.metadata?.sessionId,
          ...(state.metadata?.studioWebChat === true ? { studioWebChat: true } : {}),
          topicId,
        },
      );

      let summaryContent = '';
      let summaryError: any;

      ctx.signal?.throwIfAborted();
      const compressionResponse = await compressionRuntime.chat(
        {
          enabledContextCaching: false,
          messages: compressionMessages,
          model: compressionModel.model,
          stream: true,
          ...(compressionEffort ? { effort: compressionEffort } : {}),
        },
        {
          callback: {
            onCompletion: async (data) => {
              if (data.usage) summaryUsage = data.usage;
            },
            onContentPart: async (part) => {
              if (part.partType === 'text') summaryContent += part.content;
            },
            onError: async (errorData) => {
              summaryError = errorData;
            },
            onText: async (text) => {
              summaryContent += text;
            },
          },
          signal: ctx.signal,
          user: ctx.userId,
        },
      );

      await consumeStreamUntilDone(compressionResponse, ctx.signal);
      ctx.signal?.throwIfAborted();

      if (summaryError) {
        throw new Error(
          typeof summaryError.message === 'string'
            ? summaryError.message
            : JSON.stringify(summaryError),
        );
      }

      if (!summaryContent.trim()) throw new Error('Compression returned an empty summary');

      // Publish a single rolling summary and hide its source messages atomically, only
      // after the stream has finished successfully.
      const compressionResult = await messageService.upsertRollingCompressionGroup(
        topicId,
        messageIds,
        {
          agentId: state.metadata?.agentId,
          threadId: state.metadata?.threadId,
          topicId,
        },
        summaryContent,
      );

      newState.metadata = {
        ...newState.metadata,
        compressionConsecutiveFailures: 0,
      };

      const preservedTargetAssistant = incomingAssistantMessageId
        ? dbMessages.find(
            (message) =>
              message.id === incomingAssistantMessageId && !isEmptyAssistantPlaceholder(message),
          )
        : undefined;
      const fallbackActiveRows =
        preservedTargetAssistant &&
        !activeTurnDbRows.some((message) => message.id === preservedTargetAssistant.id)
          ? [...activeTurnDbRows, preservedTargetAssistant]
          : activeTurnDbRows;
      const rawCompressedBase = compressionResult.messages || [
        ...messagesToSummarize,
        ...fallbackActiveRows,
      ];
      const compressedMessagesBase = rawCompressedBase.filter(
        (message) => !isEmptyAssistantPlaceholder(message),
      );
      const compressedMessages = [...compressedMessagesBase];

      // Preserve any trailing in-memory-only messages belonging to the active turn
      // (htmlArtifactSyntaxError repair prompt, tasks_batch_result continuation prompt,
      // synthetic unresolved-tool feedback) without duplicating DB-backed rows or virtual groups.
      const lastDbUserId = lastDbUserIndex >= 0 ? dbMessages[lastDbUserIndex]?.id : undefined;
      const activeTurnStateIndex = (() => {
        if (lastDbUserId) {
          const matchedIndex = messages.findLastIndex((message) => message?.id === lastDbUserId);
          if (matchedIndex >= 0) return matchedIndex;
        }
        return findActiveTurnStartIndex(messages);
      })();

      const compressedMessageIdSet = new Set(messageIds);

      if (activeTurnStateIndex >= 0) {
        for (const candidate of messages.slice(activeTurnStateIndex)) {
          if (!candidate || isEmptyAssistantPlaceholder(candidate)) continue;

          if (VIRTUAL_GROUP_ROLES.has(candidate.role)) {
            // Persisted DB children of virtual groups are already in compressedMessagesBase.
            // Only carry over synthetic unresolved-tool entries injected purely in memory.
            if (Array.isArray(candidate.children)) {
              for (const child of candidate.children) {
                if (!Array.isArray(child?.tools)) continue;
                let restoredChildAssistantIndex = -1;
                for (const tool of child.tools) {
                  const isSynthetic =
                    typeof tool?.id === 'string' &&
                    tool.id.length > 0 &&
                    typeof tool?.result?.id === 'string' &&
                    tool.result.id.startsWith('synthetic-');
                  if (!isSynthetic) continue;
                  const alreadyHasToolResult = compressedMessages.some(
                    (existing) => existing?.role === 'tool' && existing.tool_call_id === tool.id,
                  );
                  if (alreadyHasToolResult) continue;

                  const { result: _ignoredResult, ...toolCallOnly } = tool;
                  let targetAssistantIndex = child.id
                    ? compressedMessages.findIndex(
                        (existing) => existing?.role === 'assistant' && existing.id === child.id,
                      )
                    : restoredChildAssistantIndex;

                  if (targetAssistantIndex >= 0) {
                    const targetAssistant = compressedMessages[targetAssistantIndex];
                    const existingTools = Array.isArray((targetAssistant as any).tools)
                      ? (targetAssistant as any).tools
                      : [];
                    const hasToolCall = existingTools.some(
                      (existingTool: any) => existingTool?.id === tool.id,
                    );
                    if (!hasToolCall) {
                      compressedMessages[targetAssistantIndex] = {
                        ...targetAssistant,
                        tools: [...existingTools, toolCallOnly],
                      };
                    }
                  } else {
                    // Persisted assistant was filtered as an empty placeholder (e.g.
                    // shouldReuseAssistantForFollowUp) or never persisted: restore a minimal
                    // assistant entry carrying the synthetic tool call so tool-call / tool-result
                    // pairing stays valid.
                    const restoredAssistant: any = {
                      content: typeof child.content === 'string' ? child.content : '',
                      role: 'assistant',
                      tools: [toolCallOnly],
                      ...(child.id ? { id: child.id } : {}),
                    };
                    compressedMessages.push(restoredAssistant);
                    targetAssistantIndex = compressedMessages.length - 1;
                    restoredChildAssistantIndex = targetAssistantIndex;
                  }

                  let insertIndex = targetAssistantIndex + 1;
                  while (
                    insertIndex < compressedMessages.length &&
                    compressedMessages[insertIndex]?.role === 'tool'
                  ) {
                    insertIndex += 1;
                  }
                  compressedMessages.splice(insertIndex, 0, {
                    content: tool.result.content,
                    role: 'tool',
                    tool_call_id: tool.id,
                  } as any);
                }
              }
            }
            continue;
          }

          if (candidate.id) {
            const existingIndex = compressedMessages.findIndex(
              (existing) => existing?.id === candidate.id,
            );
            if (existingIndex >= 0) {
              if (
                candidate.role === 'assistant' &&
                (candidate as any).metadata?.internalRepairAttempt === true
              ) {
                compressedMessages[existingIndex] = candidate;
              }
            } else if (!compressedMessageIdSet.has(candidate.id)) {
              compressedMessages.push(candidate);
            }
            continue;
          }

          // In-memory message with no id (e.g. HTML repair prompt, tasks_batch_result prompt,
          // flat call_tool push, or purely-synthetic unresolved-tool feedback).
          if (candidate.role === 'assistant') {
            const candidateToolCalls = Array.isArray((candidate as any).tool_calls)
              ? (candidate as any).tool_calls
              : [];
            const candidateTools = Array.isArray((candidate as any).tools)
              ? (candidate as any).tools
              : [];
            const candidateCallIds = new Set<string>([
              ...candidateToolCalls.map((tc: any) => tc?.id).filter(Boolean),
              ...candidateTools.map((t: any) => t?.id).filter(Boolean),
            ]);

            const matchIndex = compressedMessages.findLastIndex((existing: any) => {
              if (existing?.role !== 'assistant') return false;
              const existingCallIds = [
                ...(Array.isArray(existing.tool_calls) ? existing.tool_calls : []),
                ...(Array.isArray(existing.tools) ? existing.tools : []),
              ]
                .map((t: any) => t?.id)
                .filter(Boolean);
              if (
                candidateCallIds.size > 0 &&
                existingCallIds.some((id: string) => candidateCallIds.has(id))
              ) {
                return true;
              }
              return (
                typeof candidate.content === 'string' && existing.content === candidate.content
              );
            });

            if (matchIndex >= 0) {
              const matched: any = compressedMessages[matchIndex];
              let nextMatched = matched;

              if (candidateToolCalls.length > 0) {
                const existingTc = Array.isArray(matched.tool_calls) ? matched.tool_calls : [];
                const seenTc = new Set(existingTc.map((tc: any) => tc?.id).filter(Boolean));
                const missingTc = candidateToolCalls.filter(
                  (tc: any) => tc?.id && !seenTc.has(tc.id),
                );
                if (missingTc.length > 0) {
                  nextMatched = { ...nextMatched, tool_calls: [...existingTc, ...missingTc] };
                }
              }
              if (candidateTools.length > 0) {
                const existingT = Array.isArray(matched.tools) ? matched.tools : [];
                const seenT = new Set(existingT.map((t: any) => t?.id).filter(Boolean));
                const missingT = candidateTools.filter((t: any) => t?.id && !seenT.has(t.id));
                if (missingT.length > 0) {
                  nextMatched = { ...nextMatched, tools: [...existingT, ...missingT] };
                }
              }

              if (nextMatched !== matched) {
                compressedMessages[matchIndex] = nextMatched;
              }
              continue;
            }

            if (!compressedMessages.includes(candidate)) {
              compressedMessages.push(candidate);
            }
            continue;
          }

          if (candidate.role === 'tool') {
            const toolCallId = (candidate as any).tool_call_id;
            if (
              !toolCallId ||
              compressedMessages.some(
                (existing: any) =>
                  existing?.role === 'tool' && existing?.tool_call_id === toolCallId,
              )
            ) {
              continue;
            }

            const ownerIndex = compressedMessages.findLastIndex(
              (existing: any) =>
                existing?.role === 'assistant' &&
                ((Array.isArray(existing.tool_calls) &&
                  existing.tool_calls.some((tc: any) => tc?.id === toolCallId)) ||
                  (Array.isArray(existing.tools) &&
                    existing.tools.some((t: any) => t?.id === toolCallId))),
            );
            if (ownerIndex >= 0) {
              let insertIndex = ownerIndex + 1;
              while (
                insertIndex < compressedMessages.length &&
                compressedMessages[insertIndex]?.role === 'tool'
              ) {
                insertIndex += 1;
              }
              compressedMessages.splice(insertIndex, 0, candidate);
            }
            continue;
          }

          if (!compressedMessages.includes(candidate)) {
            compressedMessages.push(candidate);
          }
        }
      }

      newState.messages = compressedMessages;

      events.push({
        groupId: compressionResult.messageGroupId,
        parentMessageId: followUpParentId,
        type: 'compression_complete',
      });

      return {
        events,
        newState,
        nextContext: {
          payload: {
            ...assistantPlaceholderPatch,
            compressedMessages,
            groupId: compressionResult.messageGroupId,
            parentMessageId: followUpParentId,
          } as GeneralAgentCompressionResultPayload,
          phase: 'compression_result',
          session: {
            messageCount: compressedMessages.length,
            sessionId: operationId,
            status: 'running',
            stepCount: state.stepCount + 1,
          },
        },
      };
    } catch (error) {
      if (ctx.signal?.aborted) {
        newState.status = 'interrupted';
        return { events, newState };
      }
      newState.metadata = {
        ...newState.metadata,
        compressionConsecutiveFailures:
          (newState.metadata?.compressionConsecutiveFailures ?? 0) + 1,
      };
      log(
        `${stagePrefix} Compression failed. originalTokens=%d error=%O`,
        currentTokenCount,
        error,
      );

      events.push({ error, type: 'compression_error' });

      return {
        events,
        newState,
        nextContext: {
          payload: {
            ...assistantPlaceholderPatch,
            compressedMessages: compressedMessagesFallback,
            groupId: '',
            parentMessageId: incomingParentMessageId,
            skipped: true,
          } as GeneralAgentCompressionResultPayload,
          phase: 'compression_result',
          session: {
            messageCount: newState.messages.length,
            sessionId: operationId,
            status: 'running',
            stepCount: state.stepCount + 1,
          },
        },
      };
    } finally {
      // A reported completion still incurred usage when Stop won the publication
      // race. Preserve it once without publishing an incomplete summary.
      if (summaryUsage && compressionModel?.model && compressionModel.provider) {
        const { usage, cost } = UsageCounter.accumulateLLM({
          cost: newState.cost,
          model: compressionModel.model,
          modelUsage: summaryUsage,
          provider: compressionModel.provider,
          usage: newState.usage,
        });
        newState.usage = usage;
        if (cost) newState.cost = cost;
      }
    }
  },
  /**
   * Tool execution
   */
  call_tool: async (instruction, state) => {
    const { payload } = instruction as Extract<AgentInstruction, { type: 'call_tool' }>;
    const { operationId, stepIndex, streamManager, toolExecutionService } = ctx;
    const events: AgentEvent[] = [];
    if (ctx.signal?.aborted) return { events, newState: { ...state, status: 'interrupted' } };

    const operationLogId = `${operationId}:${stepIndex}`;
    log(`[${operationLogId}] payload: %O`, {
      ...payload,
      toolCalling: diagnosticToolCall(payload.toolCalling),
    });

    const isSyntheticUnresolved = payload.toolCalling?.identifier === UNRESOLVED_TOOL_IDENTIFIER;

    // Publish tool execution start event (skip internal synthetic unresolved tool)
    if (!isSyntheticUnresolved) {
      await streamManager.publishStreamEvent(operationId, {
        data: { ...payload, toolCalling: diagnosticToolCall(payload.toolCalling) },
        stepIndex,
        type: 'tool_start',
      });
    }

    try {
      throwIfAborted(ctx.signal);
      // payload is { parentMessageId, toolCalling: ChatToolPayload }
      const chatToolPayload: ChatToolPayload = payload.toolCalling;

      const toolName = `${chatToolPayload.identifier}/${chatToolPayload.apiName}`;

      if (chatToolPayload.identifier === UNRESOLVED_TOOL_IDENTIFIER) {
        const errorMessage =
          state.metadata?.pendingUnresolvedToolErrors?.[chatToolPayload.id] ??
          `Tool "${chatToolPayload.apiName}" is not available in this step.`;
        const executionResult: ToolExecutionResultResponse = {
          content: JSON.stringify({ error: errorMessage, success: false, synthetic: true }),
          error: { message: errorMessage, type: 'ToolNotFound' },
          executionTime: 0,
          state: undefined,
          success: false,
        };

        // Never persist __arckep_unresolved_tool__ rows to PostgreSQL: otherwise GET /messages
        // renders an internal tool card in /chat UI and pollutes future topic turns.
        const newState = structuredClone(state);
        const remaining = { ...newState.metadata?.pendingUnresolvedToolErrors };
        delete remaining[chatToolPayload.id];
        newState.metadata = {
          ...newState.metadata,
          deliverUnresolvedToolFeedback: true,
          pendingUnresolvedToolErrors: Object.keys(remaining).length > 0 ? remaining : undefined,
        };
        if (
          !newState.metadata?.pendingUnresolvedToolErrors &&
          newState.toolManifestMap?.[UNRESOLVED_TOOL_IDENTIFIER]
        ) {
          const cleanedMap = { ...newState.toolManifestMap };
          delete cleanedMap[UNRESOLVED_TOOL_IDENTIFIER];
          newState.toolManifestMap = cleanedMap;
        }

        newState.messages.push({
          content: executionResult.content,
          role: 'tool',
          tool_call_id: chatToolPayload.id,
        });

        events.push({ id: chatToolPayload.id, result: executionResult, type: 'tool_result' });
        if (ctx.signal?.aborted) newState.status = 'interrupted';

        return {
          events,
          newState,
          nextContext: {
            payload: {
              data: executionResult,
              executionTime: 0,
              isSuccess: false,
              parentMessageId: payload.parentMessageId,
              toolCall: chatToolPayload,
              toolCallId: chatToolPayload.id,
            },
            phase: 'tool_result',
            session: {
              eventCount: events.length,
              messageCount: newState.messages.length,
              sessionId: operationId,
              status: 'running',
              stepCount: state.stepCount + 1,
            },
            stepUsage: {
              cost: 0,
              toolName,
              unitPrice: 0,
              usageCount: 1,
            },
          },
        };
      }

      // Check if this is a client-side function tool — pause instead of executing
      const toolSource =
        state.operationToolSet?.sourceMap?.[chatToolPayload.identifier] ??
        state.toolSourceMap?.[chatToolPayload.identifier];

      if (toolSource === 'client') {
        log(`[${operationLogId}] Client function tool detected: ${toolName}, pausing for client`);

        // Publish tool call info so streaming can emit function_call events
        await streamManager.publishStreamChunk(operationId, stepIndex, {
          chunkType: 'tools_calling',
          toolsCalling: [chatToolPayload] as any,
        });

        const newState = structuredClone(state);
        newState.lastModified = new Date().toISOString();
        newState.status = 'interrupted';
        newState.interruption = {
          canResume: true,
          interruptedAt: new Date().toISOString(),
          interruptedInstruction: instruction,
          reason: 'client_tool_execution',
        };
        newState.pendingToolsCalling = [chatToolPayload];

        return {
          events: [
            {
              canResume: true,
              interruptedAt: new Date().toISOString(),
              reason: 'client_tool_execution',
              type: 'interrupted',
            },
          ],
          newState,
          // No nextContext — loop stops, waiting for client to provide tool result
        };
      }

      // Extract toolResultMaxLength from agent config
      const agentConfig = state.metadata?.agentConfig;
      const toolResultMaxLength = agentConfig?.chatConfig?.toolResultMaxLength;

      // Build effective manifest map (operation + step-level activations)
      const effectiveManifestMap = {
        ...(state.operationToolSet?.manifestMap ?? state.toolManifestMap),
        ...Object.fromEntries(
          (state.activatedStepTools ?? [])
            .filter((a) => a.manifest)
            .map((a) => [a.id, a.manifest!]),
        ),
      };

      // Execute tool using ToolExecutionService
      log(`[${operationLogId}] Executing tool ${toolName} ...`);
      const execution = await executeToolWithRetry(
        () => {
          throwIfAborted(ctx.signal);
          return toolExecutionService.executeTool(chatToolPayload, {
            activeDeviceId: state.metadata?.activeDeviceId,
            agentId: state.metadata?.agentId,
            memoryToolPermission: agentConfig?.chatConfig?.memory?.toolPermission,
            parentMessageId: payload.parentMessageId,
            serverDB: ctx.serverDB,
            taskId: state.metadata?.taskId,
            toolManifestMap: effectiveManifestMap,
            operationId,
            dataGuardProtected:
              state.metadata?.agentConfig?.chatConfig?.deepseekDataGuardProtected === true,
            studioTextFileRequestId: state.metadata?.studioTextFileRequestId,
            studioTextFileEnabled: canWriteTextFile(state),
            studioTextFileContinueId: state.metadata?.studioTextFileContinueId,
            toolResultMaxLength,
            topicId: ctx.topicId,
            userId: ctx.userId,
          });
        },
        {
          isInterrupted: () => isOperationInterrupted(ctx),
          maxRetries: TOOL_MAX_RETRIES,
          operationLogId,
          toolName,
        },
      );

      const executionResult = execution.result;
      const executionTime = executionResult.executionTime;
      const isSuccess = executionResult.success;
      log(
        `[${operationLogId}] Executing ${toolName} in ${executionTime}ms, result: %O`,
        executionResult,
      );

      // Publish tool execution result event
      await streamManager.publishStreamEvent(operationId, {
        data: {
          executionTime,
          isSuccess,
          attempts: execution.attempts,
          maxAttempts: TOOL_MAX_RETRIES + 1,
          payload: { ...payload, toolCalling: diagnosticToolCall(payload.toolCalling) },
          phase: 'tool_execution',
          result: executionResult,
        },
        stepIndex,
        type: 'tool_end',
      });

      // Finally update database
      let toolMessageId: string | undefined;
      try {
        const toolMessage = await ctx.messageModel.create({
          agentId: state.metadata!.agentId!,
          content: executionResult.content,
          metadata: { toolExecutionTimeMs: executionTime },
          parentId: payload.parentMessageId,
          plugin: (chatToolPayload.identifier === 'arckep-text-file'
            ? { ...chatToolPayload, arguments: '{}' }
            : chatToolPayload) as any,
          pluginError: executionResult.error,
          pluginState: executionResult.state,
          role: 'tool',
          threadId: state.metadata?.threadId,
          tool_call_id: chatToolPayload.id,
          topicId: state.metadata?.topicId,
        });
        toolMessageId = toolMessage.id;
        const documentFileId = getDocumentFileId(executionResult);
        if (documentFileId) await ctx.messageModel.addFiles(toolMessage.id, [documentFileId]);
      } catch (error) {
        console.error('[StreamingToolExecutor] Failed to create tool message: %O', error);
      }

      const newState = structuredClone(state);

      if (
        chatToolPayload.identifier === 'arckep-text-file' &&
        executionResult.success &&
        executionResult.state
      )
        newState.metadata = {
          ...newState.metadata,
          studioTextFileCheckpoint: executionResult.state,
        };
      // arckep (19.10.2026): картинки из результата инструмента (блоки MCP `{type: 'image', data, fileId}`)
      // нужны ToolResultImagesProcessor на следующем шаге: после одиночного вызова состояние собирается здесь,
      // а не из базы (как в call_tools_batch), поэтому кладём в pluginState сообщения только сами блоки-картинки,
      // а не весь state инструмента — он бывает большим и раздувает состояние операции.
      const toolImages = extractToolResultImages(executionResult.state);

      newState.messages.push({
        content: executionResult.content,
        ...(toolImages.length > 0 && {
          pluginState: {
            content: toolImages.map((image) => ({
              data: image.url,
              fileId: image.fileId,
              mimeType: image.mimeType,
              type: 'image',
            })),
          },
        }),
        role: 'tool',
        tool_call_id: chatToolPayload.id,
      });

      if (newState.metadata?.studioTextFileCheckpoint)
        newState.messages = compactWriterContext(
          newState.messages,
          newState.metadata.studioTextFileRequestId,
        );
      events.push({ id: chatToolPayload.id, result: executionResult, type: 'tool_result' });

      // Get tool unit price
      const toolCost = TOOL_PRICING[toolName] || 0;

      // Use UsageCounter to uniformly accumulate tool usage
      const { usage, cost } = UsageCounter.accumulateTool({
        cost: newState.cost,
        executionTime,
        success: isSuccess,
        toolCost,
        toolName,
        usage: newState.usage,
      });

      newState.usage = usage;
      if (cost) newState.cost = cost;

      // Persist ToolsActivator discovery results to state.activatedStepTools
      const discoveredTools = executionResult.state?.activatedTools as
        Array<{ identifier: string }> | undefined;
      if (discoveredTools?.length) {
        const existingIds = new Set(
          (newState.activatedStepTools ?? []).map((t: { id: string }) => t.id),
        );
        const newActivations = discoveredTools
          .filter((t) => !existingIds.has(t.identifier))
          .map((t) => ({
            activatedAtStep: state.stepCount,
            id: t.identifier,
            manifest: effectiveManifestMap[t.identifier],
            source: 'discovery' as const,
          }));

        if (newActivations.length > 0) {
          newState.activatedStepTools = [...(newState.activatedStepTools ?? []), ...newActivations];

          log(
            `[${operationLogId}] Persisted %d tool activations to state: %o`,
            newActivations.length,
            newActivations.map((a) => a.id),
          );
        }
      }

      // Find current tool statistics
      const currentToolStats = usage.tools.byTool.find((t) => t.name === toolName);

      // Log usage information
      log(
        `[${operationLogId}][tool usage] %s: calls=%d, time=%dms, success=%s, cost=$%s`,
        toolName,
        currentToolStats?.calls || 0,
        executionTime,
        isSuccess,
        toolCost.toFixed(4),
      );

      log('[%s:%d] Tool execution completed', operationId, stepIndex);
      if (ctx.signal?.aborted) newState.status = 'interrupted';

      return {
        events,
        newState,
        nextContext: {
          payload: {
            data: executionResult,
            executionTime,
            isSuccess,
            // Pass tool message ID as parentMessageId for the next LLM call
            parentMessageId: toolMessageId,
            toolCall: chatToolPayload,
            toolCallId: chatToolPayload.id,
          },
          phase: 'tool_result',
          session: {
            eventCount: events.length,
            messageCount: newState.messages.length,
            sessionId: operationId,
            status: 'running',
            stepCount: state.stepCount + 1,
          },
          stepUsage: {
            cost: toolCost,
            toolName,
            unitPrice: toolCost,
            usageCount: 1,
          },
        },
      };
    } catch (error) {
      if (ctx.signal?.aborted) return { events, newState: { ...state, status: 'interrupted' } };
      // Publish tool execution error event
      await streamManager.publishStreamEvent(operationId, {
        data: formatErrorEventData(error, 'tool_execution'),
        stepIndex,
        type: 'error',
      });

      events.push({ error, type: 'error' });

      console.error(
        `[StreamingToolExecutor] Tool execution failed for operation ${operationId}:${stepIndex}:`,
        error,
      );

      return {
        events,
        newState: state, // State unchanged
      };
    }
  },

  /**
   * Batch tool execution with database sync
   * Executes multiple tools concurrently and refreshes messages from database after completion
   */
  call_tools_batch: async (instruction, state) => {
    const { payload } = instruction as Extract<AgentInstruction, { type: 'call_tools_batch' }>;
    const { parentMessageId, toolsCalling } = payload;
    const { operationId, stepIndex, streamManager, toolExecutionService } = ctx;
    const events: AgentEvent[] = [];
    if (ctx.signal?.aborted) return { events, newState: { ...state, status: 'interrupted' } };

    const operationLogId = `${operationId}:${stepIndex}`;
    log(
      `[${operationLogId}][call_tools_batch] Starting batch execution for ${toolsCalling.length} tools`,
    );

    // Split client vs server tools
    const clientTools: ChatToolPayload[] = [];
    const serverTools: ChatToolPayload[] = [];
    for (const tp of toolsCalling) {
      const src =
        state.operationToolSet?.sourceMap?.[tp.identifier] ?? state.toolSourceMap?.[tp.identifier];
      if (src === 'client') {
        clientTools.push(tp);
      } else {
        serverTools.push(tp);
      }
    }

    // If all tools are client-side, pause immediately
    if (clientTools.length > 0 && serverTools.length === 0) {
      log(
        `[${operationLogId}][call_tools_batch] All ${clientTools.length} tools are client-side, pausing`,
      );

      await streamManager.publishStreamChunk(operationId, stepIndex, {
        chunkType: 'tools_calling',
        toolsCalling: clientTools as any,
      });

      const newState = structuredClone(state);
      newState.lastModified = new Date().toISOString();
      newState.status = 'interrupted';
      newState.interruption = {
        canResume: true,
        interruptedAt: new Date().toISOString(),
        reason: 'client_tool_execution',
      };
      newState.pendingToolsCalling = clientTools;

      return {
        events: [
          {
            canResume: true,
            interruptedAt: new Date().toISOString(),
            reason: 'client_tool_execution',
            type: 'interrupted',
          },
        ],
        newState,
      };
    }

    // Track all tool message IDs created during execution
    const toolMessageIds: string[] = [];
    const toolResults: any[] = [];

    // Execute server tools concurrently (skip client tools in mixed batch)
    const toolsToExecute = serverTools.length > 0 ? serverTools : toolsCalling;
    const consumedUnresolvedIds: string[] = [];
    await Promise.all(
      toolsToExecute.map(async (chatToolPayload: ChatToolPayload) => {
        const toolName = `${chatToolPayload.identifier}/${chatToolPayload.apiName}`;

        if (chatToolPayload.identifier === UNRESOLVED_TOOL_IDENTIFIER) {
          const errorMessage =
            state.metadata?.pendingUnresolvedToolErrors?.[chatToolPayload.id] ??
            `Tool "${chatToolPayload.apiName}" is not available in this step.`;
          const executionResult: ToolExecutionResultResponse = {
            content: JSON.stringify({ error: errorMessage, success: false, synthetic: true }),
            error: { message: errorMessage, type: 'ToolNotFound' },
            executionTime: 0,
            state: undefined,
            success: false,
          };
          consumedUnresolvedIds.push(chatToolPayload.id);

          // Never write __arckep_unresolved_tool__ tool rows to PostgreSQL; keep synthetic feedback in memory only.
          toolResults.push({
            data: executionResult,
            executionTime: 0,
            isSuccess: false,
            synthetic: true,
            toolCall: chatToolPayload,
            toolCallId: chatToolPayload.id,
          });
          events.push({ id: chatToolPayload.id, result: executionResult, type: 'tool_result' });
          return;
        }

        // Publish tool execution start event
        await streamManager.publishStreamEvent(operationId, {
          data: { parentMessageId, toolCalling: diagnosticToolCall(chatToolPayload) },
          stepIndex,
          type: 'tool_start',
        });

        try {
          log(`[${operationLogId}] Executing tool ${toolName} ...`);
          // Build effective manifest map (operation + step-level activations)
          const batchManifestMap = {
            ...(state.operationToolSet?.manifestMap ?? state.toolManifestMap),
            ...Object.fromEntries(
              (state.activatedStepTools ?? [])
                .filter((a) => a.manifest)
                .map((a) => [a.id, a.manifest!]),
            ),
          };

          const batchAgentConfig = state.metadata?.agentConfig;

          const execution = await executeToolWithRetry(
            () => {
              throwIfAborted(ctx.signal);
              return toolExecutionService.executeTool(chatToolPayload, {
                activeDeviceId: state.metadata?.activeDeviceId,
                agentId: state.metadata?.agentId,
                memoryToolPermission: batchAgentConfig?.chatConfig?.memory?.toolPermission,
                parentMessageId,
                serverDB: ctx.serverDB,
                taskId: state.metadata?.taskId,
                toolManifestMap: batchManifestMap,
                operationId,
                dataGuardProtected:
                  state.metadata?.agentConfig?.chatConfig?.deepseekDataGuardProtected === true,
                studioTextFileRequestId: state.metadata?.studioTextFileRequestId,
                studioTextFileEnabled: canWriteTextFile(state),
                studioTextFileContinueId: state.metadata?.studioTextFileContinueId,
                toolResultMaxLength: batchAgentConfig?.chatConfig?.toolResultMaxLength,
                topicId: ctx.topicId,
                userId: ctx.userId,
              });
            },
            {
              isInterrupted: () => isOperationInterrupted(ctx),
              maxRetries: TOOL_MAX_RETRIES,
              operationLogId,
              toolName,
            },
          );

          const executionResult = execution.result;
          const executionTime = executionResult.executionTime;
          const isSuccess = executionResult.success;
          log(
            `[${operationLogId}] Executed ${toolName} in ${executionTime}ms, success: ${isSuccess}`,
          );

          // Publish tool execution result event
          await streamManager.publishStreamEvent(operationId, {
            data: {
              executionTime,
              isSuccess,
              attempts: execution.attempts,
              maxAttempts: TOOL_MAX_RETRIES + 1,
              payload: { parentMessageId, toolCalling: diagnosticToolCall(chatToolPayload) },
              phase: 'tool_execution',
              result: executionResult,
            },
            stepIndex,
            type: 'tool_end',
          });

          // Create tool message in database
          try {
            const toolMessage = await ctx.messageModel.create({
              agentId: state.metadata!.agentId!,
              content: executionResult.content,
              metadata: { toolExecutionTimeMs: executionTime },
              parentId: parentMessageId,
              plugin: (chatToolPayload.identifier === 'arckep-text-file'
                ? { ...chatToolPayload, arguments: '{}' }
                : chatToolPayload) as any,
              pluginError: executionResult.error,
              pluginState: executionResult.state,
              role: 'tool',
              threadId: state.metadata?.threadId,
              tool_call_id: chatToolPayload.id,
              topicId: state.metadata?.topicId,
            });
            toolMessageIds.push(toolMessage.id);
            const documentFileId = getDocumentFileId(executionResult);
            if (documentFileId) await ctx.messageModel.addFiles(toolMessage.id, [documentFileId]);
            log(`[${operationLogId}] Created tool message ${toolMessage.id} for ${toolName}`);
          } catch (error) {
            console.error(
              `[${operationLogId}] Failed to create tool message for ${toolName}:`,
              error,
            );
          }

          // Collect tool result
          toolResults.push({
            data: executionResult,
            executionTime,
            isSuccess,
            toolCall: chatToolPayload,
            toolCallId: chatToolPayload.id,
          });

          events.push({ id: chatToolPayload.id, result: executionResult, type: 'tool_result' });

          // Collect per-tool usage for post-batch accumulation
          const toolCost = TOOL_PRICING[toolName] || 0;
          toolResults.at(-1).usageParams = {
            executionTime,
            success: isSuccess,
            toolCost,
            toolName,
          };
        } catch (error) {
          if (ctx.signal?.aborted) return;
          console.error(`[${operationLogId}] Tool execution failed for ${toolName}:`, error);

          // Publish error event
          await streamManager.publishStreamEvent(operationId, {
            data: formatErrorEventData(error, 'tool_execution'),
            stepIndex,
            type: 'error',
          });

          events.push({ error, type: 'error' });
        }
      }),
    );

    log(
      `[${operationLogId}][call_tools_batch] All tools executed, created ${toolMessageIds.length} tool messages`,
    );

    // Accumulate tool usage sequentially after all tools have finished
    const newState = structuredClone(state);
    if (consumedUnresolvedIds.length > 0) {
      const remaining = { ...newState.metadata?.pendingUnresolvedToolErrors };
      for (const id of consumedUnresolvedIds) {
        delete remaining[id];
      }
      newState.metadata = {
        ...newState.metadata,
        deliverUnresolvedToolFeedback: true,
        pendingUnresolvedToolErrors: Object.keys(remaining).length > 0 ? remaining : undefined,
      };
      if (
        !newState.metadata?.pendingUnresolvedToolErrors &&
        newState.toolManifestMap?.[UNRESOLVED_TOOL_IDENTIFIER]
      ) {
        const cleanedMap = { ...newState.toolManifestMap };
        delete cleanedMap[UNRESOLVED_TOOL_IDENTIFIER];
        newState.toolManifestMap = cleanedMap;
      }
    }
    for (const result of toolResults) {
      if (
        result.toolCall.identifier === 'arckep-text-file' &&
        result.data.success &&
        result.data.state
      )
        newState.metadata = { ...newState.metadata, studioTextFileCheckpoint: result.data.state };
      if (result.usageParams) {
        const { usage, cost } = UsageCounter.accumulateTool({
          ...result.usageParams,
          cost: newState.cost,
          usage: newState.usage,
        });
        newState.usage = usage;
        if (cost) newState.cost = cost;
      }
    }

    // Persist ToolsActivator discovery results from batch tool executions
    const batchEffectiveManifestMap = {
      ...(state.operationToolSet?.manifestMap ?? state.toolManifestMap),
      ...Object.fromEntries(
        (state.activatedStepTools ?? []).filter((a) => a.manifest).map((a) => [a.id, a.manifest!]),
      ),
    };
    const existingActivationIds = new Set(
      (newState.activatedStepTools ?? []).map((t: { id: string }) => t.id),
    );
    for (const result of toolResults) {
      const discovered = result.data?.state?.activatedTools as
        Array<{ identifier: string }> | undefined;
      if (discovered?.length) {
        const newActivations = discovered
          .filter((t) => !existingActivationIds.has(t.identifier))
          .map((t) => ({
            activatedAtStep: state.stepCount,
            id: t.identifier,
            manifest: batchEffectiveManifestMap[t.identifier],
            source: 'discovery' as const,
          }));

        for (const activation of newActivations) {
          existingActivationIds.add(activation.id);
        }

        if (newActivations.length > 0) {
          newState.activatedStepTools = [...(newState.activatedStepTools ?? []), ...newActivations];
        }
      }
    }

    if (newState.metadata?.studioTextFileCheckpoint) {
      // This operation has a committed source. Keep only its active user turn; a full topic
      // reload would reintroduce every prior tool dump and discard the exact continuation tail.
      for (const { data, toolCallId } of toolResults) {
        const images = extractToolResultImages(data.state);
        newState.messages.push({
          role: 'tool',
          tool_call_id: toolCallId,
          content: data.content,
          ...(images.length
            ? {
                pluginState: {
                  content: images.map((image) => ({
                    type: 'image',
                    data: image.url,
                    fileId: image.fileId,
                    mimeType: image.mimeType,
                  })),
                },
              }
            : {}),
        });
      }
      newState.messages = compactWriterContext(
        newState.messages,
        newState.metadata.studioTextFileRequestId,
      );
    } else if (toolMessageIds.length === 0 && toolResults.some((r) => r.synthetic)) {
      // Purely synthetic unresolved batch: no DB tool rows were written, keep in-memory messages intact
      for (const syn of toolResults.filter((r) => r.synthetic)) {
        newState.messages.push({
          content: syn.data.content,
          role: 'tool',
          tool_call_id: syn.toolCallId,
        });
      }
    } else {
      // Refresh messages from database to ensure state is in sync

      // Query latest messages from database
      // Must pass agentId to ensure correct query scope, otherwise when topicId is undefined,
      // the query will use isNull(topicId) condition which won't find messages with actual topicId
      // arckep (24.10.2026): pass postProcessUrl so imageList/fileList S3 keys (files/user_...) are resolved
      // to presigned URLs instead of breaking subsequent OpenRouter/vision LLM steps with HTTP 400 Invalid URL format.
      const fileService =
        ctx.serverDB && ctx.userId ? new FileService(ctx.serverDB, ctx.userId) : undefined;
      const postProcessUrl = fileService
        ? (path: string | null) => fileService.getFullFileUrl(path)
        : undefined;
      const latestMessages = await ctx.messageModel.query(
        {
          agentId: state.metadata?.agentId,
          threadId: state.metadata?.threadId,
          topicId: state.metadata?.topicId,
        },
        postProcessUrl ? { postProcessUrl } : undefined,
      );

      // Use conversation-flow parse to resolve branching into linear flat list
      // parse() handles assistantGroup, compare, supervisor, etc. virtual message types
      const { flatList } = parse(latestMessages);
      newState.messages = hydrateGroupMessages(flatList, latestMessages);

      const syntheticResults = toolResults.filter((r) => r.synthetic);
      if (syntheticResults.length > 0) {
        if (newState.messages.length === 0 && state.messages.length > 0) {
          newState.messages = structuredClone(state.messages);
        }

        // Inject synthetic tool calls + results into hydrated assistantGroup child (or flat assistant)
        // so Step 1's GroupMessageFlatten + ToolCallProcessor + ToolMessageReorder pair them in memory
        // without ever persisting __arckep_unresolved_tool__ to PostgreSQL.
        let attachedToGroup = false;
        for (let i = newState.messages.length - 1; i >= 0; i--) {
          const msg: any = newState.messages[i];
          if (
            msg?.role === 'assistantGroup' &&
            Array.isArray(msg.children) &&
            msg.children.length > 0
          ) {
            const targetChild =
              msg.children.find((c: any) => c?.id === parentMessageId) ?? msg.children.at(-1);
            if (targetChild) {
              const existingIds = new Set(
                (Array.isArray(targetChild.tools) ? targetChild.tools : []).map((t: any) => t?.id),
              );
              const appendedTools = syntheticResults
                .filter((syn) => !existingIds.has(syn.toolCallId))
                .map((syn) => ({
                  ...syn.toolCall,
                  result: {
                    content: syn.data.content,
                    id: `synthetic-${syn.toolCallId}`,
                  },
                }));
              targetChild.tools = [...(targetChild.tools ?? []), ...appendedTools];
              attachedToGroup = true;
              break;
            }
          }
        }

        if (!attachedToGroup) {
          const resolver = new ToolNameResolver();
          const targetAssistant =
            newState.messages.findLast(
              (m: any) => m?.role === 'assistant' && (!parentMessageId || m.id === parentMessageId),
            ) ?? newState.messages.findLast((m: any) => m?.role === 'assistant');
          if (targetAssistant) {
            if (Array.isArray((targetAssistant as any).tools)) {
              const seenTools = new Set((targetAssistant as any).tools.map((t: any) => t?.id));
              for (const syn of syntheticResults) {
                if (!seenTools.has(syn.toolCallId)) {
                  (targetAssistant as any).tools.push(syn.toolCall);
                }
              }
            }
            if (Array.isArray(targetAssistant.tool_calls)) {
              const seenCalls = new Set(targetAssistant.tool_calls.map((tc: any) => tc?.id));
              for (const syn of syntheticResults) {
                if (!seenCalls.has(syn.toolCallId)) {
                  targetAssistant.tool_calls.push({
                    function: {
                      arguments: '{}',
                      name: resolver.generate(
                        syn.toolCall.identifier,
                        syn.toolCall.apiName,
                        syn.toolCall.type,
                      ),
                    },
                    id: syn.toolCallId,
                    type: 'function',
                  });
                }
              }
            }
          }

          const existingToolCallIds = new Set(
            newState.messages
              .filter((m: any) => m.role === 'tool' && m.tool_call_id)
              .map((m: any) => m.tool_call_id),
          );
          for (const syn of syntheticResults) {
            if (!existingToolCallIds.has(syn.toolCallId)) {
              newState.messages.push({
                content: syn.data.content,
                role: 'tool',
                tool_call_id: syn.toolCallId,
              });
            }
          }
        }
      }

      log(
        `[${operationLogId}][call_tools_batch] Refreshed ${newState.messages.length} messages from database`,
      );
    }

    // Get the last tool message ID as parentMessageId for next LLM call
    const lastToolMessageId = toolMessageIds.at(-1);

    // If there are remaining client tools in a mixed batch, interrupt after server tools
    if (ctx.signal?.aborted) return { events, newState: { ...newState, status: 'interrupted' } };
    if (clientTools.length > 0) {
      log(
        `[${operationLogId}][call_tools_batch] Mixed batch: ${serverTools.length} server tools done, pausing for ${clientTools.length} client tools`,
      );

      await streamManager.publishStreamChunk(operationId, stepIndex, {
        chunkType: 'tools_calling',
        toolsCalling: clientTools as any,
      });

      newState.status = 'interrupted';
      newState.interruption = {
        canResume: true,
        interruptedAt: new Date().toISOString(),
        reason: 'client_tool_execution',
      };
      newState.pendingToolsCalling = clientTools;

      return {
        events: [
          ...events,
          {
            canResume: true,
            interruptedAt: new Date().toISOString(),
            reason: 'client_tool_execution',
            type: 'interrupted',
          },
        ],
        newState,
      };
    }

    return {
      events,
      newState,
      nextContext: {
        payload: {
          parentMessageId: lastToolMessageId ?? parentMessageId,
          toolCount: toolsCalling.length,
          toolResults,
        },
        phase: 'tools_batch_result',
        session: {
          eventCount: events.length,
          messageCount: newState.messages.length,
          sessionId: operationId,
          status: 'running',
          stepCount: state.stepCount + 1,
        },
      },
    };
  },

  /**
   * Complete runtime execution
   */
  finish: async (instruction, state) => {
    const { reason, reasonDetail } = instruction as Extract<AgentInstruction, { type: 'finish' }>;
    const { operationId, stepIndex, streamManager } = ctx;

    log('[%s:%d] Finishing execution: (%s)', operationId, stepIndex, reason);

    // Publish execution complete event
    await streamManager.publishStreamEvent(operationId, {
      data: {
        finalState: { ...state, status: 'done' },
        phase: 'execution_complete',
        reason,
        reasonDetail,
      },
      stepIndex,
      type: 'step_complete',
    });

    const newState = structuredClone(state);
    newState.lastModified = new Date().toISOString();
    newState.status = 'done';
    if (newState.metadata?.studioTextFileCheckpoint)
      newState.metadata.studioTextFileFinish = reason;

    const events: AgentEvent[] = [
      {
        finalState: newState,
        reason,
        reasonDetail,
        type: 'done',
      },
    ];

    return { events, newState };
  },

  /**
   * Human approval
   */
  request_human_approve: async (instruction, state) => {
    const { pendingToolsCalling } = instruction as Extract<
      AgentInstruction,
      { type: 'request_human_approve' }
    >;
    const { operationId, stepIndex, streamManager } = ctx;

    log(
      '[%s:%d] Requesting human approval for %O',
      operationId,
      stepIndex,
      pendingToolsCalling.map(diagnosticToolCall),
    );

    // Publish human approval request event
    await streamManager.publishStreamEvent(operationId, {
      data: {
        pendingToolsCalling,
        phase: 'human_approval',
        requiresApproval: true,
      },
      stepIndex,
      type: 'step_start',
    });

    const newState = structuredClone(state);
    newState.lastModified = new Date().toISOString();
    newState.status = 'waiting_for_human';
    newState.pendingToolsCalling = pendingToolsCalling;

    // Notify frontend to display approval UI through streaming system
    await streamManager.publishStreamChunk(operationId, stepIndex, {
      // Use operationId as messageId
      chunkType: 'tools_calling',
      toolsCalling: pendingToolsCalling as any,
    });

    const events: AgentEvent[] = [
      {
        operationId,
        pendingToolsCalling,
        type: 'human_approve_required',
      },
      {
        // Note: pendingToolsCalling is ChatToolPayload[] but AgentEventToolPending expects ToolsCalling[]
        // This is intentional for display purposes in the frontend
        toolCalls: pendingToolsCalling as any,
        type: 'tool_pending',
      },
    ];

    log('Human approval requested for operation %s:%d', operationId, stepIndex);

    return {
      events,
      newState,
      // Do not provide nextContext as it requires waiting for human intervention
    };
  },

  /**
   * Resolve aborted tool calls
   * Create tool messages with 'aborted' intervention status for canceled tool calls
   */
  resolve_aborted_tools: async (instruction, state) => {
    const { payload } = instruction as Extract<AgentInstruction, { type: 'resolve_aborted_tools' }>;
    const { parentMessageId, toolsCalling } = payload;
    const { operationId, stepIndex, streamManager } = ctx;
    const events: AgentEvent[] = [];

    log('[%s:%d] Resolving %d aborted tools', operationId, stepIndex, toolsCalling.length);

    // Publish tool cancellation event
    await streamManager.publishStreamEvent(operationId, {
      data: {
        parentMessageId,
        phase: 'tools_aborted',
        toolsCalling,
      },
      stepIndex,
      type: 'step_start',
    });

    const newState = structuredClone(state);

    // Create tool message for each canceled tool call
    for (const toolPayload of toolsCalling) {
      const toolName = `${toolPayload.identifier}/${toolPayload.apiName}`;
      log('[%s:%d] Creating aborted tool message for %s', operationId, stepIndex, toolName);

      try {
        const toolMessage = await ctx.messageModel.create({
          agentId: state.metadata!.agentId!,
          content: 'Tool execution was aborted by user.',
          parentId: parentMessageId,
          plugin: toolPayload as any,
          pluginIntervention: { status: 'aborted' },
          role: 'tool',
          threadId: state.metadata?.threadId,
          tool_call_id: toolPayload.id,
          topicId: state.metadata?.topicId,
        });

        log(
          '[%s:%d] Created aborted tool message: %s for %s',
          operationId,
          stepIndex,
          toolMessage.id,
          toolName,
        );

        // Update state messages
        newState.messages.push({
          content: 'Tool execution was aborted by user.',
          role: 'tool',
          tool_call_id: toolPayload.id,
        });
      } catch (error) {
        console.error(
          '[resolve_aborted_tools] Failed to create aborted tool message for %s: %O',
          toolName,
          error,
        );
      }
    }

    log('[%s:%d] All aborted tool messages created', operationId, stepIndex);

    // Mark status as complete
    newState.lastModified = new Date().toISOString();
    newState.status = 'done';

    // Publish completion event
    await streamManager.publishStreamEvent(operationId, {
      data: {
        finalState: newState,
        phase: 'execution_complete',
        reason: 'user_aborted',
        reasonDetail: 'User aborted operation with pending tool calls',
      },
      stepIndex,
      type: 'step_complete',
    });

    events.push({
      finalState: newState,
      reason: 'user_aborted',
      reasonDetail: 'User aborted operation with pending tool calls',
      type: 'done',
    });

    return { events, newState };
  },
});
