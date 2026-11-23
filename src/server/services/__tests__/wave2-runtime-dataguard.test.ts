// @vitest-environment node
/* eslint-disable unicorn/text-encoding-identifier-case */
import { createHash } from 'node:crypto';

import { AgentRuntime, type AgentState } from '@lobechat/agent-runtime';
import {
  buildReadOnlyProjectWorkspaceManifest,
  PROJECT_WORKSPACE_TOOL,
  ProjectWorkspaceManifest,
} from '@lobechat/builtin-tools';
import { ToolNameResolver } from '@lobechat/context-engine';
import type { ChatStreamPayload } from '@lobechat/model-runtime';
import type { UIChatMessage } from '@lobechat/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  agents,
  knowledgeBases,
  messagesFiles,
  projectWorkspaceFiles,
  topics,
} from '@/database/schemas';
import {
  isDeepSeekDataGuardProtected,
  resolveCompressionModelConfig,
} from '@/server/modules/AgentRuntime/compressionThresholds';
import {
  createRuntimeExecutors,
  type RuntimeExecutorContext,
} from '@/server/modules/AgentRuntime/RuntimeExecutors';
import type * as ContextEngineeringModule from '@/server/modules/Mecha/ContextEngineering';
import { serverMessagesEngine } from '@/server/modules/Mecha/ContextEngineering';
import { initModelRuntimeFromDB } from '@/server/modules/ModelRuntime';
import type * as DataGuardModule from '@/server/services/projectWorkspace/dataGuard';
import {
  applySandboxProjectFileSync,
  listHydratableProjectFiles,
} from '@/server/services/projectWorkspace/sandboxBridge';
import { ToolExecutionService } from '@/server/services/toolExecution';
import {
  DATA_GUARD_EMPTY_PROTECTED_KB_MESSAGE,
  DATA_GUARD_FILE_MASKED_CONTENT,
  DATA_GUARD_SEARCH_BLOCKED_MESSAGE,
  knowledgeBaseRuntime,
} from '@/server/services/toolExecution/serverRuntimes/knowledgeBase';
import {
  MAX_WRITE_TOOL_CONTENT_BYTES,
  projectWorkspaceRuntime,
  resetProjectWorkspaceWriteLimiterForTests,
  WORKSPACE_CHANGE_MARKER_PREFIX,
  WORKSPACE_PROPOSAL_MARKER_PREFIX,
} from '@/server/services/toolExecution/serverRuntimes/projectWorkspace';
import {
  compactTopic,
  resetInFlightTopicCompactionsForTests,
} from '@/server/services/topic/compactTopic';

const mocks = vi.hoisted(() => ({
  chat: vi.fn(),
  computeWorkspaceDataGuardState: vi.fn(),
  consumeStreamUntilDone: vi.fn(async () => undefined),
  getFileContents: vi.fn(),
  maskUnmaskedWorkspaceHistoryForSummarizer: vi.fn(),
  messageQueryWithWhere: vi.fn(),
  patchAgentTextFile: vi.fn(),
  semanticSearchForChat: vi.fn(),
  upsertRollingCompressionGroup: vi.fn(),
  writeAgentTextFile: vi.fn(),
  writeProjectFilePart: vi.fn(),
}));

vi.mock('@/server/services/knowledgeRetrieval', () => ({
  KnowledgeRetrievalService: vi.fn().mockImplementation(() => ({
    getFileContents: mocks.getFileContents,
    semanticSearchForChat: mocks.semanticSearchForChat,
  })),
}));

vi.mock('@/server/modules/Mecha/ContextEngineering', async (importOriginal) => {
  const actual = await importOriginal<typeof ContextEngineeringModule>();
  return {
    ...actual,
    serverMessagesEngine: vi.fn(actual.serverMessagesEngine),
  };
});

vi.mock('@/server/modules/ModelRuntime', () => ({
  initModelRuntimeFromDB: vi.fn(async () => ({
    chat: mocks.chat,
  })),
}));

vi.mock('@lobechat/model-runtime', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    consumeStreamUntilDone: mocks.consumeStreamUntilDone,
  };
});

vi.mock('@/database/models/message', () => ({
  MessageModel: class {
    queryWithWhere = mocks.messageQueryWithWhere;
  },
}));

vi.mock('@/server/services/message', () => ({
  MessageService: class {
    createSpreadsheetFile = vi.fn();
    upsertRollingCompressionGroup = mocks.upsertRollingCompressionGroup;
  },
}));

vi.mock('@/server/services/projectWorkspace/dataGuard', async (importOriginal) => {
  const actual = await importOriginal<typeof DataGuardModule>();
  return {
    ...actual,
    computeWorkspaceDataGuardState: (...args: any[]) =>
      mocks.computeWorkspaceDataGuardState(...args),
  };
});

vi.mock('@/server/services/projectWorkspace', async (importOriginal) => {
  const actual = await importOriginal<Record<string, any>>();
  return {
    ...actual,
    ProjectWorkspaceStore: vi.fn().mockImplementation(() => ({
      patchAgentTextFile: mocks.patchAgentTextFile,
      writeAgentTextFile: mocks.writeAgentTextFile,
    })),
    computeWorkspaceDataGuardState: (...args: any[]) =>
      mocks.computeWorkspaceDataGuardState(...args),
    writeProjectFilePart: (...args: any[]) => mocks.writeProjectFilePart(...args),
  };
});

