import { DEFAULT_PROVIDER } from '@lobechat/business-const';
import {
  type LobeAgentChatConfig,
  type LobeAgentConfig,
  type LobeAgentTTSConfig,
  type UserDefaultAgent,
} from '@lobechat/types';

import { DEFAULT_AGENT_META } from '../meta';
import { DEFAULT_MODEL } from './llm';

export const DEFAUTT_AGENT_TTS_CONFIG: LobeAgentTTSConfig = {
  showAllLocaleVoice: false,
  sttLocale: 'auto',
  ttsService: 'openai',
  voice: {
    openai: 'alloy',
  },
};

export const DEFAULT_AGENT_SEARCH_FC_MODEL = {
  model: DEFAULT_MODEL,
  provider: DEFAULT_PROVIDER,
};

export const DEFAULT_AGENT_CHAT_CONFIG: LobeAgentChatConfig = {
  autoCreateTopicThreshold: 2,
  enableAutoCreateTopic: true,
  enableCompressHistory: true,
  enableContextCompression: true,
  enableHistoryCount: false,
  enableReasoning: false,
  enableStreaming: true,
  historyCount: 20,
  reasoningBudgetToken: 1024,
  searchFCModel: DEFAULT_AGENT_SEARCH_FC_MODEL,
  searchMode: 'auto',
};

// arckep: default agent system prompt positions the assistant as Arckep helper,
// encourages use of the lobe-memory tool for cross-topic persistence, and hints
// at the studio for image/video generation (our main product).
const ARCKEP_DEFAULT_SYSTEM_ROLE = `Ты — Arckep Помощник, русскоязычный AI-ассистент платформы Arckep AI.

Твоя роль:
- Помогаешь с творческими задачами, анализом, кодом, планированием, повседневными вопросами
- Отвечаешь на том языке, на котором пишет пользователь (по умолчанию русский)
- Коротко и по делу, без лишней воды

Важно о памяти между чатами:
- Ты работаешь через инструмент памяти (lobe-memory). Когда узнаёшь важные факты о пользователе (имя, профессия, проект, предпочтения, задачи) — сохраняй их через этот инструмент. В следующих чатах ты сможешь их вспомнить.
- Если пользователь спрашивает "помнишь ли ты что-то" — проверь memory. Если там пусто, честно скажи что в этом новом чате памяти пока нет, но предложи сохранить важное на будущее.
- Каждый отдельный чат (топик) — это как отдельная вкладка разговора. Но благодаря memory, ты сохраняешь преемственность знаний о пользователе между ними.

Генерация контента:
- Если пользователь просит создать изображение или видео — ты можешь сделать это прямо в чате (через встроенные Gemini/Imagen модели), ИЛИ порекомендовать полноценную студию с 19+ моделями на https://arckep.ru/studio, где есть точная настройка, референсы, upscale и т.д.
- Для простых запросов — генерируй в чате. Для сложных или когда нужен контроль — отправляй в студию.`;

export const DEFAULT_AGENT_CONFIG: LobeAgentConfig = {
  chatConfig: DEFAULT_AGENT_CHAT_CONFIG,
  model: DEFAULT_MODEL,
  openingQuestions: [],
  params: {
    frequency_penalty: 0,
    presence_penalty: 0,
    temperature: 1,
    top_p: 1,
  },
  // arckep: enable lobe-memory plugin by default so new agents have
  // cross-topic memory out of the box (matches user expectation that
  // "my assistant should remember things across chats")
  plugins: ['lobe-user-memory'],
  provider: DEFAULT_PROVIDER,
  systemRole: ARCKEP_DEFAULT_SYSTEM_ROLE,
  tts: DEFAUTT_AGENT_TTS_CONFIG,
};

export const DEFAULT_AGENT: UserDefaultAgent = {
  config: DEFAULT_AGENT_CONFIG,
  meta: DEFAULT_AGENT_META,
};
