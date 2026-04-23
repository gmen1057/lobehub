import { ModelProvider } from 'model-bank';

import { responsesAPIModels } from '../../const/models';
import { pruneReasoningPayload } from '../../core/contextBuilders/openai';
import type { OpenAICompatibleFactoryOptions } from '../../core/openaiCompatibleFactory';
import { createOpenAICompatibleRuntime } from '../../core/openaiCompatibleFactory';
import type { ChatStreamPayload } from '../../types';
import { processMultiProviderModelList } from '../../utils/modelParse';

export interface OpenAIModelCard {
  id: string;
}

const prunePrefixes = ['o1', 'o3', 'o4', 'codex', 'computer-use', 'gpt-5'];
const oaiSearchContextSize = process.env.OPENAI_SEARCH_CONTEXT_SIZE; // low, medium, high
const enableServiceTierFlex = process.env.OPENAI_SERVICE_TIER_FLEX === '1';
const flexSupportedModels = ['gpt-5', 'o3', 'o4-mini']; // Flex tier is only available for these models

const isOpenAIImageChatModel = (model: string) =>
  model === 'gpt-image-2' || model.startsWith('gpt-image-2-');

const getOpenAIImageGenerationTool = ({
  model,
  openaiImageQuality,
  openaiImageSize,
}: Pick<ChatStreamPayload, 'model' | 'openaiImageQuality' | 'openaiImageSize'>) => {
  if (!isOpenAIImageChatModel(model)) return;

  return {
    type: 'image_generation',
    ...(openaiImageQuality && openaiImageQuality !== 'auto' ? { quality: openaiImageQuality } : {}),
    ...(openaiImageSize && openaiImageSize !== 'auto' ? { size: openaiImageSize } : {}),
  };
};

const hasCustomOpenAIImageGenerationParam = (value?: string) => Boolean(value && value !== 'auto');

const mergeOpenAIImageGenerationTool = ({
  model,
  openaiImageQuality,
  openaiImageSize,
  tools,
}: Pick<ChatStreamPayload, 'model' | 'openaiImageQuality' | 'openaiImageSize' | 'tools'>) => {
  const imageGenerationTool = getOpenAIImageGenerationTool({
    model,
    openaiImageQuality,
    openaiImageSize,
  });

  if (!imageGenerationTool) return tools;

  const nextTools = [...(tools || [])] as any[];
  const imageToolIndex = nextTools.findIndex((tool) => tool?.type === 'image_generation');

  if (imageToolIndex >= 0) {
    nextTools[imageToolIndex] = {
      ...nextTools[imageToolIndex],
      ...imageGenerationTool,
    };

    return nextTools as any;
  }

  if (
    hasCustomOpenAIImageGenerationParam(openaiImageQuality) ||
    hasCustomOpenAIImageGenerationParam(openaiImageSize)
  ) {
    nextTools.push(imageGenerationTool as any);
  }

  return nextTools.length > 0 ? (nextTools as any) : undefined;
};

const supportsFlexTier = (model: string) => {
  // Exclude o3-mini, which does not support Flex tier
  if (model.startsWith('o3-mini')) {
    return false;
  }
  return flexSupportedModels.some((supportedModel) => model.startsWith(supportedModel));
};

export const params = {
  baseURL: 'https://api.openai.com/v1',
  chatCompletion: {
    handlePayload: (payload) => {
      const { enabledSearch, model, openaiImageQuality, openaiImageSize, tools, ...rest } = payload;
      const openAIImageTools = mergeOpenAIImageGenerationTool({
        model,
        openaiImageQuality,
        openaiImageSize,
        tools,
      });

      if (responsesAPIModels.has(model) || enabledSearch) {
        return {
          ...rest,
          apiMode: 'responses',
          enabledSearch,
          model,
          tools: openAIImageTools,
        } as ChatStreamPayload;
      }

      if (prunePrefixes.some((prefix) => model.startsWith(prefix))) {
        return pruneReasoningPayload(payload) as any;
      }

      if (model.includes('-search-')) {
        return {
          ...rest,
          frequency_penalty: undefined,
          model,
          presence_penalty: undefined,
          stream: payload.stream ?? true,
          temperature: undefined,
          top_p: undefined,
          ...(enableServiceTierFlex && supportsFlexTier(model) && { service_tier: 'flex' }),
          ...(oaiSearchContextSize && {
            web_search_options: {
              search_context_size: oaiSearchContextSize,
            },
          }),
        } as any;
      }

      return {
        ...rest,
        model,
        ...(enableServiceTierFlex && supportsFlexTier(model) && { service_tier: 'flex' }),
        stream: payload.stream ?? true,
        tools: openAIImageTools,
      };
    },
  },
  debug: {
    chatCompletion: () => process.env.DEBUG_OPENAI_CHAT_COMPLETION === '1',
    responses: () => process.env.DEBUG_OPENAI_RESPONSES === '1',
  },
  models: async ({ client }) => {
    const modelsPage = (await client.models.list()) as any;
    const modelList: OpenAIModelCard[] = modelsPage.data;

    // Automatically detect model provider and select corresponding configuration
    return processMultiProviderModelList(modelList, 'openai');
  },
  provider: ModelProvider.OpenAI,
  responses: {
    handlePayload: (payload) => {
      const {
        enabledSearch,
        model,
        tools,
        verbosity,
        openaiImageQuality,
        openaiImageSize,
        ...rest
      } = payload;
      const openAIImageTools = mergeOpenAIImageGenerationTool({
        model,
        openaiImageQuality,
        openaiImageSize,
        tools,
      });

      const openaiTools = enabledSearch
        ? [
            ...(openAIImageTools || []),
            {
              type: 'web_search',
              ...(oaiSearchContextSize && {
                search_context_size: oaiSearchContextSize,
              }),
            },
          ]
        : openAIImageTools;

      if (prunePrefixes.some((prefix) => model.startsWith(prefix))) {
        const reasoning = payload.reasoning
          ? { ...payload.reasoning, summary: 'auto' }
          : { summary: 'auto' };
        if (model.startsWith('gpt-5-pro')) {
          reasoning.effort = 'high';
        }
        return pruneReasoningPayload({
          ...rest,
          model,
          reasoning,
          ...(enableServiceTierFlex && supportsFlexTier(model) && { service_tier: 'flex' }),
          stream: payload.stream ?? true,
          tools: openaiTools as any,
          // computer-use series must set truncation as auto
          ...(model.startsWith('computer-use') && { truncation: 'auto' }),
          text: verbosity ? { verbosity } : undefined,
        }) as any;
      }

      return {
        ...rest,
        model,
        ...(enableServiceTierFlex && supportsFlexTier(model) && { service_tier: 'flex' }),
        stream: payload.stream ?? true,
        tools: openaiTools,
      } as any;
    },
  },
} satisfies OpenAICompatibleFactoryOptions;

export const LobeOpenAI = createOpenAICompatibleRuntime(params);