vi.mock('@/server/services/projectWorkspace/store', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, any>;
  return {
    ...actual,
    ProjectWorkspaceStore: vi.fn().mockImplementation(() => ({
      patchAgentTextFile: mocks.patchAgentTextFile,
      writeAgentTextFile: mocks.writeAgentTextFile,
    })),
  };
});

const defaultMaskImpl = <T extends Record<string, any>>(msgs: T[]): T[] => {
  const MASKED_BODY = '[Содержимое незащищённого файла проекта скрыто в защищённом режиме]';
  const MASKED_ARGS = '{"masked":"[Data Guard]"}';
  const sensitiveIds = new Set<string>();

  const firstPass = msgs.map((m) => {
    if (!m || m.role !== 'assistant') return m;
    let changed = false;
    let nextTools = m.tools;
    if (Array.isArray(m.tools)) {
      nextTools = m.tools.map((t: any) => {
        if (t?.identifier === 'arckep-workspace' || t?.apiName === 'searchKnowledgeBase') {
          if (t.id) sensitiveIds.add(t.id);
          changed = true;
          return { ...t, arguments: MASKED_ARGS };
        }
        return t;
      });
    }
    let nextCalls = m.tool_calls;
    if (Array.isArray(m.tool_calls)) {
      nextCalls = m.tool_calls.map((tc: any) => {
        const name = String(tc?.function?.name ?? '');
        if (
          name.includes('arckep-workspace') ||
          name.includes('searchKnowledgeBase') ||
          (tc?.id && sensitiveIds.has(tc.id))
        ) {
          if (tc.id) sensitiveIds.add(tc.id);
          changed = true;
          return { ...tc, function: { ...tc.function, arguments: MASKED_ARGS } };
        }
        return tc;
      });
    }
    return changed
      ? {
          ...m,
          ...(nextTools ? { tools: nextTools } : {}),
          ...(nextCalls ? { tool_calls: nextCalls } : {}),
        }
      : m;
  });

  return firstPass.map((m) => {
    if (!m || m.role !== 'tool') return m;
    const isSensitive =
      (m.tool_call_id && sensitiveIds.has(m.tool_call_id)) ||
      m.plugin?.identifier === 'arckep-workspace' ||
      m.plugin?.apiName === 'searchKnowledgeBase' ||
      String(m.name ?? '').includes('arckep-workspace') ||
      String(m.name ?? '').includes('searchKnowledgeBase');
    if (!isSensitive) return m;
    return {
      ...m,
      content: MASKED_BODY,
      ...(m.plugin ? { plugin: { ...m.plugin, arguments: MASKED_ARGS } } : {}),
    };
  });
};

