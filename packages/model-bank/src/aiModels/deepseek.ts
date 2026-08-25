import type { AIChatModelCard } from '../types/aiModel';

// https://api-docs.deepseek.com/zh-cn/quick_start/pricing
const deepseekChatModels: AIChatModelCard[] = [
  // arckep: DeepSeek V4 Flash Vision (2026-08-25) — USD peak cache-miss, separate from text-only flash
  {
    abilities: {
      functionCall: true,
      reasoning: true,
      vision: true,
    },
    contextWindowTokens: 1_000_000,
    description:
      'Понимает изображения (текст + фото → текст). На тексте — как V4 Flash. 1M контекст.',
    displayName: 'DeepSeek V4 Flash Vision',
    enabled: true,
    id: 'deepseek-v4-flash-vision-exp',
    pricing: {
      currency: 'USD',
      units: [
        { name: 'textInput', rate: 0.44, strategy: 'fixed', unit: 'millionTokens' },
        { name: 'textOutput', rate: 1.32, strategy: 'fixed', unit: 'millionTokens' },
      ],
    },
    releasedAt: '2026-08-25',
    type: 'chat',
  },
  {
    abilities: {
      functionCall: true,
      structuredOutput: true,
    },
    contextWindowTokens: 131_072,
    description:
      'DeepSeek V3.2 is DeepSeek’s latest general model with a hybrid reasoning architecture and stronger agent capabilities.',
    displayName: 'DeepSeek V3.2',
    enabled: true,
    id: 'deepseek-chat',
    maxOutput: 8192,
    pricing: {
      currency: 'CNY',
      units: [
        { name: 'textInput_cacheRead', rate: 0.2, strategy: 'fixed', unit: 'millionTokens' },
        { name: 'textInput', rate: 2, strategy: 'fixed', unit: 'millionTokens' },
        { name: 'textOutput', rate: 3, strategy: 'fixed', unit: 'millionTokens' },
      ],
    },
    releasedAt: '2025-12-01',
    type: 'chat',
  },
  {
    abilities: {
      functionCall: true,
      reasoning: true,
    },
    contextWindowTokens: 131_072,
    description:
      'DeepSeek V3.2 thinking mode outputs a chain-of-thought before the final answer to improve accuracy.',
    displayName: 'DeepSeek V3.2 Thinking',
    enabled: true,
    id: 'deepseek-reasoner',
    maxOutput: 65_536,
    pricing: {
      currency: 'CNY',
      units: [
        { name: 'textInput_cacheRead', rate: 0.2, strategy: 'fixed', unit: 'millionTokens' },
        { name: 'textInput', rate: 2, strategy: 'fixed', unit: 'millionTokens' },
        { name: 'textOutput', rate: 3, strategy: 'fixed', unit: 'millionTokens' },
      ],
    },
    releasedAt: '2025-12-01',
    type: 'chat',
  },
];

export const allModels = [...deepseekChatModels];

export default allModels;
