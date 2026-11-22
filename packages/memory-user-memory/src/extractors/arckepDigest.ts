import { renderPlaceholderTemplate } from '@lobechat/context-engine';
import type { GenerateObjectSchema } from '@lobechat/model-runtime';
import { LayersEnum } from '@lobechat/types';
import { z } from 'zod';

import {
  activityPrompt,
  contextPrompt,
  experiencePrompt,
  identityPrompt,
  preferencePrompt,
} from '../prompts';
import type { IdentityActionsSchema } from '../schemas';
import {
  ContextMemoryItemSchema,
  ExperienceMemoryItemSchema,
  PreferenceMemoryItemSchema,
} from '../schemas';
import type { ExtractorOptions, ExtractorTemplateProps } from '../types';
import { buildGenerateObjectSchema } from '../utils/zod';
import { ActivityExtractor } from './activity';
import { BaseMemoryExtractor, type BaseMemoryExtractorConfig } from './base';
import { IdentityExtractor } from './identity';

const SUPERSEDE_IDS_DESCRIPTION =
  'Exact id attributes from <existing_memories> of the same layer that this new or merged memory replaces or supersedes; use [] or null when nothing is replaced';

const DigestSupersedeIdsZodField = z
  .array(z.string())
  .nullable()
  .optional()
  .describe(SUPERSEDE_IDS_DESCRIPTION);

const DigestSupersedeIdsStrictField = z
  .array(z.string())
  .nullable()
  .describe(SUPERSEDE_IDS_DESCRIPTION);

export const DigestPreferenceMemorySchema = z.object({
  memories: z
    .array(
      PreferenceMemoryItemSchema.extend({
        supersedeIds: DigestSupersedeIdsZodField,
      }),
    )
    .describe(
      'Array of extracted preference memory items, could be empty if decided no relevant preference to extract',
    ),
});

export const DigestContextMemorySchema = z.object({
  memories: z
    .array(
      ContextMemoryItemSchema.extend({
        supersedeIds: DigestSupersedeIdsZodField,
      }),
    )
    .describe(
      'Array of extracted context memory items, could be empty if decided no relevant context to extract',
    ),
});

export const DigestExperienceMemorySchema = z.object({
  memories: z
    .array(
      ExperienceMemoryItemSchema.extend({
        supersedeIds: DigestSupersedeIdsZodField,
      }),
    )
    .describe(
      'Array of extracted experience memory items, could be empty if decided no relevant experience to extract',
    ),
});

const StrictDigestPreferenceJsonSchema = z.object({
  memories: z
    .array(
      PreferenceMemoryItemSchema.extend({
        supersedeIds: DigestSupersedeIdsStrictField,
      }),
    )
    .describe(
      'Array of extracted preference memory items, could be empty if decided no relevant preference to extract',
    ),
});

const StrictDigestContextJsonSchema = z.object({
  memories: z
    .array(
      ContextMemoryItemSchema.extend({
        supersedeIds: DigestSupersedeIdsStrictField,
      }),
    )
    .describe(
      'Array of extracted context memory items, could be empty if decided no relevant context to extract',
    ),
});

const StrictDigestExperienceJsonSchema = z.object({
  memories: z
    .array(
      ExperienceMemoryItemSchema.extend({
        supersedeIds: DigestSupersedeIdsStrictField,
      }),
    )
    .describe(
      'Array of extracted experience memory items, could be empty if decided no relevant experience to extract',
    ),
});

const enforceStrictJsonSchema = (node: unknown): unknown => {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(enforceStrictJsonSchema);

  const obj = { ...(node as Record<string, unknown>) };
  if (obj.properties && typeof obj.properties === 'object' && !Array.isArray(obj.properties)) {
    const props = Object.fromEntries(
      Object.entries(obj.properties as Record<string, unknown>).map(([k, v]) => [
        k,
        enforceStrictJsonSchema(v),
      ]),
    );
    obj.properties = props;
    obj.required = Object.keys(props);
    obj.additionalProperties = false;
  }
  if (obj.items) {
    obj.items = enforceStrictJsonSchema(obj.items);
  }
  for (const branchKey of ['anyOf', 'oneOf', 'allOf'] as const) {
    if (Array.isArray(obj[branchKey])) {
      obj[branchKey] = (obj[branchKey] as unknown[]).map(enforceStrictJsonSchema);
    }
  }
  if (obj.$defs && typeof obj.$defs === 'object' && !Array.isArray(obj.$defs)) {
    obj.$defs = Object.fromEntries(
      Object.entries(obj.$defs as Record<string, unknown>).map(([k, v]) => [
        k,
        enforceStrictJsonSchema(v),
      ]),
    );
  }
  if (obj.definitions && typeof obj.definitions === 'object' && !Array.isArray(obj.definitions)) {
    obj.definitions = Object.fromEntries(
      Object.entries(obj.definitions as Record<string, unknown>).map(([k, v]) => [
        k,
        enforceStrictJsonSchema(v),
      ]),
    );
  }
  return obj;
};

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
  context?: z.infer<typeof DigestContextMemorySchema> | null;
  experience?: z.infer<typeof DigestExperienceMemorySchema> | null;
  identity?: z.infer<typeof IdentityActionsSchema> | null;
  preference?: z.infer<typeof DigestPreferenceMemorySchema> | null;
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
  '- When a new or updated preference, context, or experience memory merges, replaces, or supersedes outdated or duplicate entries of the same layer from <existing_memories>, list their exact id attributes in supersedeIds (use [] or null when nothing is superseded).',
  '- Entries marked with pinned="true" in <existing_memories> are manual permanent user rules: never repeat them as new preferences and never include their id in supersedeIds.',
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
  // Схемы слоёв берём у их экстракторов, а для preference/context/experience добавляем supersedeIds.
  const stub = { modelRuntime: {} as never, model: 'schema-only' };
  const layerSchemas: Record<string, GenerateObjectSchema | undefined> = {
    [LayersEnum.Activity]: new ActivityExtractor({ ...stub, agent: 'layer-activity' }).getSchema(),
    [LayersEnum.Context]: buildGenerateObjectSchema(StrictDigestContextJsonSchema, {
      name: 'context_extraction',
    }),
    [LayersEnum.Experience]: buildGenerateObjectSchema(StrictDigestExperienceJsonSchema, {
      name: 'experience_extraction',
    }),
    [LayersEnum.Identity]: new IdentityExtractor({ ...stub, agent: 'layer-identity' }).getSchema(),
    [LayersEnum.Preference]: buildGenerateObjectSchema(StrictDigestPreferenceJsonSchema, {
      name: 'preference_extraction',
    }),
  };
  const built: GenerateObjectSchema = {
    name: 'memory_digest',
    schema: enforceStrictJsonSchema({
      additionalProperties: false,
      properties: Object.fromEntries(
        DIGEST_LAYERS.map((layer) => [layer, layerSchemas[layer]!.schema]),
      ),
      required: [...DIGEST_LAYERS],
      type: 'object' as const,
    }) as GenerateObjectSchema['schema'],
    strict: true,
  };
  cachedSchema = built;
  return built;
};

export class DigestMemoryExtractor extends BaseMemoryExtractor<
  DigestOutput,
  ExtractorTemplateProps,
  DigestExtractorOptions
> {
  static readonly PreferenceMemorySchema = DigestPreferenceMemorySchema;
  static readonly ContextMemorySchema = DigestContextMemorySchema;
  static readonly ExperienceMemorySchema = DigestExperienceMemorySchema;

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
