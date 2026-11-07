// @vitest-environment node
import type { LobeChatDatabase } from '@lobechat/database';
import type { ChatToolPayload } from '@lobechat/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { BuiltinToolsExecutor } from '../builtin';
import { ToolExecutionService } from '../index';
import type { ToolExecutionContext, ToolExecutionResultResponse } from '../types';
import { agentDocumentsRuntime } from './agentDocuments';

interface StoredDocument {
  agentId: string;
  content: string;
  filename: string;
  id: string;
  title: string;
  userId: string;
}

interface PageState {
  complete: boolean;
  content: string;
  endOffset: number;
  eof: boolean;
  nextOffset: number | null;
  snapshot: string;
  startOffset: number;
  totalLength: number;
}

// Only the owner-scoped model boundary is replaced. The adapter, document
// service (including the expected-agent check), runtime, shared reader and
// final ToolExecutionService truncation/error handling all run unchanged.
const { documents } = vi.hoisted(() => ({ documents: new Map<string, StoredDocument>() }));
vi.mock('@/database/models/agentDocuments', () => ({
  AgentDocumentModel: class {
    constructor(
      _db: unknown,
      private userId: string,
    ) {}
    async findById(id: string) {
      const doc = documents.get(id);
      return doc?.userId === this.userId ? doc : undefined;
    }
    async findByFilename(agentId: string, filename: string) {
      return [...documents.values()].find(
        (doc) => doc.userId === this.userId && doc.agentId === agentId && doc.filename === filename,
      );
    }
  },
  buildDocumentFilename: vi.fn(),
}));
vi.mock('@/server/services/discover', () => ({ DiscoverService: class {} }));
vi.mock('@/server/services/mcp/contentProcessor', () => ({ contentBlocksToString: vi.fn() }));

const context: ToolExecutionContext = {
  agentId: 'agent-1',
  serverDB: {} as LobeChatDatabase,
  toolManifestMap: {},
  toolResultMaxLength: 250,
  userId: 'owner',
};

const service = new ToolExecutionService({
  builtinToolsExecutor: {
    async execute(payload: ChatToolPayload, ctx: ToolExecutionContext) {
      const runtime = agentDocumentsRuntime.factory(ctx);
      return runtime[payload.apiName](JSON.parse(payload.arguments), ctx);
    },
  } as unknown as BuiltinToolsExecutor,
  mcpService: {} as never,
});

const read = (args: Record<string, unknown>, apiName = 'readDocument', ctx = context) =>
  service.executeTool(
    {
      apiName,
      arguments: JSON.stringify(args),
      id: 'read-call',
      identifier: 'lobe-agent-documents',
      type: 'builtin',
    },
    ctx,
  );

const pageOf = (result: ToolExecutionResultResponse): PageState => {
  expect(result.success).toBe(true);
  return result.state as PageState;
};

beforeEach(() => {
  documents.clear();
  documents.set('doc-1', {
    agentId: 'agent-1',
    content: 'original',
    filename: 'rules.md',
    id: 'doc-1',
    title: 'Rules',
    userId: 'owner',
  });
});

