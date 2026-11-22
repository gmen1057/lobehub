// @vitest-environment node
import { type LobeChatDatabase } from '@lobechat/database';
import { users } from '@lobechat/database/schemas';
import { getTestDB } from '@lobechat/database/test-utils';
import type * as MemoryUserMemoryModule from '@lobechat/memory-user-memory';
import type * as OpenAIShims from 'openai/_shims/index';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { UserPersonaModel } from '@/database/models/userMemory/persona';
import type * as AiInfraReposModule from '@/database/repositories/aiInfra';

import { UserPersonaService } from '../service';

vi.mock('openai/_shims/index', async (load) => {
  const original = await load<typeof OpenAIShims>();
  return {
    ...original,
    fetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
  };
});

// Use vi.hoisted to ensure mocks are available when vi.mock factory runs
const aiInfraMocks = vi.hoisted(() => ({
  getAiProviderRuntimeState: vi.fn(),
  tryMatchingModelFrom: vi.fn(),
  tryMatchingProviderFrom: vi.fn(),
}));

vi.mock('@/database/repositories/aiInfra', () => {
  const AiInfraRepos = vi.fn().mockImplementation(() => ({
    getAiProviderRuntimeState: aiInfraMocks.getAiProviderRuntimeState,
  })) as unknown as typeof AiInfraReposModule.AiInfraRepos;

  (AiInfraRepos as any).tryMatchingModelFrom = aiInfraMocks.tryMatchingModelFrom;
  (AiInfraRepos as any).tryMatchingProviderFrom = aiInfraMocks.tryMatchingProviderFrom;

  return { AiInfraRepos };
});

const configMockState = vi.hoisted(() => ({
  override: undefined as any,
}));

vi.mock('@/server/globalConfig/parseMemoryExtractionConfig', () => ({
  parseMemoryExtractionConfig: () =>
    configMockState.override ?? {
      agentLayerExtractor: {
        apiKey: 'test-key',
        baseURL: 'https://example.com',
        language: 'English',
        layers: { context: 'gpt-mock' },
        model: 'gpt-mock',
        provider: 'openai',
      },
      agentPersonaWriter: {
        apiKey: 'test-key',
        baseURL: 'https://example.com',
        language: 'English',
        model: 'gpt-mock',
        provider: 'openai',
      },
    },
}));

vi.mock('@/server/modules/KeyVaultsEncrypt', () => ({
  KeyVaultsGateKeeper: { getUserKeyVaults: vi.fn() },
}));

const structuredResult = {
  diff: '- updated',
  memoryIds: ['mem-1'],
  persona: '# Persona',
  reasoning: 'reason',
  sourceIds: ['src-1'],
  summary: 'summary',
};

const toolCall = vi.fn().mockResolvedValue(structuredResult);

vi.mock('@lobechat/memory-user-memory', () => ({
  UserPersonaExtractor: vi.fn().mockImplementation(() => ({
    toolCall,
  })),
}));

vi.mock('@/server/services/memory/userMemory/extract', () => ({
  resolveRuntimeAgentConfig: vi.fn().mockResolvedValue({}),
}));

const db: LobeChatDatabase = await getTestDB();
const userId = 'user-persona-service';

beforeEach(async () => {
  toolCall.mockClear();
  aiInfraMocks.getAiProviderRuntimeState.mockReset();
  aiInfraMocks.tryMatchingModelFrom.mockReset();
  aiInfraMocks.tryMatchingProviderFrom.mockReset();
  aiInfraMocks.tryMatchingModelFrom.mockResolvedValue('openai');
  aiInfraMocks.tryMatchingProviderFrom.mockResolvedValue('openai');
  aiInfraMocks.getAiProviderRuntimeState.mockResolvedValue({
    enabledAiModels: [
      { abilities: {}, enabled: true, id: 'gpt-mock', providerId: 'openai', type: 'chat' },
    ],
    enabledAiProviders: [],
    enabledChatAiProviders: [],
    enabledImageAiProviders: [],
    runtimeConfig: {
      openai: { keyVaults: { apiKey: 'vault-key', baseURL: 'https://vault.example.com' } },
    },
  });

  await db.delete(users);
  await db.insert(users).values({ id: userId });
});

