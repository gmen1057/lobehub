import {
  type UserPersonaDocument,
  type UserPersonaDocumentHistoriesItem,
} from '@lobechat/database/schemas';
import { userMemories } from '@lobechat/database/schemas';
import { type UserPersonaExtractionResult } from '@lobechat/memory-user-memory';
import {
  RetrievalUserMemoryContextProvider,
  RetrievalUserMemoryIdentitiesProvider,
  UserPersonaExtractor,
} from '@lobechat/memory-user-memory';
import type { ModelRuntime } from '@lobechat/model-runtime';
import type { ModelUsage } from '@lobechat/types';
import { desc, eq } from 'drizzle-orm';

import { getBusinessModelRuntimeHooks } from '@/business/server/model-runtime';
import { UserMemoryModel } from '@/database/models/userMemory';
import { UserPersonaModel } from '@/database/models/userMemory/persona';
import { AiInfraRepos } from '@/database/repositories/aiInfra';
import { type LobeChatDatabase } from '@/database/type';
import { type MemoryAgentConfig } from '@/server/globalConfig/parseMemoryExtractionConfig';
import { parseMemoryExtractionConfig } from '@/server/globalConfig/parseMemoryExtractionConfig';
import { KeyVaultsGateKeeper } from '@/server/modules/KeyVaultsEncrypt';
import {
  type ProviderKeyVaultMap,
  type RuntimeResolveOptions,
} from '@/server/services/memory/userMemory/extract';
import { resolveRuntimeAgentConfig } from '@/server/services/memory/userMemory/extract';
import { LayersEnum } from '@/types/userMemory';
import { trimBasedOnBatchProbe } from '@/utils/chunkers';

export interface UserPersonaAgentPayload {
  existingPersona?: string | null;
  language?: string;
  memoryIds?: string[];
  metadata?: Record<string, unknown>;
  personaNotes?: string;
  recentEvents?: string;
  retrievedMemories?: string;
  sourceIds?: string[];
  userId: string;
  username?: string;
  userProfile?: string;
}

export interface UserPersonaComposeOptions {
  observeDigestCalls?: boolean;
  onUsage?: (usage: ModelUsage, meta?: { serviceTier?: string }) => void;
  reasoningEffort?: string;
  serviceTier?: string;
}

interface UserPersonaAgentResult {
  agentResult: UserPersonaExtractionResult;
  diff?: UserPersonaDocumentHistoriesItem;
  document: UserPersonaDocument;
}

const isCapacityUnavailable = (error: unknown): boolean => {
  const e = error as
    | {
        code?: string;
        error?: { code?: string; message?: string; status?: number };
        errorType?: string;
        message?: string;
        status?: number;
      }
    | undefined;
  if (e?.errorType === 'QuotaLimitReached' || e?.error?.status === 429 || e?.status === 429) {
    return true;
  }
  const text =
    `${e?.error?.code ?? e?.code ?? ''} ${e?.error?.message ?? e?.message ?? ''}`.toLowerCase();
  return text.includes('resource unavailable') || text.includes('resource_unavailable');
};

/**
 * OpenAI Structured Outputs (`strict: true`) JSON Schema для `commit_user_persona`.
 * Используем schema-ветку `generateObject` вместо `tools`, так как `generateObjectWithTools`
 * в `openaiCompatibleFactory` отбрасывает `serviceTier` (`flex`) и `reasoningEffort`.
 */
const STRICT_PERSONA_OUTPUT_SCHEMA = {
  description:
    'Persist an updated user persona document that summarizes the user, preferences, relationships, and recent events.',
  name: 'commit_user_persona',
  schema: {
    additionalProperties: false,
    properties: {
      diff: {
        anyOf: [{ type: 'string' }, { type: 'null' }],
        description: 'Bullet list of changes applied this run',
      },
      memoryIds: {
        anyOf: [{ items: { type: 'string' }, type: 'array' }, { type: 'null' }],
        description: 'Related memory IDs used to craft the persona',
      },
      persona: { description: 'Complete Markdown persona for the user', type: 'string' },
      reasoning: {
        anyOf: [{ type: 'string' }, { type: 'null' }],
        description: 'Why these changes were applied',
      },
      sourceIds: {
        anyOf: [{ items: { type: 'string' }, type: 'array' }, { type: 'null' }],
        description: 'Source IDs (topic ID, document ID, or anything related) tied to this update',
      },
      tagline: {
        anyOf: [{ type: 'string' }, { type: 'null' }],
        description: 'Short one-liner/tagline that captures the persona',
      },
    },
    required: ['persona', 'tagline', 'diff', 'reasoning', 'memoryIds', 'sourceIds'],
    type: 'object' as const,
  },
  strict: true,
};

