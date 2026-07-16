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
  // arckep: prefer provider/model native web search when globe is on
  // (OpenAI/Anthropic/Google/xAI/Qwen/OpenRouter). No app-layer SEARCH_PROVIDERS.
  useModelBuiltinSearch: true,
};

// arckep: short helper-agent prompt for chat.arckep.ru. Trimmed from ~800 to
// ~150 tokens to cut per-request cost. Memory + studio links live in tool
// descriptions / UI hints — no need to repeat them in every system message.
const ARCKEP_DEFAULT_SYSTEM_ROLE = `Ты — помощник Arckep AI на chat.arckep.ru. Отвечай на языке пользователя (по умолчанию русский), коротко и по делу. Если узнал что-то важное о собеседнике — сохрани через lobe-memory. Для генерации изображений и видео есть студия на arckep.ru/studio.`;

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
  // arckep: enable lobe-memory + lobe-artifacts by default. Memory gives
  // cross-topic recall; artifacts give the 205-line system prompt that
  // teaches every model (gpt-5.5, Claude, Gemini, Grok) to wrap SVG/HTML/
  // React output in <lobeArtifact> tags so the artifacts portal renders them
  // safely. Without artifacts skill, models fall back to raw <img data:...>
  // which markdown blocks for XSS reasons. Cost: ~1.5K extra prompt tokens
  // per request (~0.83 RUB on gpt-5.5).
  plugins: ['lobe-user-memory', 'lobe-artifacts', 'arckep-sites'],
  provider: DEFAULT_PROVIDER,
  systemRole: ARCKEP_DEFAULT_SYSTEM_ROLE,
  tts: DEFAUTT_AGENT_TTS_CONFIG,
};

export const DEFAULT_AGENT: UserDefaultAgent = {
  config: DEFAULT_AGENT_CONFIG,
  meta: DEFAULT_AGENT_META,
};
