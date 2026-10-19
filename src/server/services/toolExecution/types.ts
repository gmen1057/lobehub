import { type LobeToolManifest } from '@lobechat/context-engine';
import { type LobeChatDatabase } from '@lobechat/database';
import { type ChatToolPayload } from '@lobechat/types';

export interface ToolExecutionContext {
  /** Target device ID for device proxy tool calls */
  activeDeviceId?: string;
  /** Agent ID executing the tool call */
  agentId?: string;
  /** Memory tool permission from agent chat config */
  memoryToolPermission?: 'read-only' | 'read-write';
  /** Tool result message ID when known */
  messageId?: string;
  /**
   * arckep (19.10.2026): сообщение ассистента, которое вызвало инструмент. Его текст хода уже в базе (call_llm
   * сохраняет его до вызова инструментов), а модель и поставщик хода лежат в его записи: по ним инструмент
   * сверки с макетом (`arckep-layout`) находит последнюю версию письма и зовёт ту же модель со списанием в эту тему.
   */
  parentMessageId?: string;
  /** Server database for LobeHub Skills execution */
  serverDB?: LobeChatDatabase;
  /** Task ID when executing within the Task system */
  taskId?: string;
  toolCallId?: string;
  toolManifestMap: Record<string, LobeToolManifest>;
  /**
   * Maximum length for tool execution result content (in characters)
   * @default 6000
   */
  toolResultMaxLength?: number;
  /** Topic ID for sandbox session management */
  topicId?: string;
  userId?: string;
}

export interface ToolExecutionResult {
  content: string;
  error?: any;
  state?: Record<string, any>;
  success: boolean;
}

export interface ToolExecutionResultResponse extends ToolExecutionResult {
  executionTime: number;
}

export interface IToolExecutor {
  execute: (
    payload: ChatToolPayload,
    context: ToolExecutionContext,
  ) => Promise<ToolExecutionResult>;
}