const stripNullOptionalFields = (raw: unknown): unknown => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value !== null) cleaned[key] = value;
  }
  return cleaned;
};

export class UserPersonaService {
  private readonly preferredLanguage?: string;
  private readonly defaultReasoningEffort?: string;
  private readonly defaultServiceTier?: string;
  private readonly db: LobeChatDatabase;
  private readonly agentConfig: MemoryAgentConfig;

  constructor(db: LobeChatDatabase) {
    const config = parseMemoryExtractionConfig();
    const writerAgent = config.agentPersonaWriter;
    const layerAgent = config.agentLayerExtractor;
    const explicitWriterModel = process.env.MEMORY_USER_MEMORY_PERSONA_WRITER_MODEL?.trim();
    const explicitWriterProvider = process.env.MEMORY_USER_MEMORY_PERSONA_WRITER_PROVIDER?.trim();

    const provider =
      explicitWriterProvider || layerAgent?.provider || writerAgent?.provider || 'openai';
    const model =
      explicitWriterModel ||
      layerAgent?.layers?.context ||
      layerAgent?.model ||
      writerAgent?.model ||
      'gpt-6-luna';
    const apiKey =
      writerAgent?.apiKey ||
      layerAgent?.apiKey ||
      (provider === 'openai' ? process.env.OPENAI_API_KEY : undefined);
    const baseURL = writerAgent?.baseURL || layerAgent?.baseURL;

    this.db = db;
    this.preferredLanguage = config.language || writerAgent?.language || layerAgent?.language;
    this.defaultReasoningEffort = config.reasoningEffort;
    this.defaultServiceTier = config.serviceTier;
    this.agentConfig = {
      ...writerAgent,
      apiKey,
      baseURL,
      model,
      provider,
    };
  }

