// @vitest-environment node
import type { LobeChatDatabase } from '@lobechat/database';
import { agents } from '@lobechat/database/schemas';
import { getTestDB } from '@lobechat/database/test-utils';
import OpenAI from 'openai';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { inMemoryAgentStateManager } from '@/server/modules/AgentRuntime/InMemoryAgentStateManager';
import { inMemoryStreamEventManager } from '@/server/modules/AgentRuntime/InMemoryStreamEventManager';
import {
  createMockResponsesAPIStream,
  createMockResponsesStream,
} from '@/server/routers/lambda/__tests__/integration/aiAgent/helpers';
import { createTestUser } from '@/server/routers/lambda/__tests__/integration/setup';
import { AgentRuntimeService } from '@/server/services/agentRuntime';
import { TextFileStore } from '@/server/services/textFiles/store';

import { AiAgentService } from '../index';

let db: LobeChatDatabase;
vi.mock('@/database/core/db-adaptor', () => ({ getServerDB: () => db }));
const { bytes } = vi.hoisted(() => ({ bytes: new Map<string, Buffer>() }));
vi.mock('@/server/services/file', () => ({
  FileService: class {
    getFullFileUrl = async (key: string) => key;
    uploadBuffer = async (key: string, buffer: Buffer) => {
      bytes.set(key, Buffer.from(buffer));
      return { key };
    };
    getFileByteArray = async (key: string) => bytes.get(key);
  },
}));

function toolResponse(name: string, args: Record<string, unknown>, callId: string) {
  const item = { arguments: JSON.stringify(args), call_id: callId, name, type: 'function_call' };
  return createMockResponsesStream([
    { type: 'response.created', response: { id: callId, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item },
    {
      type: 'response.completed',
      response: {
        id: callId,
        status: 'completed',
        output: [item],
        usage: { input_tokens: 30, output_tokens: 10, total_tokens: 40 },
      },
    },
  ]);
}

describe('Studio automatic file writing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    inMemoryAgentStateManager.clear();
    inMemoryStreamEventManager.clear();
    bytes.clear();
  });

  it('advertises only the catalogue entry, activates with topic-reference, stays active in the 4-turn window, and drops after inactivity', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-offline-fixture');
    vi.stubEnv('ARCKEP_HEADLESS_TOOLS', '1');
    db = await getTestDB();
    const userId = await createTestUser(db);
    const [agent] = await db
      .insert(agents)
      .values({ model: 'gpt-5-pro', provider: 'openai', systemRole: 'Test', title: 'Test', userId })
      .returning();
    const service = new AiAgentService(db, userId);
    const runtime = new AgentRuntimeService(db, userId, { queueService: null });
    const run = async (prompt: string, topicId?: string) => {
      const op = await service.execAgent({
        agentId: agent.id,
        appContext: topicId ? { topicId } : undefined,
        autoStart: false,
        prompt,
        studioTextFilesEnabled: true,
        studioWebChat: true,
      });
      await runtime.executeSync(op.operationId);
      return op.topicId;
    };
    const captured: Array<{ tools: string[]; input: string }> = [];
    const fileName = 'Модуль.ts';
    const text = 'export const value = 42;\n';
    const sdk = vi.spyOn(OpenAI.Responses.prototype, 'create');
    sdk.mockImplementation((async (params: any) => {
      const tools: string[] = (params.tools ?? []).flatMap((tool: { name?: string }) =>
        tool.name ? [tool.name] : [],
      );
      captured.push({ tools, input: JSON.stringify([params.input, params.instructions]) });
      if (captured.length === 2)
        return toolResponse(
          tools.find((n) => n.includes('activateTools'))!,
          { identifiers: ['arckep-text-file'] },
          'call_activate',
        );
      if (captured.length === 3)
        return toolResponse(
          tools.find((n) => n.includes('writePart'))!,
          { fileName, final: true, part: 1, text },
          'call_write',
        );
      // Turn 6 (after 3 idle turns, outside RECENT_ACTIVE_TOOL_USER_MESSAGES = 4): stale writePart must fail
      if (captured.length === 8)
        return toolResponse(
          'arckep-text-file____writePart____builtin',
          { fileName: 'unexpected', final: true, part: 1, text },
          'call_stale',
        );
      return createMockResponsesAPIStream('Готово');
    }) as any);
    const topicId = await run('Привет'); // captured[0]
    await run('Собери модуль', topicId); // captured[1] activate -> captured[2] writePart -> captured[3] done
    await run('Как дела?', topicId); // captured[4] (still inside 4-turn window -> stays active!)
    await run('Что ещё?', topicId); // captured[5] (still inside 4-turn window)
    await run('Про погоду', topicId); // captured[6] (still inside 4-turn window)
    await run('Давний вопрос', topicId); // captured[7] (dropped! stale call fails) -> captured[8] done
    expect(captured).toHaveLength(9);

    // Before activation (Turn 1, Turn 2 step 0) and after 4-turn window expires (Turn 6): schema absent
    for (const i of [0, 1, 7]) {
      expect(captured[i].tools.some((name) => name.includes('activateTools'))).toBe(true);
      expect(captured[i].tools.some((name) => name.includes('writePart'))).toBe(false);
      expect(captured[i].tools.some((name) => name.includes('patchFile'))).toBe(false);
      expect(captured[i].input).toContain('Создать файл с полным модулем');
      expect(captured[i].input).not.toContain('Prefer patchFile to atomically edit');
    }

    // Immediately after activateTools(['arckep-text-file']): writePart + patchFile + co-activated getTopicContext
    expect(captured[2].tools.some((name) => name.includes('writePart'))).toBe(true);
    expect(captured[2].tools.some((name) => name.includes('patchFile'))).toBe(true);
    expect(captured[2].tools.some((name) => name.includes('getTopicContext'))).toBe(true);

    // On the next turn inside the 4-turn window: arckep-text-file + topic-reference STAY active (no re-activation!)
    expect(captured[4].tools.some((name) => name.includes('writePart'))).toBe(true);
    expect(captured[4].tools.some((name) => name.includes('patchFile'))).toBe(true);
    expect(captured[4].tools.some((name) => name.includes('getTopicContext'))).toBe(true);

    expect(
      (sdk.mock.calls[2][0].tools as Array<{ name?: string; parameters?: unknown }>).find((tool) =>
        tool.name?.includes('writePart'),
      )?.parameters,
    ).toMatchObject({
      required: expect.arrayContaining(['fileName', 'part', 'text', 'final']),
      properties: { documentId: { type: 'string' }, text: { type: 'string' } },
    });
    expect(
      (sdk.mock.calls[2][0].tools as Array<{ name?: string; parameters?: unknown }>).find((tool) =>
        tool.name?.includes('patchFile'),
      )?.parameters,
    ).toMatchObject({
      required: ['edits'],
      properties: {
        documentId: { type: 'string' },
        edits: { type: 'array' },
        sourceFileId: { type: 'string' },
      },
    });
    const files = await new TextFileStore(db, userId, topicId).list();
    expect(files).toHaveLength(1);
    const [file] = files;
    expect(file).toMatchObject({ fileName, part: 1, status: 'ready' });
    expect([...bytes.values()]).toEqual([Buffer.from(text)]);
  }, 60_000);
});