describe('Wave 2: Engine Runtime, writeProjectFilePart, KnowledgeBase, SandboxBridge & /compact Data Guard 2A', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('ARCKEP_WORKSPACE_ENABLED', '1');
    resetProjectWorkspaceWriteLimiterForTests();
    resetInFlightTopicCompactionsForTests();

    mocks.maskUnmaskedWorkspaceHistoryForSummarizer.mockImplementation(defaultMaskImpl);
    mocks.computeWorkspaceDataGuardState.mockImplementation(async (params: any) => {
      const projectEnabled = Boolean(params?.agentChatConfig?.dataGuardProtected);
      return {
        dataGuardCommercial: Boolean(params?.agentChatConfig?.dataGuardCommercial),
        dataGuardProtected: Boolean(
          projectEnabled ||
          params?.agentChatConfig?.deepseekDataGuardProtected ||
          params?.requestDataGuardProtected,
        ),
        dataGuardProtectedSince: null,
        projectDataGuardEnabled: projectEnabled,
        unmaskedActiveCount: 0,
        workspaceDataGuardReady: projectEnabled,
      };
    });
  });

  afterEach(() => {
    resetProjectWorkspaceWriteLimiterForTests();
    resetInFlightTopicCompactionsForTests();
    vi.unstubAllEnvs();
  });

  it('1. ProjectWorkspaceManifest defines 7 tools, provider wire name length === 51 (< 64), and buildReadOnlyProjectWorkspaceManifest guides activateTools', () => {
    expect(ProjectWorkspaceManifest.api.map((a) => a.name)).toEqual([
      'listProjectFiles',
      'searchProjectFiles',
      'readProjectFile',
      'patchProjectFile',
      'writeProjectFile',
      'writeProjectFilePart',
      'deleteProjectFile',
    ]);

    const resolver = new ToolNameResolver();
    const wireName = resolver.generate(PROJECT_WORKSPACE_TOOL, 'writeProjectFilePart', 'builtin');
    expect(wireName).toBe('arckep-workspace____writeProjectFilePart____builtin');
    expect(wireName.length).toBe(51);
    expect(wireName.length).toBeLessThan(64);

    const partTool = ProjectWorkspaceManifest.api.find((a) => a.name === 'writeProjectFilePart')!;
    expect(partTool.parameters?.required).toEqual(['path', 'part', 'text', 'final']);
    expect((partTool.parameters?.properties as any).part).toMatchObject({
      maximum: 64,
      minimum: 1,
      type: 'integer',
    });
    expect((partTool.parameters?.properties as any).encoding.enum).toEqual([
      'utf-8',
      'utf-8-bom',
      'windows-1251',
    ]);
    expect((partTool.parameters?.properties as any).lineEnding.enum).toEqual([
      'lf',
      'crlf',
      'LF',
      'CRLF',
    ]);

    const writeTool = ProjectWorkspaceManifest.api.find((a) => a.name === 'writeProjectFile')!;
    expect(writeTool.description).toContain('64 KiB');
    expect(writeTool.description).toContain('writeProjectFilePart');

    const readOnlyManifest = buildReadOnlyProjectWorkspaceManifest();
    expect(readOnlyManifest.api.map((a) => a.name)).toEqual([
      'listProjectFiles',
      'readProjectFile',
    ]);
    expect(readOnlyManifest.systemRole).toContain('lobe-activator____activateTools');
    expect(readOnlyManifest.systemRole).toContain('arckep-workspace');
  });

  it('2. ToolExecutionService never truncates arckep-workspace receipts via truncateToolResult and forwards workspaceDataGuardReady', async () => {
    const trailingReceipt =
      'ARCKEP_WORKSPACE_CHANGE {"workspaceFileId":"wf-1","agentId":"agt-1","path":"src/huge.ts","action":"created","prevRevision":null,"revision":1,"addedLines":900,"removedLines":0,"authorType":"agent"}';
    const longWorkspaceOutput = `${'L1: const x = 1;\n'.repeat(800)}\n${trailingReceipt}`;
    let capturedCtx: any;

    const service = new ToolExecutionService({
      builtinToolsExecutor: {
        execute: vi.fn(async (_payload: any, ctx: any) => {
          capturedCtx = ctx;
          return {
            content: longWorkspaceOutput,
            success: true,
          };
        }),
      } as any,
      mcpService: {} as any,
    });

    const res = await service.executeTool(
      {
        apiName: 'writeProjectFilePart',
        arguments: '{}',
        id: 'tc-ws-notrunc',
        identifier: PROJECT_WORKSPACE_TOOL,
        type: 'builtin',
      } as any,
      {
        agentId: 'agt-1',
        dataGuardProtected: true,
        serverDB: {} as any,
        toolManifestMap: {},
        toolResultMaxLength: 500, // Even with an aggressive 500-char ceiling, arckep-workspace is exempt!
        topicId: 'tpc-1',
        userId: 'usr-1',
        workspaceDataGuardReady: true,
      },
    );

    expect(res.success).toBe(true);
    expect(res.content).toBe(longWorkspaceOutput);
    expect(res.content.endsWith(trailingReceipt)).toBe(true);
    expect(capturedCtx.workspaceDataGuardReady).toBe(true);
  });

  it('3. serverRuntimes/projectWorkspace: enforces 64 KiB hint on writeProjectFile, spends strictly 1 write slot on part===1 across 25 chunks, blocks !workspaceDataGuardReady, and writes dataGuardStatus="scrubbed" when ready', async () => {
    const baseCtx = {
      agentId: 'agt-1',
      operationId: 'op-25-chunks',
      serverDB: {} as any,
      toolManifestMap: {},
      topicId: 'tpc-1',
      userId: 'usr-1',
    };
    const runtime = await projectWorkspaceRuntime.factory(baseCtx as any);

    // 3a. >64 KiB in writeProjectFile returns explicit writeProjectFilePart hint WITHOUT spending a slot
    const oversizedText = 'A'.repeat(MAX_WRITE_TOOL_CONTENT_BYTES + 10);
    const overRes = await runtime.writeProjectFile({
      content: oversizedText,
      path: 'src/big.ts',
    });
    expect(overRes.success).toBe(false);
    expect(overRes.error?.code).toBe('FILE_TOO_LARGE');
    expect(overRes.content).toContain('writeProjectFilePart');
    expect(overRes.content).toContain('64 KiB');

    // 3b. Blocked when dataGuardProtected=true and workspaceDataGuardReady=false
    const blockedRes = await runtime.writeProjectFilePart(
      {
        final: false,
        part: 1,
        path: 'src/big.ts',
        text: 'chunk 1',
      },
      { ...baseCtx, dataGuardProtected: true, workspaceDataGuardReady: false } as any,
    );
    expect(blockedRes.success).toBe(false);
    expect(blockedRes.content).toContain('Data Guard');

    // 3c. Allowed when dataGuardProtected=true & workspaceDataGuardReady=true, spending ONLY 1 slot across 25 parts!
    mocks.writeProjectFilePart.mockImplementation(async (params: any) => {
      if (!params.final) {
        return {
          accumulatedBytes: params.part * 1024,
          kind: 'staged' as const,
          part: params.part,
          path: params.path,
          uploadId: params.uploadId ?? 'upl-25',
        };
      }
      if (params.path === 'AGENTS.md') {
        return {
          accumulatedBytes: 2048,
          kind: 'committed' as const,
          part: params.part,
          path: params.path,
          uploadId: params.uploadId ?? 'upl-prop',
          writeOutcome: {
            diffSummary: '@@ -1 +1,2 @@',
            outcome: 'proposal_created' as const,
            proposal: {
              addedLines: 20,
              agentId: params.agentId,
              baseRevision: 1,
              createdAt: '2026-11-23T12:00:00Z',
              diffPreview: '@@ -1 +1,20 @@',
              diffStats: { addedLines: 20, removedLines: 1 },
              id: 'prop-1',
              messageId: null,
              proposalType: 'edit' as const,
              proposedFileId: 'pf-1',
              reason: 'Update rules',
              removedLines: 1,
              resolvedAt: null,
              status: 'pending' as const,
              targetPath: 'AGENTS.md',
              topicId: params.topicId,
              workspaceFileId: 'wf-agents',
            },
          },
        };
      }
      return {
        accumulatedBytes: params.part * 1024,
        kind: 'committed' as const,
        part: params.part,
        path: params.path,
        uploadId: params.uploadId ?? 'upl-25',
        writeOutcome: {
          addedLines: 500,
          budget: {} as any,
          file: {
            agentId: params.agentId,
            currentRevision: 1,
            dataGuardStatus: params.dataGuardStatus,
            id: 'wf-25',
            path: params.path,
          } as any,
          outcome: 'created' as const,
          prevRevision: null,
          removedLines: 0,
        },
      };
    });

    const readyCtx = {
      ...baseCtx,
      dataGuardProtected: true,
      workspaceDataGuardReady: true,
    } as any;

    let uploadId = '';
    for (let part = 1; part <= 25; part++) {
      const isFinal = part === 25;
      const partRes = await runtime.writeProjectFilePart(
        {
          final: isFinal,
          part,
          path: 'src/twentyFiveParts.ts',
          text: `// part ${part}\n`,
          ...(part > 1 ? { uploadId } : {}),
        },
        readyCtx,
      );
      expect(partRes.success).toBe(true);
      if (!isFinal) {
        uploadId = (partRes.state as any).uploadId;
        expect(uploadId).toBe('upl-25');
        expect(partRes.content).not.toContain(WORKSPACE_CHANGE_MARKER_PREFIX);
      } else {
        expect(partRes.content).toContain(WORKSPACE_CHANGE_MARKER_PREFIX);
      }
    }

    // Verify dataGuardStatus: 'scrubbed' was passed on every call in ready Protected Project
    expect(
      mocks.writeProjectFilePart.mock.calls.every(
        ([callArg]) => callArg.dataGuardStatus === 'scrubbed',
      ),
    ).toBe(true);

    // 19 more distinct files (part=1) succeed (total = 1 + 19 = 20 mutations), and the 21st file (part=1) hits the 20-write limit!
    for (let fileIdx = 2; fileIdx <= 20; fileIdx++) {
      const r = await runtime.writeProjectFilePart(
        {
          final: true,
          part: 1,
          path: fileIdx === 20 ? 'AGENTS.md' : `src/file_${fileIdx}.ts`,
          text: 'ok\n',
        },
        readyCtx,
      );
      expect(r.success).toBe(true);
      if (fileIdx === 20) {
        expect(r.content).toContain(WORKSPACE_PROPOSAL_MARKER_PREFIX);
      }
    }

    const twentyFirstRes = await runtime.writeProjectFilePart(
      {
        final: true,
        part: 1,
        path: 'src/file_21.ts',
        text: 'blocked by slot limit\n',
      },
      readyCtx,
    );
    expect(twentyFirstRes.success).toBe(false);
    expect(twentyFirstRes.content).toContain('maximum 20 file mutations');
  });

  it('4. serverRuntimes/knowledgeBase: allows scrubbed project files + topic attachments in readKnowledge and scopes searchKnowledgeBase strictly to managed project_workspace KB', async () => {
    let managedKbRows: Array<{ id: string }> = [];
    const fakeDb = {
      select: vi.fn(() => {
        let sourceTable: unknown = null;
        const builder: any = {
          from: vi.fn((tbl: unknown) => {
            sourceTable = tbl;
            return builder;
          }),
          innerJoin: vi.fn(() => builder),
          where: vi.fn(async () => {
            if (sourceTable === messagesFiles) {
              return [{ fileId: 'file-topic-att' }];
            }
            if (sourceTable === projectWorkspaceFiles) {
              return [{ fileId: 'file-ws-scrubbed' }];
            }
            if (sourceTable === knowledgeBases) {
              return managedKbRows;
            }
            return [];
          }),
        };
        return builder;
      }),
    };

    mocks.getFileContents.mockImplementation(async (ids: string[]) =>
      ids.map((id) => ({
        content: `Scrubbed body of ${id}`,
        fileId: id,
        filename: `${id}.docx`,
        preview: `Preview ${id}`,
        totalCharCount: 24,
        totalLineCount: 1,
      })),
    );
    mocks.semanticSearchForChat.mockResolvedValue({
      chunks: [
        {
          fileId: 'file-ws-scrubbed',
          fileName: 'offer.docx',
          similarity: 0.91,
          text: '[КОМПАНИЯ_1] условия',
        },
      ],
      fileResults: [
        {
          fileId: 'file-ws-scrubbed',
          fileName: 'offer.docx',
          relevance: 0.91,
          topChunks: [{ similarity: 0.91, text: '[КОМПАНИЯ_1] условия' }],
        },
      ],
    });

    const readyKbRuntime = await knowledgeBaseRuntime.factory({
      agentId: 'agt-protected-1',
      dataGuardProtected: true,
      serverDB: fakeDb as any,
      toolManifestMap: {},
      topicId: 'tpc-1',
      userId: 'usr-1',
      workspaceDataGuardReady: true,
    });

    // 4a. readKnowledge permits topic attachment + scrubbed workspace file, masks unmasked/foreign fileId!
    const readOut = await readyKbRuntime.readKnowledge({
      fileIds: ['file-topic-att', 'file-ws-scrubbed', 'file-external-unmasked'],
    });
    expect(readOut.success).toBe(true);
    expect(mocks.getFileContents).toHaveBeenCalledWith(
      ['file-topic-att', 'file-ws-scrubbed'],
      undefined,
    );
    expect(readOut.content).toContain('Scrubbed body of file-topic-att');
    expect(readOut.content).toContain('Scrubbed body of file-ws-scrubbed');
    expect(readOut.content).toContain(DATA_GUARD_FILE_MASKED_CONTENT);

    // 4b. searchKnowledgeBase with 0 managed KBs returns empty message WITHOUT calling semanticSearchForChat!
    managedKbRows = [];
    const emptySearchOut = await readyKbRuntime.searchKnowledgeBase({ query: 'договор' });
    expect(emptySearchOut).toEqual({
      content: DATA_GUARD_EMPTY_PROTECTED_KB_MESSAGE,
      state: { chunks: [], fileResults: [], totalResults: 0 },
      success: true,
    });
    expect(mocks.semanticSearchForChat).not.toHaveBeenCalled();

    // 4c. searchKnowledgeBase with managed KB forces knowledgeIds=['kb-managed-1'], ignoring spoofed external knowledgeBaseIds!
    managedKbRows = [{ id: 'kb-managed-1' }];
    const managedSearchOut = await readyKbRuntime.searchKnowledgeBase(
      { query: 'условия' },
      { knowledgeBaseIds: ['kb-spoofed-external'] },
    );
    expect(managedSearchOut.success).toBe(true);
    expect(mocks.semanticSearchForChat).toHaveBeenCalledTimes(1);
    expect(mocks.semanticSearchForChat).toHaveBeenCalledWith(
      expect.objectContaining({
        knowledgeIds: ['kb-managed-1'],
        query: 'условия',
      }),
      undefined,
    );

    // 4d. When workspaceDataGuardReady=false, searchKnowledgeBase stays strictly blocked!
    const unreadyKbRuntime = await knowledgeBaseRuntime.factory({
      agentId: 'agt-unready',
      dataGuardProtected: true,
      serverDB: fakeDb as any,
      toolManifestMap: {},
      topicId: 'tpc-1',
      userId: 'usr-1',
      workspaceDataGuardReady: false,
    });
    const blockedSearch = await unreadyKbRuntime.searchKnowledgeBase({ query: 'условия' });
    expect(blockedSearch.success).toBe(false);
    expect(blockedSearch.content).toBe(DATA_GUARD_SEARCH_BLOCKED_MESSAGE);
  });

  it('5. sandboxBridge: blocks Zone 2 when dataGuardProtected && !workspaceDataGuardReady, and hydrates + syncs with dataGuardStatus="scrubbed" when workspaceDataGuardReady=true', async () => {
    let agentChatConfig: Record<string, unknown> = {};
    const hydratableDbRows = [
      {
        byteSize: 128,
        contentSha256: 'a'.repeat(64),
        currentFileId: 'f-scrub-1',
        currentRevision: 2,
        dataGuardStatus: 'scrubbed',
        isProtected: false,
        kind: 'text',
        mimeType: 'text/x-python',
        path: 'src/model.py',
        s3Key: 'files/usr-1/ws/model.py',
        workspaceFileId: 'wf-scrub-1',
      },
    ];

    const fakeSandboxDb = {
      select: vi.fn(() => {
        let fromTable: unknown = null;
        const builder: any = {
          from: vi.fn((tbl: unknown) => {
            fromTable = tbl;
            return builder;
          }),
          innerJoin: vi.fn(() => builder),
          where: vi.fn(() => ({
            limit: vi.fn(async () => {
              if (fromTable === agents) {
                return [{ chatConfig: agentChatConfig, id: 'agt-1' }];
              }
              return [];
            }),
            orderBy: vi.fn(async () => hydratableDbRows),
          })),
        };
        return builder;
      }),
    };

    // 5a. Regular project with one-off Data Guard shield (!workspaceDataGuardReady) -> [] hydration & data_guard_blocked sync
    mocks.computeWorkspaceDataGuardState.mockResolvedValueOnce({
      dataGuardCommercial: false,
      dataGuardProtected: true,
      dataGuardProtectedSince: null,
      projectDataGuardEnabled: false,
      unmaskedActiveCount: 0,
      workspaceDataGuardReady: false,
    });
    const emptyHydrate = await listHydratableProjectFiles({
      agentId: 'agt-1',
      dataGuardProtected: true,
      serverDB: fakeSandboxDb as any,
      userId: 'usr-1',
    });
    expect(emptyHydrate).toEqual([]);

    mocks.computeWorkspaceDataGuardState.mockResolvedValueOnce({
      dataGuardCommercial: false,
      dataGuardProtected: true,
      dataGuardProtectedSince: null,
      projectDataGuardEnabled: false,
      unmaskedActiveCount: 0,
      workspaceDataGuardReady: false,
    });
    const pyBytes = new TextEncoder().encode('result = "[ЛИЦО_1]"\n');
    const pySha = createHash('sha256').update(pyBytes).digest('hex');

    const blockedSync = await applySandboxProjectFileSync({
      agentId: 'agt-1',
      bytes: pyBytes,
      dataGuardProtected: true,
      path: 'src/model.py',
      serverDB: fakeSandboxDb as any,
      sha256: pySha,
      topicId: 'tpc-1',
      userId: 'usr-1',
    });
    expect(blockedSync).toMatchObject({
      outcome: 'fallback_to_topic',
      reason: 'data_guard_blocked',
    });
    expect(mocks.writeAgentTextFile).not.toHaveBeenCalled();

    // 5b. Protected project with workspaceDataGuardReady=true -> hydrates scrubbed files & commits Zone 2 with dataGuardStatus='scrubbed'!
    agentChatConfig = { dataGuardProtected: true };
    mocks.computeWorkspaceDataGuardState.mockResolvedValueOnce({
      dataGuardCommercial: false,
      dataGuardProtected: true,
      dataGuardProtectedSince: '2026-11-23T10:00:00Z',
      projectDataGuardEnabled: true,
      unmaskedActiveCount: 0,
      workspaceDataGuardReady: true,
    });
    const readyHydrate = await listHydratableProjectFiles({
      agentId: 'agt-1',
      dataGuardProtected: true,
      serverDB: fakeSandboxDb as any,
      userId: 'usr-1',
    });
    expect(readyHydrate).toHaveLength(1);
    expect(readyHydrate[0]).toMatchObject({
      dataGuardStatus: 'scrubbed',
      path: 'src/model.py',
      workspaceFileId: 'wf-scrub-1',
    });

    mocks.writeAgentTextFile.mockResolvedValueOnce({
      addedLines: 1,
      budget: {} as any,
      file: {
        agentId: 'agt-1',
        currentRevision: 3,
        dataGuardStatus: 'scrubbed',
        id: 'wf-scrub-1',
        path: 'src/model.py',
      },
      outcome: 'updated',
      prevRevision: 2,
      removedLines: 1,
    });

    const syncedReady = await applySandboxProjectFileSync({
      agentId: 'agt-1',
      baseRevision: 2,
      bytes: pyBytes,
      dataGuardProtected: true,
      path: 'src/model.py',
      serverDB: fakeSandboxDb as any,
      sha256: pySha,
      topicId: 'tpc-1',
      userId: 'usr-1',
      workspaceDataGuardReady: true,
    });
    expect(syncedReady).toMatchObject({
      outcome: 'updated',
      path: 'src/model.py',
      prevRevision: 2,
      revision: 3,
    });
    expect(mocks.writeAgentTextFile).toHaveBeenCalledWith(
      'agt-1',
      expect.objectContaining({
        actor: 'sandbox',
        dataGuardStatus: 'scrubbed',
        path: 'src/model.py',
      }),
    );
  });

  it('6. /compact (compactTopic.ts) & RuntimeExecutors (compress_context + call_llm): masks unmasked workspace history when !workspaceDataGuardReady, and preserves scrubbed workspace history in ready Protected Projects', async () => {
    // 6a. compressionThresholds recognizes chatConfig.dataGuardProtected
    expect(isDeepSeekDataGuardProtected({ chatConfig: { dataGuardProtected: true } })).toBe(true);
    expect(
      resolveCompressionModelConfig({
        agentConfig: { chatConfig: { dataGuardProtected: true } },
        explicitCompressionModel: { model: 'claude-haiku-5-5', provider: 'anthropic' },
      }),
    ).toEqual({ model: 'deepseek-flash', provider: 'deepseek' });

    let currentAgentChatConfig: Record<string, unknown> = {};
    const compactDb = {
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
            limit: async () => {
              if (table === topics) {
                return [{ agentId: 'agt-1', groupId: null, id: 'tpc-1', sessionId: 's-1' }];
              }
              if (table === agents) {
                return [{ chatConfig: currentAgentChatConfig }];
              }
              return [];
            },
          }),
        }),
      }),
    };

    const makeHistoryWithWorkspace = (markerPrefix: string): UIChatMessage[] =>
      [
        {
          content: 'Check project secrets and attachment',
          createdAt: Date.now() - 10_000,
          id: 'u1',
          role: 'user',
          updatedAt: Date.now() - 10_000,
        },
        {
          content: '',
          createdAt: Date.now() - 9_000,
          id: 'a1',
          parentId: 'u1',
          role: 'assistant',
          tools: [
            {
              apiName: 'writeProjectFilePart',
              arguments: JSON.stringify({
                final: true,
                part: 1,
                path: 'src/data.py',
                text: `${markerPrefix}_WRITE_ARG_PAYLOAD`,
              }),
              id: 'tc-ws-part',
              identifier: 'arckep-workspace',
              type: 'builtin',
            },
            {
              apiName: 'searchKnowledgeBase',
              arguments: JSON.stringify({ query: `${markerPrefix}_KB_SEARCH_ARG` }),
              id: 'tc-kb-s',
              identifier: 'lobe-knowledge-base',
              type: 'builtin',
            },
            {
              apiName: 'readKnowledge',
              arguments: JSON.stringify({ fileIds: ['att-scrub-1'] }),
              id: 'tc-kb-r',
              identifier: 'lobe-knowledge-base',
              type: 'builtin',
            },
          ],
          updatedAt: Date.now() - 9_000,
        },
        {
          content: `${markerPrefix}_WORKSPACE_TOOL_OUTPUT`,
          createdAt: Date.now() - 8_000,
          id: 't1',
          parentId: 'a1',
          plugin: {
            apiName: 'writeProjectFilePart',
            arguments: '{}',
            id: 'tc-ws-part',
            identifier: 'arckep-workspace',
            type: 'builtin',
          },
          role: 'tool',
          tool_call_id: 'tc-ws-part',
          updatedAt: Date.now() - 8_000,
        },
        {
          content: `${markerPrefix}_KB_SEARCH_OUTPUT`,
          createdAt: Date.now() - 7_500,
          id: 't2',
          parentId: 'a1',
          plugin: {
            apiName: 'searchKnowledgeBase',
            arguments: '{}',
            id: 'tc-kb-s',
            identifier: 'lobe-knowledge-base',
            type: 'builtin',
          },
          role: 'tool',
          tool_call_id: 'tc-kb-s',
          updatedAt: Date.now() - 7_500,
        },
        {
          content: 'SCRUBBED_ATTACHMENT_[ЛИЦО_1]_PRESERVED',
          createdAt: Date.now() - 7_000,
          id: 't3',
          parentId: 'a1',
          plugin: {
            apiName: 'readKnowledge',
            arguments: '{"fileIds":["att-scrub-1"]}',
            id: 'tc-kb-r',
            identifier: 'lobe-knowledge-base',
            type: 'builtin',
          },
          role: 'tool',
          tool_call_id: 'tc-kb-r',
          updatedAt: Date.now() - 7_000,
        },
      ] as unknown as UIChatMessage[];

    mocks.chat.mockImplementation(async (_payload: ChatStreamPayload, options: any) => {
      await options?.callback?.onText?.('### Summary\nCompressed cleanly.');
      return new Response('');
    });
    mocks.upsertRollingCompressionGroup.mockResolvedValue({
      messageGroupId: 'grp-1',
      messages: [],
    });

    // 6b. compactTopic when dataGuardProtected=true & workspaceDataGuardReady=false -> masks unmasked workspace history!
    currentAgentChatConfig = {};
    mocks.messageQueryWithWhere.mockResolvedValueOnce(makeHistoryWithWorkspace('RAW_LEAK'));

    const unreadyCompactRes = await compactTopic({
      dataGuardProtected: true,
      db: compactDb as any,
      topicId: 'tpc-1',
      userId: 'usr-1',
    });
    expect(unreadyCompactRes.compacted).toBe(true);
    const unreadySummarizerPrompt = JSON.stringify(mocks.chat.mock.calls[0][0].messages);
    expect(unreadySummarizerPrompt).not.toContain('RAW_LEAK_WRITE_ARG_PAYLOAD');
    expect(unreadySummarizerPrompt).not.toContain('RAW_LEAK_KB_SEARCH_ARG');
    expect(unreadySummarizerPrompt).not.toContain('RAW_LEAK_WORKSPACE_TOOL_OUTPUT');
    expect(unreadySummarizerPrompt).not.toContain('RAW_LEAK_KB_SEARCH_OUTPUT');
    expect(unreadySummarizerPrompt).toContain('SCRUBBED_ATTACHMENT_[ЛИЦО_1]_PRESERVED');

    // 6c. compactTopic when agent.chatConfig.dataGuardProtected=true & workspaceDataGuardReady=true -> keeps scrubbed history intact!
    mocks.chat.mockClear();
    currentAgentChatConfig = { dataGuardProtected: true };
    mocks.messageQueryWithWhere.mockResolvedValueOnce(
      makeHistoryWithWorkspace('SCRUBBED_[ЛИЦО_2]'),
    );

    const readyCompactRes = await compactTopic({
      db: compactDb as any,
      topicId: 'tpc-1',
      userId: 'usr-1',
    });
    expect(readyCompactRes.compacted).toBe(true);
    expect(initModelRuntimeFromDB).toHaveBeenLastCalledWith(
      expect.anything(),
      'usr-1',
      'deepseek',
      expect.objectContaining({ topicId: 'tpc-1' }),
    );
    const readySummarizerPrompt = JSON.stringify(mocks.chat.mock.calls[0][0].messages);
    expect(readySummarizerPrompt).toContain('SCRUBBED_[ЛИЦО_2]_WRITE_ARG_PAYLOAD');
    expect(readySummarizerPrompt).toContain('SCRUBBED_[ЛИЦО_2]_WORKSPACE_TOOL_OUTPUT');

    // 6d. RuntimeExecutors: auto-compression (compress_context) + call_llm KB scoping
    mocks.chat.mockClear();
    const unreadyHistoryWithActiveUser = [
      ...makeHistoryWithWorkspace('AUTO_RAW_LEAK'),
      { content: 'Active turn user msg', id: 'u-active', role: 'user' },
    ];
    const execCtx: RuntimeExecutorContext = {
      agentConfig: {
        chatConfig: { dataGuardProtected: true, __workspaceDataGuardReady: false },
        files: [{ content: 'legacy file', enabled: true, id: 'lf-1', name: 'old.txt' }],
        id: 'agt-1',
        knowledgeBases: [
          { enabled: true, id: 'kb-ws-1', name: 'Project KB', type: 'project_workspace' },
          { enabled: true, id: 'kb-ext-1', name: 'External KB', type: 'custom' },
        ],
        model: 'deepseek-chat',
        provider: 'deepseek',
      },
      loadAgentState: vi.fn(async () => null),
      messageModel: {
        addFiles: vi.fn(),
        create: vi.fn(async () => ({ id: 'm-new' })),
        query: vi.fn(async () => unreadyHistoryWithActiveUser),
        update: vi.fn(async () => ({})),
      } as any,
      operationId: 'op-auto-1',
      serverDB: {} as any,
      stepIndex: 0,
      streamManager: {
        publishStreamChunk: vi.fn(async () => 'c1'),
        publishStreamEvent: vi.fn(async () => 'e1'),
      } as any,
      toolExecutionService: { executeTool: vi.fn() } as any,
      topicId: 'tpc-1',
      userId: 'usr-1',
    };

    const executors = createRuntimeExecutors(execCtx);

    // Auto-compression when !workspaceDataGuardReady masks RAW leaks
    const unreadyState: AgentState = AgentRuntime.createInitialState({
      messages: unreadyHistoryWithActiveUser as any,
      metadata: {
        agentConfig: execCtx.agentConfig,
        agentId: 'agt-1',
        topicId: 'tpc-1',
      },
      operationId: 'op-auto-1',
      status: 'running',
    });
    await executors.compress_context!(
      {
        payload: {
          currentTokenCount: 400_000,
          messages: unreadyHistoryWithActiveUser,
        },
        type: 'compress_context',
      } as any,
      unreadyState,
    );
    const autoUnreadyPrompt = JSON.stringify(mocks.chat.mock.calls[0][0].messages);
    expect(autoUnreadyPrompt).not.toContain('AUTO_RAW_LEAK');
    expect(autoUnreadyPrompt).toContain('SCRUBBED_ATTACHMENT_[ЛИЦО_1]_PRESERVED');

    // call_llm when workspaceDataGuardReady=true forwards workspaceDataGuardReady & keeps ONLY project_workspace KB!
    const readyAgentConfig = {
      ...execCtx.agentConfig,
      chatConfig: {
        __workspaceDataGuardReady: true,
        dataGuardProtected: true,
        deepseekDataGuardProtected: true,
      },
    };
    const readyState: AgentState = AgentRuntime.createInitialState({
      messages: [{ content: 'Hello protected project', id: 'u1', role: 'user' }] as any,
      metadata: {
        agentConfig: readyAgentConfig,
        agentId: 'agt-1',
        topicId: 'tpc-1',
        workspaceActive: true,
        workspaceIndexBlock:
          '<project_workspace_index trust="untrusted_workspace_data">INDEX</project_workspace_index>',
        workspaceRulesBlock:
          '<project_rules><rule_file path="AGENTS.md" revision="1">RULE</rule_file></project_rules>',
      },
      operationId: 'op-ready-llm',
      status: 'running',
    });

    const readyExecutors = createRuntimeExecutors({
      ...execCtx,
      agentConfig: readyAgentConfig,
      messageModel: {
        ...execCtx.messageModel,
        query: vi.fn(async () => []),
      } as any,
    });
    await readyExecutors.call_llm!(
      {
        payload: {
          messages: [{ content: 'Hello protected project', id: 'u1', role: 'user' }],
          model: 'deepseek-chat',
          provider: 'deepseek',
          tools: [],
        },
        type: 'call_llm',
      } as any,
      readyState,
    );

    expect(serverMessagesEngine).toHaveBeenCalledWith(
      expect.objectContaining({
        deepseekDataGuardProtected: true,
        knowledge: {
          fileContents: [],
          knowledgeBases: [{ id: 'kb-ws-1', name: 'Project KB' }],
        },
        workspaceDataGuardReady: true,
        workspaceIndexBlock:
          '<project_workspace_index trust="untrusted_workspace_data">INDEX</project_workspace_index>',
        workspaceRulesBlock:
          '<project_rules><rule_file path="AGENTS.md" revision="1">RULE</rule_file></project_rules>',
      }),
    );
  });
});