  async composeWriting(
    payload: UserPersonaAgentPayload,
    options?: UserPersonaComposeOptions,
  ): Promise<UserPersonaAgentResult> {
    const aiInfraRepos = new AiInfraRepos(this.db, payload.userId, {});
    const runtimeState = await aiInfraRepos.getAiProviderRuntimeState(
      KeyVaultsGateKeeper.getUserKeyVaults,
    );
    const providerId = await AiInfraRepos.tryMatchingProviderFrom(runtimeState, {
      fallbackProvider: this.agentConfig.provider,
      label: 'persona writer',
      modelId: this.agentConfig.model,
    });

    const keyVaults: ProviderKeyVaultMap = Object.entries(runtimeState.runtimeConfig || {}).reduce(
      (acc, [provider, config]) => {
        acc[provider.toLowerCase()] = config?.keyVaults;
        return acc;
      },
      {} as ProviderKeyVaultMap,
    );

    const hooks = getBusinessModelRuntimeHooks(payload.userId, 'lobehub');

    const runtime = await resolveRuntimeAgentConfig(
      { ...this.agentConfig },
      keyVaults,
      {
        fallback: {
          apiKey: this.agentConfig.apiKey,
          baseURL: this.agentConfig.baseURL,
        },
        observeDigestCalls: options?.observeDigestCalls,
        preferred: { providerIds: [providerId] },
        userId: payload.userId,
      } satisfies RuntimeResolveOptions,
      hooks,
    );

    const effectiveReasoningEffort = options?.reasoningEffort ?? this.defaultReasoningEffort;
    const effectiveServiceTier = options?.serviceTier ?? this.defaultServiceTier;

    const wrappedRuntime: ModelRuntime =
      runtime && typeof (runtime as ModelRuntime).generateObject === 'function'
        ? (new Proxy(runtime as ModelRuntime, {
            get(target, prop, receiver) {
              if (prop === 'generateObject') {
                return async (reqPayload: any, reqOptions?: any) => {
                  const isPersonaToolCall =
                    !reqPayload?.schema &&
                    Array.isArray(reqPayload?.tools) &&
                    reqPayload.tools.length === 1 &&
                    reqPayload.tools[0]?.function?.name === 'commit_user_persona';
                  const { tools: _omitTools, ...withoutTools } = reqPayload ?? {};
                  const normalizedReq = isPersonaToolCall
                    ? { ...withoutTools, schema: STRICT_PERSONA_OUTPUT_SCHEMA }
                    : reqPayload;
                  const basePayload = {
                    ...normalizedReq,
                    ...(effectiveReasoningEffort && { reasoningEffort: effectiveReasoningEffort }),
                    ...(effectiveServiceTier && { serviceTier: effectiveServiceTier }),
                  };
                  const makeCallOptions = (usedTier: string) => ({
                    ...reqOptions,
                    ...(options?.onUsage || reqOptions?.onUsage
                      ? {
                          onUsage: (u: ModelUsage) => {
                            reqOptions?.onUsage?.(u);
                            options?.onUsage?.(u, { serviceTier: usedTier });
                          },
                        }
                      : {}),
                  });

                  try {
                    const out = await target.generateObject(
                      basePayload,
                      makeCallOptions(effectiveServiceTier || 'default'),
                    );
                    return isPersonaToolCall ? stripNullOptionalFields(out) : out;
                  } catch (error) {
                    if (!effectiveServiceTier || !isCapacityUnavailable(error)) throw error;
                    const { serviceTier: _omit, ...standardPayload } = basePayload;
                    const out = await target.generateObject(
                      standardPayload,
                      makeCallOptions('default'),
                    );
                    return isPersonaToolCall ? stripNullOptionalFields(out) : out;
                  }
                };
              }
              const value = Reflect.get(target, prop, receiver);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          }) as ModelRuntime)
        : runtime;

    const personaModel = new UserPersonaModel(this.db, payload.userId);
    const lastDocument = await personaModel.getLatestPersonaDocument();
    const existingPersonaBaseline = payload.existingPersona ?? lastDocument?.persona;

    const extractor = new UserPersonaExtractor({
      agent: 'user-persona',
      model: this.agentConfig.model,
      modelRuntime: wrappedRuntime,
    });

    const agentResult = await extractor.toolCall({
      existingPersona: existingPersonaBaseline || undefined,
      language: payload.language || this.preferredLanguage,
      personaNotes: payload.personaNotes,
      recentEvents: payload.recentEvents,
      retrievedMemories: payload.retrievedMemories,
      userProfile: payload.userProfile,
      username: payload.username,
    });

    const persisted = await personaModel.upsertPersona({
      capturedAt: new Date(),
      diffPersona: agentResult.diff ?? undefined,
      editedBy: 'agent',
      memoryIds: payload.memoryIds ?? agentResult.memoryIds ?? undefined,
      metadata: payload.metadata ?? undefined,
      persona: agentResult.persona,
      reasoning: agentResult.reasoning ?? undefined,
      snapshot: agentResult.persona,
      sourceIds: payload.sourceIds ?? agentResult.sourceIds ?? undefined,
      tagline: agentResult.tagline ?? undefined,
    });

    return { agentResult, ...persisted };
  }
}

export const buildUserPersonaJobInput = async (db: LobeChatDatabase, userId: string) => {
  const personaModel = new UserPersonaModel(db, userId);
  const latestPersona = await personaModel.getLatestPersonaDocument();
  const { agentPersonaWriter } = parseMemoryExtractionConfig();
  const personaContextLimit = agentPersonaWriter.contextLimit;

  const userMemoryModel = new UserMemoryModel(db, userId);

  const [identities, activities, contexts, preferences, memories] = await Promise.all([
    userMemoryModel.getAllIdentitiesWithMemory(),
    // TODO(@nekomeowww): @arvinxx kindly take some time to review this policy
    userMemoryModel.listMemories({ layer: LayersEnum.Activity, pageSize: 3 }),
    userMemoryModel.listMemories({ layer: LayersEnum.Context, pageSize: 3 }),
    userMemoryModel.listMemories({ layer: LayersEnum.Preference, pageSize: 10 }),
    db.query.userMemories.findMany({
      limit: 20,
      orderBy: [desc(userMemories.capturedAt)],
      where: eq(userMemories.userId, userId),
    }),
  ]);

  const contextProvider = new RetrievalUserMemoryContextProvider({
    retrievedMemories: {
      activities: activities.map((a) => a.activity),
      contexts: contexts.map((c) => c.context),
      experiences: [],
      preferences: preferences.map((p) => p.preference),
    },
  });

  const identityProvider = new RetrievalUserMemoryIdentitiesProvider({
    retrievedIdentities: identities.map((i) => ({
      ...i,
      layer: LayersEnum.Identity,
    })),
  });

  const [recentMemoriesContext, allIdentitiesContext] = await Promise.all([
    contextProvider.buildContext(userId, 'user-persona-memories'),
    identityProvider.buildContext(userId, 'user-persona-memories-identities'),
  ]);

  const rawContext = [recentMemoriesContext.context, allIdentitiesContext.context]
    .filter(Boolean)
    .join('\n\n');

  const trimmedContext = rawContext
    ? await trimBasedOnBatchProbe(rawContext, personaContextLimit)
    : '';
  const assembledContext = trimmedContext?.trim();

  return {
    existingPersona: latestPersona?.persona || undefined,
    memoryIds: memories.map((m) => m.id),
    retrievedMemories: assembledContext || undefined,
  };
};
