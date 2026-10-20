import type { ModelUsage } from '@lobechat/types';

import type { ChatCompletionTool } from './chat';

interface GenerateObjectMessage {
  content: string;
  name?: string;
  role: 'user' | 'system' | 'assistant';
}

export interface GenerateObjectSchema {
  description?: string;
  name: string;
  schema: {
    additionalProperties?: boolean;
    properties: Record<string, any>;
    required?: string[];
    type: 'object';
  };
  strict?: boolean;
}

export interface GenerateObjectPayload {
  messages: GenerateObjectMessage[];
  model: string;
  /**
   * arckep (20.10.2026): ступень рассуждений для моделей, которые думают (OpenAI `reasoning.effort` /
   * `reasoning_effort`). Не задано — по умолчанию провайдера (у GPT-6 Luna это `medium`).
   */
  reasoningEffort?: string;
  responseApi?: boolean;
  schema?: GenerateObjectSchema;
  /**
   * arckep (20.10.2026): OpenAI `service_tier` (`flex` — цена Batch, ответ медленнее, бывает 429 «нет мощностей»,
   * за который не берут денег). Не задано — обычная обработка.
   */
  serviceTier?: string;
  tools?: ChatCompletionTool[];
}

export interface GenerateObjectOptions {
  /**
   * response headers
   */
  headers?: Record<string, any>;

  /** Metadata passed to hooks (billing, tracing, etc.) */
  metadata?: Record<string, unknown>;

  onUsage?: (usage: ModelUsage) => void | Promise<void>;

  signal?: AbortSignal;
  /**
   * userId for the GenerateObject
   */
  user?: string;
}
