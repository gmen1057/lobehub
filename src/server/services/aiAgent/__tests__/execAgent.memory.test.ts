// @vitest-environment node
/**
 * Integration tests for memory enabled priority in execAgent.
 *
 * Verifies that agent-level memory config takes priority over user-level setting,
 * and falls back to user setting when agent config is absent.
 */
import type { LobeChatDatabase } from '@lobechat/database';
import { agents, userSettings } from '@lobechat/database/schemas';
import { getTestDB } from '@lobechat/database/test-utils';
import { eq } from 'drizzle-orm';
import OpenAI from 'openai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { inMemoryAgentStateManager } from '@/server/modules/AgentRuntime/InMemoryAgentStateManager';
import { inMemoryStreamEventManager } from '@/server/modules/AgentRuntime/InMemoryStreamEventManager';

import {
  createMockResponsesAPIStream,
  waitForOperationComplete,
} from '../../../routers/lambda/__tests__/integration/aiAgent/helpers';
import {
  cleanupTestUser,
  createTestUser,
} from '../../../routers/lambda/__tests__/integration/setup';
import { aiAgentRouter } from '../../../routers/lambda/aiAgent';

process.env.OPENAI_API_KEY = 'sk-test-fake-api-key-for-testing';

const sharedServerDB: LobeChatDatabase = await getTestDB();
let testDB: LobeChatDatabase = sharedServerDB;
vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: vi.fn(() => testDB),
}));

vi.mock('@/server/services/file', () => ({
  FileService: vi.fn().mockImplementation(() => ({
    getFullFileUrl: vi.fn().mockImplementation((path: string) => (path ? `/files${path}` : null)),
  })),
}));

let mockResponsesCreate: any;
let serverDB: LobeChatDatabase = sharedServerDB;
let userId: string;

const createTestContext = () => ({
  jwtPayload: { userId },
  userId,
});

const hasMemoryTools = (tools: Array<{ name?: string; function?: { name: string } }>) =>
  tools?.some((t) => (t.name || t.function?.name)?.includes('lobe-user-memory'));

/**
 * arckep (18.10.2026): инструмент памяти подгружается по требованию (arckepLazyToolIds) — при включённой
 * памяти он не в tools первого шага, а в списке <available_tools> системной части; при выключенной —
 * нигде.
 */
const memoryOffered = (args: { tools?: any[]; instructions?: unknown; input?: unknown }) => {
  if (hasMemoryTools(args.tools ?? [])) return true;
  const text = JSON.stringify([args.instructions ?? '', args.input ?? '']);
  // строка списка: <tool identifier="lobe-user-memory" …> (packages/prompts/src/prompts/toolDiscovery)
  return /<tool identifier=\\"lobe-user-memory\\"/.test(text);
};

const setUserMemorySettings = async (enabled: boolean) => {
  // Try update first, then insert if no row exists
  const result = await serverDB
    .update(userSettings)
    .set({ memory: { enabled } })
    .where(eq(userSettings.id, userId))
    .returning();

  if (result.length === 0) {
    await serverDB.insert(userSettings).values({ id: userId, memory: { enabled } });
  }
};

beforeEach(async () => {
  serverDB = sharedServerDB;
  testDB = sharedServerDB;
  userId = await createTestUser(serverDB);
  mockResponsesCreate = vi.spyOn(OpenAI.Responses.prototype, 'create');
  mockResponsesCreate.mockResolvedValue(createMockResponsesAPIStream('Hello') as any);
});

afterEach(async () => {
  await cleanupTestUser(serverDB, userId);
  vi.clearAllMocks();
  vi.restoreAllMocks();
  inMemoryAgentStateManager.clear();
  inMemoryStreamEventManager.clear();
});

const createTestAgent = async (chatConfig: Record<string, any> = {}) => {
  const [agent] = await serverDB
    .insert(agents)
    .values({
      chatConfig: chatConfig as any,
      model: 'gpt-5-pro',
      provider: 'openai',
      systemRole: 'test',
      title: 'Test',
      userId,
    })
    .returning();
  return agent;
};