describe('UserPersonaService', () => {
  it('composes and persists persona via agent', async () => {
    const service = new UserPersonaService(db);
    const result = await service.composeWriting({
      personaNotes: '- note',
      recentEvents: '- event',
      retrievedMemories: '- mem',
      userId,
      username: 'User',
    });

    expect(toolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        language: 'English',
        username: 'User',
      }),
    );
    expect(result.document.persona).toBe('# Persona');

    const model = new UserPersonaModel(db, userId);
    const latest = await model.getLatestPersonaDocument();
    expect(latest?.version).toBe(1);
  });

  it('passes existing persona baseline on subsequent runs', async () => {
    const service = new UserPersonaService(db);
    await service.composeWriting({ userId, username: 'User' });
    await service.composeWriting({ userId, username: 'User' });

    expect(toolCall).toHaveBeenLastCalledWith(
      expect.objectContaining({
        existingPersona: '# Persona',
      }),
    );
  });

  it('inherits OPENAI_API_KEY and gpt-6-luna from agentLayerExtractor, enables HOT-4 observeDigestCalls, and falls back flex -> default on 429', async () => {
    const { resolveRuntimeAgentConfig } =
      await import('@/server/services/memory/userMemory/extract');
    const { UserPersonaExtractor } = await import('@lobechat/memory-user-memory');

    configMockState.override = {
      agentLayerExtractor: {
        apiKey: 'sk-layer-openai-key',
        baseURL: 'https://api.openai.com/v1',
        layers: { context: 'gpt-6-luna' },
        model: 'gpt-6-luna',
        provider: 'openai',
      },
      agentPersonaWriter: {
        apiKey: undefined,
        baseURL: undefined,
        model: 'gpt-5-mini',
        provider: 'openai',
      },
      language: 'Russian',
      reasoningEffort: 'low',
      serviceTier: 'flex',
    };

    let calls = 0;
    const generateObject = vi.fn().mockImplementation(async (payload: any, callOpts: any) => {
      calls += 1;
      if (calls === 1) {
        expect(payload.serviceTier).toBe('flex');
        expect(payload.reasoningEffort).toBe('low');
        const err: any = new Error('Resource Unavailable');
        err.status = 429;
        throw err;
      }
      expect(payload.serviceTier).toBeUndefined();
      expect(payload.reasoningEffort).toBe('low');
      callOpts?.onUsage?.({ totalInputTokens: 1500, totalOutputTokens: 250 });
      return [{ arguments: JSON.stringify(structuredResult) }];
    });

    vi.mocked(resolveRuntimeAgentConfig).mockResolvedValueOnce({ generateObject } as any);
    vi.mocked(UserPersonaExtractor).mockImplementationOnce(
      (cfg: any) =>
        ({
          toolCall: async () => {
            await cfg.modelRuntime.generateObject(
              { messages: [], model: cfg.model, tools: [] },
              { metadata: {} },
            );
            return structuredResult;
          },
        }) as any,
    );

    const onUsage = vi.fn();
    const service = new UserPersonaService(db);
    await service.composeWriting(
      { userId, username: 'User' },
      { observeDigestCalls: true, onUsage },
    );

    expect(resolveRuntimeAgentConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({
        apiKey: 'sk-layer-openai-key',
        baseURL: 'https://api.openai.com/v1',
        model: 'gpt-6-luna',
        provider: 'openai',
      }),
      expect.anything(),
      expect.objectContaining({
        fallback: {
          apiKey: 'sk-layer-openai-key',
          baseURL: 'https://api.openai.com/v1',
        },
        observeDigestCalls: true,
      }),
      undefined,
    );
    expect(generateObject).toHaveBeenCalledTimes(2);
    expect(onUsage).toHaveBeenCalledWith(
      { totalInputTokens: 1500, totalOutputTokens: 250 },
      { serviceTier: 'default' },
    );

    configMockState.override = undefined;
  });

  it('sends service_tier=flex and strict json_schema on real LobeOpenAI /v1/responses wire and reconciles HOT-4 receipts + 429 fallback', async () => {
    const actualMemoryPkg = await vi.importActual<typeof MemoryUserMemoryModule>(
      '@lobechat/memory-user-memory',
    );
    const { ModelRuntime } = await import('@lobechat/model-runtime');
    const { UserPersonaExtractor } = await import('@lobechat/memory-user-memory');
    const { resolveRuntimeAgentConfig } =
      await import('@/server/services/memory/userMemory/extract');
    const { observeMemoryFetch, withMemoryBillingRun } =
      await import('@/server/services/memory/userMemory/arckepAttemptReceipt');

    const prevKey = process.env.ARCKEP_INTERNAL_TOKEN;
    const prevStudio = process.env.IMAGE_STUDIO_API_URL;
    process.env.ARCKEP_INTERNAL_TOKEN = 'internal-test-secret';
    process.env.IMAGE_STUDIO_API_URL = 'http://127.0.0.1:8202';

    const wireOpenAiBodies: any[] = [];
    const receiptBodies: any[] = [];
    const origGlobalFetch = globalThis.fetch;

    let openAiAttempt = 0;
    const fakeSdkFetch: typeof fetch = async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input?.url || String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      wireOpenAiBodies.push({ body, url });
      openAiAttempt += 1;

      // Simulate 429 capacity unavailable on first flex call if requested by test flag
      if (openAiAttempt === 2) {
        return new Response(
          JSON.stringify({
            error: { code: 'resource_unavailable', message: 'Resource Unavailable' },
          }),
          {
            headers: { 'content-type': 'application/json', 'x-request-id': 'req_429' },
            status: 429,
          },
        );
      }

      const usedTier = body.service_tier ?? 'default';
      return new Response(
        JSON.stringify({
          id: `resp_${openAiAttempt}`,
          model: 'gpt-6-luna',
          output: [
            {
              content: [
                {
                  text: JSON.stringify({
                    diff: null,
                    memoryIds: ['mem-wire-1'],
                    persona: '# Wire Persona',
                    reasoning: null,
                    sourceIds: null,
                    tagline: 'Sharp engineer',
                  }),
                  type: 'output_text',
                },
              ],
              type: 'message',
            },
          ],
          output_text: JSON.stringify({
            diff: null,
            memoryIds: ['mem-wire-1'],
            persona: '# Wire Persona',
            reasoning: null,
            sourceIds: null,
            tagline: 'Sharp engineer',
          }),
          service_tier: usedTier,
          status: 'completed',
          usage: {
            input_tokens: 1200,
            input_tokens_details: { cached_tokens: 400 },
            output_tokens: 180,
            output_tokens_details: { reasoning_tokens: 40 },
            total_tokens: 1380,
          },
        }),
        {
          headers: { 'content-type': 'application/json', 'x-request-id': `req_${openAiAttempt}` },
          status: 200,
        },
      );
    };

    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input?.url || String(input);
      if (url.endsWith('/api/internal/memory-provider-attempts')) {
        receiptBodies.push(JSON.parse(String(init?.body || '{}')));
        return new Response(JSON.stringify({ recorded: true }), {
          headers: { 'content-type': 'application/json' },
          status: 200,
        });
      }
      return fakeSdkFetch(input, init);
    }) as typeof fetch;

    try {
      configMockState.override = {
        agentLayerExtractor: {
          apiKey: 'sk-wire-test',
          baseURL: 'https://api.openai.com/v1',
          layers: { context: 'gpt-6-luna' },
          model: 'gpt-6-luna',
          provider: 'openai',
        },
        agentPersonaWriter: {
          model: 'gpt-6-luna',
          provider: 'openai',
        },
        language: 'Russian',
        reasoningEffort: 'low',
        serviceTier: 'flex',
      };

      const realRuntime = await ModelRuntime.initializeWithProvider('openai', {
        apiKey: 'sk-wire-test',
        baseURL: 'https://api.openai.com/v1',
        fetch: observeMemoryFetch,
        maxRetries: 0,
      } as any);

      vi.mocked(resolveRuntimeAgentConfig).mockResolvedValue(realRuntime);
      vi.mocked(UserPersonaExtractor).mockImplementation(
        (cfg: any) => new actualMemoryPkg.UserPersonaExtractor(cfg) as any,
      );

      // Run 1: Flex succeeds -> wire has service_tier='flex' & strict json_schema, receipt='flex', onUsage='flex'
      const usagesRun1: Array<{ meta?: { serviceTier?: string }; usage: any }> = [];
      const service = new UserPersonaService(db);
      const res1 = await withMemoryBillingRun(
        { billingOperationId: 'memauto-0123456789abcdef01234567', userId: 42 },
        () =>
          service.composeWriting(
            { retrievedMemories: '- memory', userId, username: 'User' },
            {
              observeDigestCalls: true,
              onUsage: (usage, meta) => usagesRun1.push({ meta, usage }),
            },
          ),
      );

      expect(res1.document.persona).toBe('# Wire Persona');
      expect(res1.document.tagline).toBe('Sharp engineer');
      expect(wireOpenAiBodies[0].url).toBe('https://api.openai.com/v1/responses');
      expect(wireOpenAiBodies[0].body.service_tier).toBe('flex');
      expect(wireOpenAiBodies[0].body.reasoning).toEqual({ effort: 'low' });
      expect(wireOpenAiBodies[0].body.text?.format?.type).toBe('json_schema');
      expect(wireOpenAiBodies[0].body.text?.format?.strict).toBe(true);
      expect(wireOpenAiBodies[0].body.tools).toBeUndefined();
      expect(usagesRun1).toHaveLength(1);
      expect(usagesRun1[0].meta).toEqual({ serviceTier: 'flex' });

      const finishRun1 = receiptBodies.find((r) => r.phase === 'finish');
      expect(finishRun1?.serviceTier).toBe('flex');
      expect(finishRun1?.statusCode).toBe(200);

      // Run 2: Flex returns 429 -> retries without service_tier -> wire & receipt & onUsage all agree on 'default'
      receiptBodies.length = 0;
      const usagesRun2: Array<{ meta?: { serviceTier?: string }; usage: any }> = [];
      await withMemoryBillingRun(
        { billingOperationId: 'memauto-fedcba9876543210fedcba98', userId: 42 },
        () =>
          service.composeWriting(
            { retrievedMemories: '- memory 2', userId, username: 'User' },
            {
              observeDigestCalls: true,
              onUsage: (usage, meta) => usagesRun2.push({ meta, usage }),
            },
          ),
      );

      expect(wireOpenAiBodies).toHaveLength(3);
      expect(wireOpenAiBodies[1].body.service_tier).toBe('flex');
      expect(wireOpenAiBodies[2].body.service_tier).toBeUndefined();
      expect(usagesRun2).toHaveLength(1);
      expect(usagesRun2[0].meta).toEqual({ serviceTier: 'default' });
      const finishesRun2 = receiptBodies.filter((r) => r.phase === 'finish');
      expect(finishesRun2.map((r) => ({ code: r.statusCode, tier: r.serviceTier }))).toEqual([
        { code: 429, tier: 'flex' },
        { code: 200, tier: 'default' },
      ]);
    } finally {
      globalThis.fetch = origGlobalFetch;
      configMockState.override = undefined;
      vi.mocked(resolveRuntimeAgentConfig).mockResolvedValue({} as any);
      vi.mocked(UserPersonaExtractor).mockImplementation(() => ({ toolCall }) as any);
      if (prevKey === undefined) delete process.env.ARCKEP_INTERNAL_TOKEN;
      else process.env.ARCKEP_INTERNAL_TOKEN = prevKey;
      if (prevStudio === undefined) delete process.env.IMAGE_STUDIO_API_URL;
      else process.env.IMAGE_STUDIO_API_URL = prevStudio;
    }
  }, 30_000);
});
