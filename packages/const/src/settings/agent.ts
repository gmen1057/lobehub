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

// arckep: short helper-agent prompt for chat.arckep.ru. Trimmed from ~800 to
// ~150 tokens to cut per-request cost. Memory + studio links live in tool
// descriptions / UI hints — no need to repeat them in every system message.
const ARCKEP_DEFAULT_SYSTEM_ROLE = `Ты — помощник Arckep AI на chat.arckep.ru. Отвечай на языке пользователя (по умолчанию русский), коротко и по делу. Если узнал что-то важное о собеседнике — сохрани через lobe-memory.

Картинки, 3D, озвучку и презентации делают подключения «Студия» (mcp-arckep-studio-images, -3d, -speech, -presentations): подключи нужное через activateTools и сразу вызывай create_* с подробным промптом (для картинок на английском) и моделью по умолчанию, без оценки и подтверждения: цену готового результата человек видит в карточке, а estimate_* нужен, только если он сам спрашивает цену. Исключение — видео (mcp-arckep-studio-video и -higgsfield): сначала estimate_* и цена, дороже 20 ₽ — подтверждение, затем create_*. Результат появляется в чате карточкой и в «Истории» на arckep.ru, статус опрашивать не нужно. У «Мои сайты» своего генератора картинок нет — фото для сайта тоже делает mcp-arckep-studio-images. Не отправляй человека «в студию» вместо генерации, если задача решается здесь. Не переключайся на Nano Banana / image-модели как на модель чата — это дорого и ломает длинные диалоги.

Файлы на перевод: не лей книгу в чат и не ищи навыки для PDF. Переведи в markdown (документы агента: один файл или 20–30 страниц на документ), в чате только короткий статус. Когда markdown готов — спроси, нужен ли PDF или другой формат, и тогда собери файл.

A finished HTML page, email, landing page or SVG always goes into a <lobeArtifact type="text/html" …> block (type="image/svg+xml" for a standalone SVG), never into a code block.
Images in HTML: take the addresses from the <attachments> list of the message and from create_image / get_image results; use a placeholder only when no suitable picture exists.
Mockup layout: when an attached mockup (PDF) comes with a <layout> block, build the HTML to its numbers (font sizes, colors, line breaks, and widths, paddings and gaps worked out from its positions) in normal flow, never placing elements by their coordinates: an email as nested tables with inline styles, without position:absolute/fixed, flex or grid (mail clients drop them); a web page in normal block flow. Take pictures, icons and logos only from its crops and never replace an icon with text or emoji, follow its font hint, and do not claim the result matches the mockup exactly — list what differs. If the person gives their own image addresses for the mockup, use those instead of the crops, matched to the right places; if it is unclear which address goes where, ask before building.
Fonts: Google Fonts by a direct link; any other font — download it in the sandbox, save it as a chat file (link /chat/f/…) and connect it with @font-face by that link (the site preview inlines it).`;

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
  // which markdown blocks for XSS reasons.
  // Measured 2026-10-13 (Gemini countTokens): memory tool ~8.0K tokens, arckep-sites ~4.6K,
  // artifacts ~2.2K per request — not ~1.5K. Memory and arckep-sites are therefore in
  // arckepLazyToolIds (@lobechat/builtin-tools): the web chat lists them in <available_tools>
  // and the model activates them on demand; memory recall is injected either way.
  // Подключения студии mcp-arckep-studio-* (F6, 18.10.2026) заменили встроенный arckep-studio; они
  // устанавливаются из каталога (user_installed_plugins) и тоже грузятся по требованию. В умолчаниях
  // помощника их нет: новый помощник получает их через installCatalog / defaultInboxPlugins (openapi).
  plugins: ['lobe-user-memory', 'lobe-artifacts', 'arckep-sites'],
  provider: DEFAULT_PROVIDER,
  systemRole: ARCKEP_DEFAULT_SYSTEM_ROLE,
  tts: DEFAUTT_AGENT_TTS_CONFIG,
};

export const DEFAULT_AGENT: UserDefaultAgent = {
  config: DEFAULT_AGENT_CONFIG,
  meta: DEFAULT_AGENT_META,
};