describe('execAgent - memory enabled priority', () => {
  it('should disable memory tools when agent config sets memory.enabled = false, even if user enables it', async () => {
    await setUserMemorySettings(true);
    const agent = await createTestAgent({ memory: { enabled: false } });

    const caller = aiAgentRouter.createCaller(createTestContext());
    const result = await caller.execAgent({ agentId: agent.id, prompt: 'Hello' });
    await waitForOperationComplete(inMemoryAgentStateManager, result.operationId);

    const callArgs = mockResponsesCreate.mock.calls[0][0] as { tools?: any[] };
    expect(memoryOffered(callArgs)).toBe(false);
  });

  it('should enable memory tools when agent config sets memory.enabled = true, even if user disables it', async () => {
    await setUserMemorySettings(false);
    const agent = await createTestAgent({ memory: { enabled: true } });

    const caller = aiAgentRouter.createCaller(createTestContext());
    const result = await caller.execAgent({ agentId: agent.id, prompt: 'Hello' });
    await waitForOperationComplete(inMemoryAgentStateManager, result.operationId);

    const callArgs = mockResponsesCreate.mock.calls[0][0] as { tools?: any[] };
    expect(memoryOffered(callArgs)).toBe(true);
  });

  it('should fallback to user setting when agent has no memory config', async () => {
    await setUserMemorySettings(false);
    const agent = await createTestAgent();

    const caller = aiAgentRouter.createCaller(createTestContext());
    const result = await caller.execAgent({ agentId: agent.id, prompt: 'Hello' });
    await waitForOperationComplete(inMemoryAgentStateManager, result.operationId);

    const callArgs = mockResponsesCreate.mock.calls[0][0] as { tools?: any[] };
    expect(memoryOffered(callArgs)).toBe(false);
  });

  it('should enable memory by default when neither agent nor user configures it', async () => {
    const agent = await createTestAgent();

    const caller = aiAgentRouter.createCaller(createTestContext());
    const result = await caller.execAgent({ agentId: agent.id, prompt: 'Hello' });
    await waitForOperationComplete(inMemoryAgentStateManager, result.operationId);

    const callArgs = mockResponsesCreate.mock.calls[0][0] as { tools?: any[] };
    expect(memoryOffered(callArgs)).toBe(true);
  });

  it('injects pinned rules with byte-for-byte identical prefix across Turn 1 & Turn 2, and addPreferenceMemory mid-dialog never alters the prefix', async () => {
    const { UserMemoryPreferenceModel } = await import('@/database/models/userMemory/preference');
    const { UserPersonaModel } = await import('@/database/models/userMemory/persona');
    const { memoryRuntime } = await import('@/server/services/toolExecution/serverRuntimes/memory');

    const prefModel = new UserMemoryPreferenceModel(serverDB, userId);
    const rule1 = await prefModel.createRule('Отвечай кратко и по делу');
    const rule2 = await prefModel.createRule('Цены и расчёты всегда в ₽');
    const personaModel = new UserPersonaModel(serverDB, userId);
    await personaModel.upsertPersona({
      editedBy: 'agent',
      persona: 'Основатель дизайн-студии в Москве.',
      tagline: 'Владелец студии',
    });

    const agent = await createTestAgent();
    const caller = aiAgentRouter.createCaller(createTestContext());

    // Turn 1
    const turn1 = await caller.execAgent({ agentId: agent.id, prompt: 'Привет, посчитай смету' });
    await waitForOperationComplete(inMemoryAgentStateManager, turn1.operationId);

    const turn1Call = mockResponsesCreate.mock.calls[0][0] as {
      input?: any[];
      instructions?: string;
    };
    // input[0] is the system/developer prefix; input[1] is the injected <user_memory> user message before the first conversation turn!
    const turn1PrefixStr = JSON.stringify(turn1Call.input?.slice(0, 2));
    expect(turn1PrefixStr).toContain('<user_memory>');
    expect(turn1PrefixStr).toContain(rule1.item.id);
    expect(turn1PrefixStr).toContain('Отвечай кратко и по делу');
    expect(turn1PrefixStr).toContain(rule2.item.id);
    expect(turn1PrefixStr).toContain('Цены и расчёты всегда в ₽');
    expect(turn1PrefixStr).toContain('Основатель дизайн-студии в Москве.');

    // Mid-dialog tool call: model calls addPreferenceMemory (even trying to pass type='rule'!)
    const runtimeExec = await memoryRuntime.factory({
      serverDB,
      userId,
    } as any);

    // Mock embeddings on OpenAI prototype so addPreferenceMemory succeeds cleanly without network
    const embedSpy = vi
      .spyOn(OpenAI.Embeddings.prototype, 'create')
      .mockResolvedValue({
        data: [{ embedding: Array.from({ length: 1024 }, () => 0.01) }],
      } as any);

    const addRes = await (runtimeExec as any).addPreferenceMemory({
      details: 'Wants bullet lists',
      memoryCategory: 'style',
      memoryType: 'preference',
      summary: 'Bullet lists',
      tags: ['lists'],
      title: 'Bullet lists',
      withPreference: {
        appContext: null,
        conclusionDirectives: 'Используй маркированные списки',
        extractedLabels: [],
        extractedScopes: [],
        originContext: null,
        scorePriority: 0.9,
        suggestions: [],
        type: 'rule', // Attempted rule injection via tool!
      },
    });
    expect(addRes.success).toBe(true);

    // Turn 2 in the SAME topic
    mockResponsesCreate.mockResolvedValueOnce(createMockResponsesAPIStream('Готово') as any);
    const turn2 = await caller.execAgent({
      agentId: agent.id,
      appContext: { topicId: turn1.topicId },
      prompt: 'А теперь добавь налог',
    });
    await waitForOperationComplete(inMemoryAgentStateManager, turn2.operationId);

    const turn2Call = mockResponsesCreate.mock.calls[1][0] as {
      input?: any[];
      instructions?: string;
    };

    // Byte-for-byte identical instructions and [input[0], input[1] (<user_memory>)] prefix across Turn 1 and Turn 2!
    expect(turn2Call.instructions).toBe(turn1Call.instructions);
    expect(JSON.stringify(turn2Call.input?.[0])).toBe(JSON.stringify(turn1Call.input?.[0]));
    expect(JSON.stringify(turn2Call.input?.slice(0, 2))).toBe(turn1PrefixStr);
    expect(JSON.stringify(turn2Call.input?.slice(0, 2))).not.toContain(
      'Используй маркированные списки',
    );

    embedSpy.mockRestore();
  });

  it('blocks injection of rules and persona when chatConfig.memory.enabled = false, and marks Data Guard topics atomically', async () => {
    const { UserMemoryPreferenceModel } = await import('@/database/models/userMemory/preference');
    const { UserPersonaModel } = await import('@/database/models/userMemory/persona');
    const { topics } = await import('@lobechat/database/schemas');

    const prefModel = new UserMemoryPreferenceModel(serverDB, userId);
    await prefModel.createRule('Секретное правило пользователя');
    await new UserPersonaModel(serverDB, userId).upsertPersona({
      editedBy: 'agent',
      persona: 'Персона пользователя',
    });

    const disabledAgent = await createTestAgent({ memory: { enabled: false } });
    const [existingTopic] = await serverDB
      .insert(topics)
      .values({
        agentId: disabledAgent.id,
        metadata: { customKey: 'keep-me' } as any,
        title: 'Protected topic',
        userId,
      })
      .returning();

    const { AiAgentService } = await import('@/server/services/aiAgent');
    const aiAgentService = new AiAgentService(serverDB, userId);
    const res = await aiAgentService.execAgent({
      agentId: disabledAgent.id,
      appContext: { topicId: existingTopic.id },
      chatConfigOverride: { deepseekDataGuardProtected: true } as any,
      prompt: 'Проверка Data Guard',
    });
    await waitForOperationComplete(inMemoryAgentStateManager, res.operationId);

    const callArgs = mockResponsesCreate.mock.calls[0][0] as {
      input?: any[];
      instructions?: string;
    };
    const serialized = JSON.stringify([callArgs.instructions ?? '', callArgs.input ?? '']);
    expect(serialized).not.toContain('<user_memory>');
    expect(serialized).not.toContain('Секретное правило пользователя');
    expect(serialized).not.toContain('Персона пользователя');

    const updatedTopic = await serverDB.query.topics.findFirst({
      where: eq(topics.id, existingTopic.id),
    });
    expect(updatedTopic?.metadata).toMatchObject({
      customKey: 'keep-me',
      dataGuardProtected: true,
    });
  });

  it('increments accessed_count in searchUserMemory across all 5 layers', async () => {
    const { memoryRuntime } = await import('@/server/services/toolExecution/serverRuntimes/memory');
    const { userMemories, users } = await import('@lobechat/database/schemas');

    const otherUserId = `${userId}-other`;
    await serverDB.insert(users).values({ id: otherUserId });

    const [actMem, ctxMem1, ctxMem2, expMem, idMem, prefMem] = await serverDB
      .insert(userMemories)
      .values([
        { lastAccessedAt: new Date(0), title: 'Act', userId },
        { lastAccessedAt: new Date(0), title: 'Ctx1', userId },
        { lastAccessedAt: new Date(0), title: 'Ctx2', userId },
        { lastAccessedAt: new Date(0), title: 'Exp', userId },
        { lastAccessedAt: new Date(0), title: 'Id', userId },
        { lastAccessedAt: new Date(0), title: 'Pref', userId },
      ])
      .returning();
    const [otherMem] = await serverDB
      .insert(userMemories)
      .values({ lastAccessedAt: new Date(0), title: 'Other', userId: otherUserId })
      .returning();

    const runtimeExec = await memoryRuntime.factory({
      serverDB,
      userId,
    } as any);

    const searchSpy = vi
      .spyOn((runtimeExec as any).service.memoryModel, 'searchMemory')
      .mockResolvedValue({
        activities: [{ id: 'act_1', narrative: 'Meeting', userMemoryId: actMem.id } as any],
        contexts: [
          {
            description: 'Project',
            id: 'ctx_1',
            title: 'Proj',
            userMemoryIds: [ctxMem1.id, ctxMem2.id, otherMem.id],
          } as any,
        ],
        experiences: [
          { id: 'exp_1', keyLearning: 'Learn', situation: 'Sit', userMemoryId: expMem.id } as any,
        ],
        identities: [{ description: 'Engineer', id: 'id_1', userMemoryId: idMem.id } as any],
        meta: { appliedFilters: {}, appliedQueries: [], layers: {} } as any,
        preferences: [
          {
            conclusionDirectives: 'Use Vitest',
            id: 'pref_1',
            scorePriority: 0.9,
            type: 'tech',
            userMemoryId: prefMem.id,
          } as any,
        ],
      });

    const searchOut = await runtimeExec.searchUserMemory({
      queries: [],
    });
    expect(searchOut.success).toBe(true);

    for (const ownId of [actMem.id, ctxMem1.id, ctxMem2.id, expMem.id, idMem.id, prefMem.id]) {
      const row = await serverDB.query.userMemories.findFirst({
        where: eq(userMemories.id, ownId),
      });
      expect(Number(row?.accessedCount ?? 0)).toBe(1);
      expect(row?.lastAccessedAt.getTime()).toBeGreaterThan(0);
    }

    // Other user's memory ID MUST NOT be incremented!
    const otherRow = await serverDB.query.userMemories.findFirst({
      where: eq(userMemories.id, otherMem.id),
    });
    expect(Number(otherRow?.accessedCount ?? 0)).toBe(0);

    searchSpy.mockRestore();
    await cleanupTestUser(serverDB, otherUserId);
  });
});
