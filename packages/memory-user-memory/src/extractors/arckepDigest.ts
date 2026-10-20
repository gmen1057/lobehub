import { renderPlaceholderTemplate } from '@lobechat/context-engine';
import type { GenerateObjectSchema } from '@lobechat/model-runtime';
import { LayersEnum } from '@lobechat/types';
import type { z } from 'zod';

import {
  activityPrompt,
  contextPrompt,
  experiencePrompt,
  identityPrompt,
  preferencePrompt,
} from '../prompts';
import type {
  ContextMemorySchema,
  ExperienceMemorySchema,
  IdentityActionsSchema,
  PreferenceMemorySchema,
} from '../schemas';
import type { ExtractorOptions, ExtractorTemplateProps } from '../types';
import { ActivityExtractor } from './activity';
import { BaseMemoryExtractor, type BaseMemoryExtractorConfig } from './base';
import { ContextExtractor } from './context';
import { ExperienceExtractor } from './experience';
import { IdentityExtractor } from './identity';
import { PreferenceExtractor } from './preference';

/**
 * arckep (20.10.2026): суточный разбор человека ОДНИМ вызовом модели вместо шести (привратник + пять слоёв).
 *
 * Почему. Владелец: «грузит все новые и с ними факты из прошлой памяти и сравнивает… контекст у него огромный… раз в
 * день — будет дешевле сильно». Шесть вызовов отправляли переписку и память шесть раз, а кэш OpenAI между ними не
 * работал: схема ответа стоит в начале запроса (до сообщений), у каждого слоя она своя — общее начало не совпадало
 * никогда (живая проба 20.10: 0 токенов из кэша на 68 тыс.).
 *
 * Как. Одна схема со всеми пятью слоями (схемы слоёв как есть) и одни инструкции (инструкции слоёв, отрисованные
 * постоянными значениями: без имени, даты и прочего личного). Схема и инструкции одинаковы у всех людей и идут первыми —
 * ночью люди разбираются подряд, и это начало запроса OpenAI берёт из кэша. Всё личное — в сообщении пользователя в конце:
 * `<session>`, новые переписки, вся прежняя память.
 */

export const DIGEST_LAYERS = [
  LayersEnum.Identity,
  LayersEnum.Preference,
  LayersEnum.Context,
  LayersEnum.Experience,
  LayersEnum.Activity,
] as const;

export interface DigestOutput {
  activity?: { memories?: unknown[] } | null;
  context?: z.infer<typeof ContextMemorySchema> | null;
  experience?: z.infer<typeof ExperienceMemorySchema> | null;
  identity?: z.infer<typeof IdentityActionsSchema> | null;
  preference?: z.infer<typeof PreferenceMemorySchema> | null;
}

export interface DigestExtractorOptions extends ExtractorOptions {
  /**
   * Новые переписки и вся прежняя память человека (`<new_conversations>`, `<existing_memories>`, …) — в конце
   * сообщения пользователя. Не `sharedContext`: тот базовый класс ставит ПЕРВЫМ сообщением, а здесь первыми должны
   * идти одинаковые у всех инструкции.
   */
  digestContext?: string;
}

// Постоянные значения подстановок: инструкции должны быть одинаковы у всех людей (иначе кэша нет).
const STATIC_PROPS = {
  availableCategories: 'the categories listed in <session> in the user message',
  existingIdentitiesContext: '(see <existing_identities> in the user message)',
  language: 'the language given in <session> in the user message',
  retrievedContext: '(see <existing_memories> in the user message)',
  sessionDate: 'the date given in <session> in the user message',
  topK: 'all',
  username: 'User',
};

