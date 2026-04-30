import { isProviderDisableBrowserRequest } from 'model-bank/modelProviders';

import { type AIProviderStoreState } from '@/store/aiInfra/initialState';
import { type AiProviderRuntimeConfig } from '@/types/aiProvider';
import { AiProviderSourceEnum } from '@/types/aiProvider';
import { type GlobalLLMProviderKey } from '@/types/user/settings';

// List
const enabledAiProviderList = (s: AIProviderStoreState) =>
  s.aiProviderList.filter((item) => item.enabled).sort((a, b) => a.sort! - b.sort!);

const disabledAiProviderList = (s: AIProviderStoreState) =>
  s.aiProviderList.filter((item) => !item.enabled && item.source !== AiProviderSourceEnum.Custom);

const disabledCustomAiProviderList = (s: AIProviderStoreState) =>
  s.aiProviderList.filter((item) => !item.enabled && item.source === AiProviderSourceEnum.Custom);

const enabledImageModelList = (s: AIProviderStoreState) => s.enabledImageModelList || [];

const enabledVideoModelList = (s: AIProviderStoreState) => s.enabledVideoModelList || [];

const isProviderEnabled = (id: string) => (s: AIProviderStoreState) =>
  enabledAiProviderList(s).some((i) => i.id === id);

const isProviderLoading = (id: string) => (s: AIProviderStoreState) =>
  s.aiProviderLoadingIds.includes(id);

// Detail

/**
 * Get provider detail by id from the cache map
 */
const providerDetailById = (id: string) => (s: AIProviderStoreState) => s.aiProviderDetailMap[id];

/**
 * Get active provider config from the cache map
 */
const activeProviderConfig = (s: AIProviderStoreState) =>
  s.activeAiProvider ? s.aiProviderDetailMap[s.activeAiProvider] : undefined;

/**
 * Check if provider config is loading (data not yet in cache)
 */
const isAiProviderConfigLoading = (id: string) => (s: AIProviderStoreState) =>
  !s.aiProviderDetailMap[id];

const providerWhitelist = new Set(['ollama', 'lmstudio']);

const activeProviderKeyVaults = (s: AIProviderStoreState) => activeProviderConfig(s)?.keyVaults;

const isActiveProviderEndpointNotEmpty = (s: AIProviderStoreState) => {
  const vault = activeProviderKeyVaults(s);
  return !!vault?.baseURL || !!vault?.endpoint;
};

const isActiveProviderApiKeyNotEmpty = (s: AIProviderStoreState) => {
  const vault = activeProviderKeyVaults(s);
  return !!vault?.apiKey || !!vault?.accessKeyId || !!vault?.secretAccessKey;
};

const providerConfigById =
  (id: string) =>
  (s: AIProviderStoreState): AiProviderRuntimeConfig | undefined => {
    if (!id) return undefined;

    return s.aiProviderRuntimeConfig?.[id];
  };

const isProviderConfigUpdating = (id: string) => (s: AIProviderStoreState) =>
  s.aiProviderConfigUpdatingIds.includes(id);

// arckep: server-side billing requires every request to traverse our backend
// (OPENAI_PROXY_URL / ANTHROPIC_PROXY_URL etc.). Browser-side fetchOnClient ships
// requests directly to the provider with the API key from keyVaults, bypassing
// the server-side ModelRuntime patch (index.ts:190-191) that injects PROXY_URL.
// Result: revenue leak — we pay the provider, user pays nothing.
// Incident 2026-04-30: 260+ gpt-5.4 messages charged to our OpenAI key with 0
// chat_token_charges entries. Hard-disable client fetch for billed providers
// regardless of user settings, baseURL/apiKey state, or DB ai_providers config.
const ARCKEP_SERVER_BILLED_PROVIDERS = new Set([
  'openai',
  'anthropic',
  'google',
  'xai',
  'openrouter',
  'qwen',
  'deepseek',
  'mistral',
  'groq',
  'cohere',
  'minimax',
  'novita',
]);

/**
 * @description The conditions to enable client fetch
 * 0. arckep: billed providers always go through server (revenue protection).
 * 1. If no baseUrl and apikey input, force on Server.
 * 2. If only contains baseUrl, force on Client
 * 3. Follow the user settings.
 * 4. On Server, by default.
 */
const isProviderFetchOnClient =
  (provider: GlobalLLMProviderKey | string) => (s: AIProviderStoreState) => {
    // arckep: hard-disable browser fetch for any billed provider — must hit our backend.
    if (ARCKEP_SERVER_BILLED_PROVIDERS.has(provider)) return false;

    const config = providerConfigById(provider)(s);

    // If the provider already disable browser request in model config, force on Server.
    if (isProviderDisableBrowserRequest(provider)) return false;

    // If the provider in the whitelist, follow the user settings
    if (providerWhitelist.has(provider) && typeof config?.fetchOnClient !== 'undefined')
      return config?.fetchOnClient;

    // 1. If no baseUrl and apikey input, force on Server.
    const isProviderEndpointNotEmpty = !!config?.keyVaults.baseURL;
    const isProviderApiKeyNotEmpty = !!config?.keyVaults.apiKey;
    if (!isProviderEndpointNotEmpty && !isProviderApiKeyNotEmpty) return false;

    // 2. If only contains baseUrl, force on Client
    if (isProviderEndpointNotEmpty && !isProviderApiKeyNotEmpty) return true;

    // 3. Follow the user settings.
    if (typeof config?.fetchOnClient !== 'undefined') return config?.fetchOnClient;

    // 4. On Server, by default.
    return false;
  };

const providerKeyVaults = (provider: string | undefined) => (s: AIProviderStoreState) => {
  if (!provider) return undefined;

  return s.aiProviderRuntimeConfig?.[provider]?.keyVaults;
};

const isProviderHasBuiltinSearch = (provider: string) => (s: AIProviderStoreState) => {
  const config = providerConfigById(provider)(s);

  return !!config?.settings.searchMode;
};

const isProviderHasBuiltinSearchConfig = (id: string) => (s: AIProviderStoreState) => {
  const providerCfg = providerConfigById(id)(s);

  return !!providerCfg?.settings.searchMode && providerCfg?.settings.searchMode !== 'internal';
};

const isProviderEnableResponseApi = (id: string) => (s: AIProviderStoreState) => {
  const providerCfg = providerConfigById(id)(s);

  const enableResponseApi = providerCfg?.config?.enableResponseApi;

  if (typeof enableResponseApi === 'boolean') return enableResponseApi;

  return id === 'openai';
};

const isInitAiProviderRuntimeState = (s: AIProviderStoreState) => !!s.isInitAiProviderRuntimeState;

export const aiProviderSelectors = {
  activeProviderConfig,
  disabledAiProviderList,
  disabledCustomAiProviderList,
  enabledAiProviderList,
  enabledImageModelList,
  enabledVideoModelList,
  isActiveProviderApiKeyNotEmpty,
  isActiveProviderEndpointNotEmpty,
  isAiProviderConfigLoading,
  isInitAiProviderRuntimeState,
  isProviderConfigUpdating,
  isProviderEnableResponseApi,
  isProviderEnabled,
  isProviderFetchOnClient,
  isProviderHasBuiltinSearch,
  isProviderHasBuiltinSearchConfig,
  isProviderLoading,
  providerConfigById,
  providerDetailById,
  providerKeyVaults,
};
