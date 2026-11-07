// @vitest-environment node
import type { LobeChatDatabase } from '@lobechat/database';
import { agents, users } from '@lobechat/database/schemas';
import { getTestDB } from '@lobechat/database/test-utils';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AgentDocumentModel } from '@/database/models/agentDocuments';

import type { BuiltinToolsExecutor } from '../builtin';
import { ToolExecutionService } from '../index';
import type { ToolExecutionContext } from '../types';
import { agentDocumentsRuntime } from './agentDocuments';

vi.mock('@/server/services/discover', () => ({ DiscoverService: class {} }));
vi.mock('@/server/services/mcp/contentProcessor', () => ({ contentBlocksToString: vi.fn() }));

describe('agent document page ownership with real in-memory SQL records', () => {
  let db: LobeChatDatabase;
  let documentId: string;
  const original = 'Q'.repeat(30229) + 'PRIVATE-END';
  const userId = 'document-page-owner';
  const agentId = 'document-page-agent';

  const execute = (apiName: string, args: Record<string, unknown>, scope = { agentId, userId }) => {
    const context: ToolExecutionContext = {
      ...scope,
      serverDB: db,
      toolManifestMap: {},
      toolResultMaxLength: 250,
    };
    const service = new ToolExecutionService({
      builtinToolsExecutor: {
        async execute(payload, ctx) {
          const runtime = agentDocumentsRuntime.factory(ctx);
          return runtime[payload.apiName](JSON.parse(payload.arguments), ctx);
        },
      } as BuiltinToolsExecutor,
      mcpService: {} as never,
    });
    return service.executeTool(
      {
        apiName,
        arguments: JSON.stringify(args),
        id: 'page-call',
        identifier: 'lobe-agent-documents',
        type: 'builtin',
      },
      context,
    );
  };

  beforeAll(async () => {
    // TEST_SERVER_DB=0 keeps this on PGlite; no external DB connection exists.
    db = await getTestDB();
    await db.insert(users).values([{ id: userId }, { id: 'document-page-other' }]);
    await db.insert(agents).values([
      { id: agentId, userId },
      { id: 'document-page-other-agent', userId },
    ]);
    const doc = await new AgentDocumentModel(db, userId).create(agentId, 'rules.md', original);
    documentId = doc.id;
  }, 60_000);

  afterAll(async () => {
    if (db) await db.delete(users);
  });

  it('retrieves the entire stored source through page cursors and the actual adapter/service/model', async () => {
    const first = await execute('readDocument', { id: documentId });
    expect(first.success).toBe(true);
    expect(first.state?.content).toBe(original.slice(0, 20000));
    const last = await execute('readDocument', {
      id: documentId,
      offset: first.state?.nextOffset,
      snapshot: first.state?.snapshot,
    });
    expect(last.success).toBe(true);
    expect(first.state?.content + last.state?.content).toBe(original);
    expect(last.state?.eof).toBe(true);
    expect(last.content).not.toContain('[Content truncated:');
  });

  it.each([
    { agentId, userId: 'document-page-other' },
    { agentId: 'document-page-other-agent', userId },
  ])('refuses the document by ID and filename outside its scope: %j', async (scope) => {
    for (const [apiName, args] of [
      ['readDocument', { id: documentId }],
      ['readDocumentByFilename', { filename: 'rules.md' }],
    ] as const) {
      const result = await execute(apiName, args, scope);
      expect(result.success).toBe(false);
      expect(result.state).toBeUndefined();
      expect(result.content).not.toContain('PRIVATE-END');
    }
    expect((await new AgentDocumentModel(db, userId).findById(documentId))?.content).toBe(original);
  });
});