const HEADER = [
  'You extract long-term memories about the user for FIVE layers at once: identity, preference, context, experience, activity.',
  'The user message contains <session> (date, language, available categories), the NEW messages of the user conversations (<new_conversations>, one <chat_topic> each) and ALL memories already stored about the user (<existing_memories>, <existing_identities>).',
  'Return ONE JSON object with one key per layer; each value follows the instructions of its layer below.',
  '',
  'Rules for all layers:',
  '- Compare with the existing memories first. Output only what is NEW or MATERIALLY UPDATED; never repeat what is already stored, even in other words.',
  '- Several conversations about the same project or situation are ONE context memory, not one per conversation.',
  '- Extract only durable facts that will matter in future conversations. Skip one-off task requirements, small talk, connectivity checks ("are you there?"), test messages and tool or system chatter.',
  '- Preferences only from explicit cross-session directives ("always", "never", "from now on", "I prefer").',
  '- When a layer has nothing new, return an empty array for it (identity: empty add, update and remove).',
  '- Write every text field in the language given in <session>.',
  '',
  'Detailed instructions for each layer follow. In them, "retrieved memories" means <existing_memories> and <existing_identities>, and "the conversation" means the messages in <new_conversations>.',
].join('\n');

const LAYER_PROMPTS: [LayersEnum, string][] = [
  [LayersEnum.Identity, identityPrompt],
  [LayersEnum.Preference, preferencePrompt],
  [LayersEnum.Context, contextPrompt],
  [LayersEnum.Experience, experiencePrompt],
  [LayersEnum.Activity, activityPrompt],
];

let cachedPrompt: string | undefined;
let cachedSchema: GenerateObjectSchema | undefined;

export const buildDigestPrompt = (): string => {
  cachedPrompt ??= [
    HEADER,
    ...LAYER_PROMPTS.map(
      ([layer, prompt]) =>
        `\n\n=== LAYER "${layer}" (JSON key "${layer}") ===\n\n${renderPlaceholderTemplate(prompt, STATIC_PROPS)}`,
    ),
  ].join('');
  return cachedPrompt;
};

export const buildDigestSchema = (): GenerateObjectSchema => {
  if (cachedSchema) return cachedSchema;
  // Схемы слоёв берём у их экстракторов как есть (рантайм для getSchema не нужен).
  const stub = { modelRuntime: {} as never, model: 'schema-only' };
  const layerSchemas: Record<string, GenerateObjectSchema | undefined> = {
    [LayersEnum.Activity]: new ActivityExtractor({ ...stub, agent: 'layer-activity' }).getSchema(),
    [LayersEnum.Context]: new ContextExtractor({ ...stub, agent: 'layer-context' }).getSchema(),
    [LayersEnum.Experience]: new ExperienceExtractor({
      ...stub,
      agent: 'layer-experience',
    }).getSchema(),
    [LayersEnum.Identity]: new IdentityExtractor({ ...stub, agent: 'layer-identity' }).getSchema(),
    [LayersEnum.Preference]: new PreferenceExtractor({
      ...stub,
      agent: 'layer-preference',
    }).getSchema(),
  };
  cachedSchema = {
    name: 'memory_digest',
    schema: {
      additionalProperties: false,
      properties: Object.fromEntries(
        DIGEST_LAYERS.map((layer) => [layer, layerSchemas[layer]!.schema]),
      ),
      required: [...DIGEST_LAYERS],
      type: 'object' as const,
    },
    strict: true,
  };
  return cachedSchema;
};

export class DigestMemoryExtractor extends BaseMemoryExtractor<
  DigestOutput,
  ExtractorTemplateProps,
  DigestExtractorOptions
> {
  constructor(config: Omit<BaseMemoryExtractorConfig, 'agent'>) {
    super({ ...config, agent: 'arckep-digest' });
  }

  getPrompt(): string {
    return buildDigestPrompt();
  }

  getSchema(): GenerateObjectSchema {
    return buildDigestSchema();
  }

  // Слои проверяются при записи; у «событий» своей zod-схемы нет (как у ActivityExtractor).
  protected getResultSchema() {
    return undefined;
  }

  // Подстановок в инструкциях нет — они одинаковы у всех людей.
  protected getTemplateProps(): Record<string, never> {
    return {};
  }

  buildUserPrompt(options: ExtractorTemplateProps & { digestContext?: string }): string {
    const categories = options.availableCategories?.length
      ? options.availableCategories.join(', ')
      : '(none yet)';
    return [
      `<session date="${options.sessionDate ?? new Date().toISOString()}" language="${options.language ?? 'English'}">`,
      `available categories: ${categories}`,
      '</session>',
      options.digestContext ?? '',
    ].join('\n');
  }
}
