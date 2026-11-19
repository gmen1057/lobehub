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
  // arckep: Wave 4 on for the default helper (owner 2026-09-08).
  enableSitesAutoContinue: true,
  enableStreaming: true,
  historyCount: 20,
  reasoningBudgetToken: 1024,
  searchFCModel: DEFAULT_AGENT_SEARCH_FC_MODEL,
  searchMode: 'auto',
  // arckep: prefer provider/model native web search when globe is on
  // (OpenAI/Anthropic/Google/xAI/Qwen/OpenRouter). No app-layer SEARCH_PROVIDERS.
  useModelBuiltinSearch: true,
};

// arckep: shared default assistant prompt. Tool descriptions are supplied separately;
// situational rules (PDF mockup <layout>/checkLayout, attached-file translation, Figma playbook)
// are injected conditionally by ArckepConditionalRulesProvider only when relevant context exists.
const ARCKEP_DEFAULT_SYSTEM_ROLE = `Ты — помощник Arckep AI на chat.arckep.ru. Отвечай на языке пользователя (по умолчанию русский), коротко и по делу. Важное о собеседнике сохраняй в lobe-user-memory (если он в <available_tools> — сначала activateTools).

Используй только активные инструменты и <available_tools>: отключённое пользователем не включай сам; если нужного нет, предложи включить через «+» в чате. Генерацию в «Студии» делай здесь (не отправляй «в студию» и не переключайся на Nano Banana / image-модели для чата): для mcp-arckep-studio-images, -3d, -speech, -presentations сразу create_* (estimate_* — только если пользователь спрашивает цену); для mcp-arckep-studio-video и mcp-arckep-studio-higgsfield сначала estimate_* и подтверждение дороже 20 ₽.

A finished HTML page, email, landing page or SVG always goes into a <lobeArtifact type="text/html" …> block (type="image/svg+xml" for a standalone SVG), never into a code block. Images in HTML: use <attachments> or create_image / get_image URLs (placeholder only when no suitable picture exists). Fonts: Google Fonts by a direct link; any other font — download in sandbox, save as a chat file (/chat/f/…) and load via @font-face.`;

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
  // arckep: enable lobe-user-memory + lobe-artifacts by default. Memory gives
  // cross-topic recall; artifacts give the 205-line system prompt that
  // teaches every model (gpt-5.5, Claude, Gemini, Grok) to wrap SVG/HTML/
  // React output in <lobeArtifact> tags so the artifacts portal renders them
  // safely. Without artifacts skill, models fall back to raw <img data:...>
  // which markdown blocks for XSS reasons.
  // Measured 2026-10-13 (Gemini countTokens): memory tool ~8.0K tokens, arckep-sites ~4.6K,
  // artifacts ~2.2K per request — not ~1.5K. Memory and arckep-sites are therefore in
  // arckepLazyToolIds (@lobechat/builtin-tools): the web chat lists them in <available_tools>
  // and the model activates them on demand; memory recall is injected either way.
  // Подключения студии mcp-arckep-studio-* (F6, 18.10.2026) заменили встроенный arckep-studio; они
  // устанавливаются из каталога (user_installed_plugins) и тоже грузятся по требованию. В умолчаниях
  // помощника их нет: новый inbox получает их при создании через AgentService; OpenAPI устанавливает каталог.
  plugins: ['lobe-user-memory', 'lobe-artifacts', 'arckep-sites'],
  provider: DEFAULT_PROVIDER,
  systemRole: ARCKEP_DEFAULT_SYSTEM_ROLE,
  tts: DEFAUTT_AGENT_TTS_CONFIG,
};

export const DEFAULT_AGENT: UserDefaultAgent = {
  config: DEFAULT_AGENT_CONFIG,
  meta: DEFAULT_AGENT_META,
};