describe('agent document source pages through the complete tool response pipeline', () => {
  it.each([30229, 120009])(
    'reconstructs all %i source characters without gaps or generic truncation',
    async (length) => {
      const original =
        length === 30229 ? 'Ж'.repeat(length) : ('x'.repeat(19999) + '😀').repeat(6) + 'END';
      documents.get('doc-1')!.content = original;
      let offset = 0;
      let snapshot: string | undefined;
      let reconstructed = '';
      for (let count = 0; count < 20; count++) {
        const result = await read({ id: 'doc-1', offset, snapshot });
        const page = pageOf(result);
        expect(page.startOffset).toBe(offset);
        expect(page.totalLength).toBe(original.length);
        expect(result.content).not.toContain('[Content truncated:');
        expect(result.content).toContain(page.snapshot);
        expect(page.content.length).toBeLessThanOrEqual(20000);
        expect(page.snapshot).toBe(snapshot ?? page.snapshot);
        reconstructed += page.content;
        snapshot = page.snapshot;
        if (page.nextOffset === null) {
          expect(page.eof).toBe(true);
          break;
        }
        expect(page.eof).toBe(false);
        expect(page.nextOffset).toBeGreaterThan(offset);
        offset = page.nextOffset;
      }
      expect(reconstructed).toBe(original);
      expect(documents.get('doc-1')!.content).toBe(original);
    },
  );

  it('honours an arbitrary offset/page size and numeric strings produced by older calls', async () => {
    const original = 'start'.repeat(6000) + 'END';
    documents.get('doc-1')!.content = original;
    const first = pageOf(await read({ id: 'doc-1', limit: '6000', offset: '24500' }));
    expect(first.content).toBe(original.slice(24500));
    expect(first.startOffset).toBe(24500);
    expect(first.nextOffset).toBeNull();
    expect(first.eof).toBe(true);
    const middle = pageOf(await read({ id: 'doc-1', limit: 17, offset: 12345 }));
    expect(middle.content).toBe(original.slice(12345, 12362));
    expect(middle.nextOffset).toBe(12362);
  });

  it('provides the same continuation contract for reads by filename', async () => {
    const original = 'a'.repeat(30229);
    documents.get('doc-1')!.content = original;
    const first = pageOf(await read({ filename: 'rules.md' }, 'readDocumentByFilename'));
    const last = pageOf(
      await read(
        { filename: 'rules.md', offset: first.nextOffset, snapshot: first.snapshot },
        'readDocumentByFilename',
      ),
    );
    expect(first.content + last.content).toBe(original);
    expect(last.eof).toBe(true);
  });

  it('searches for a literal heading near EOF without confusing search with full coverage', async () => {
    documents.get('doc-1')!.content =
      'preamble '.repeat(12000) + '\n# [A+B](C)\nFinal requirements';
    const result = await read({ id: 'doc-1', limit: 2000, query: '[A+B](C)' });
    const page = pageOf(result);
    expect(page.content).toContain('# [A+B](C)');
    expect(page.complete).toBe(false);
    expect(result.content).toContain('Search hits are not exhaustive');
    expect(result.content.length).toBeLessThan(22000);
  });

  it('refuses a changed snapshot as a replan, preserving the new document and not mixing source versions', async () => {
    documents.get('doc-1')!.content = 'old '.repeat(10000);
    const initial = pageOf(await read({ id: 'doc-1' }));
    documents.get('doc-1')!.content = 'NEW-REPLACEMENT';
    const result = await read({
      id: 'doc-1',
      offset: initial.nextOffset,
      snapshot: initial.snapshot,
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({ code: 'DOCUMENT_CHANGED', kind: 'replan', status: 409 });
    expect(result.content).toContain('Restart reading at offset=0');
    expect(result.content).not.toContain('NEW-REPLACEMENT');
    expect(result.state).toBeUndefined();
    expect(documents.get('doc-1')!.content).toBe('NEW-REPLACEMENT');
  });

  it.each([{ userId: 'someone-else' }, { agentId: 'another-agent' }])(
    'does not expose pages from another owner or agent: %j',
    async (scope) => {
      documents.get('doc-1')!.content = 'PRIVATE-SOURCE-CONTENT';
      const result = await read({ id: 'doc-1' }, 'readDocument', { ...context, ...scope });
      expect(result.success).toBe(false);
      expect(result.content).not.toContain('PRIVATE-SOURCE-CONTENT');
      expect(result.state).toBeUndefined();
    },
  );

  it.each([
    { offset: -1 },
    { offset: 'garbage' },
    { limit: 0 },
    { limit: 2, query: 'heading' },
    { query: 'q'.repeat(501) },
    { snapshot: 'wrong' },
  ])('rejects invalid reader options instead of silently restarting: %j', async (options) => {
    const result = await read({ id: 'doc-1', ...options });
    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({ code: 'INVALID_ARGUMENT', kind: 'replan' });
  });
});
