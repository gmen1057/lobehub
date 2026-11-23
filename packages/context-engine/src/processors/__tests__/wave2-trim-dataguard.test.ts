/* eslint-disable unicorn/text-encoding-identifier-case */
import { describe, expect, it } from 'vitest';

import type { UIChatMessage } from '@/types/index';

import { MessagesEngine } from '../../engine/messages/MessagesEngine';
import { formatProjectRulesBlock, formatProjectWorkspaceIndexBlock } from '../../providers';
import { ArckepToolResultTrimProcessor } from '../ArckepToolResultTrim';

const DATA_GUARD_MASK = '[Содержимое незащищённого файла проекта скрыто в защищённом режиме]';
const MASKED_ARGS = '{"masked":"[Data Guard]"}';

const makeMultipartTurn = (params: {
  args: Record<string, unknown>;
  baseTs: number;
  toolContent: string;
  turn: number;
}) => {
  const argsJson = JSON.stringify(params.args);
  const tcId = `call-part-t${params.turn}-p${String(params.args.part ?? 1)}`;
  return [
    {
      content: `User turn ${params.turn}`,
      createdAt: params.baseTs,
      id: `u-t${params.turn}`,
      role: 'user',
      updatedAt: params.baseTs,
    },
    {
      content: '',
      createdAt: params.baseTs + 1000,
      id: `a-t${params.turn}`,
      role: 'assistant',
      tools: [
        {
          apiName: 'writeProjectFilePart',
          arguments: argsJson,
          id: tcId,
          identifier: 'arckep-workspace',
          type: 'builtin',
        },
      ],
      updatedAt: params.baseTs + 1000,
    },
    {
      content: params.toolContent,
      createdAt: params.baseTs + 2000,
      id: `t-t${params.turn}`,
      plugin: {
        apiName: 'writeProjectFilePart',
        arguments: argsJson,
        id: tcId,
        identifier: 'arckep-workspace',
        type: 'builtin',
      },
      role: 'tool',
      tool_call_id: tcId,
      updatedAt: params.baseTs + 2000,
    },
    {
      content: `Completed turn ${params.turn}`,
      createdAt: params.baseTs + 3000,
      id: `a-done-t${params.turn}`,
      role: 'assistant',
      updatedAt: params.baseTs + 3000,
    },
  ];
};

describe('Wave 2: ArckepToolResultTrimProcessor (writeProjectFilePart) & MessagesEngine Data Guard 2A', () => {
  it('1. compacts writeProjectFilePart text > 600 chars older than 3 user turns, keeps metadata fields intact, leaves recent 3 turns untouched, and preserves ARCKEP_WORKSPACE_CHANGE / PROPOSAL receipts', async () => {
    const t0 = 1_770_000_000_000;
    // 2_400 chars: strictly > WORKSPACE_WRITE_ARG_COMPACT_CHARS (600) and < MAX_OLD_TOOL_ARGUMENTS_CHARS (4_000)!
    const chunk1Text = `// Chunk 1 header\n${'export const itemA = 12345;\n'.repeat(85)}`;
    const chunk2Text = `// Chunk 2 final\n${'export const itemB = 67890;\n'.repeat(85)}`;
    const recentChunkText = `// Recent chunk\n${'export const fresh = true;\n'.repeat(85)}`;

    expect(chunk1Text.length).toBeGreaterThan(600);
    expect(chunk1Text.length).toBeLessThan(4000);

    const changeReceipt =
      'ARCKEP_WORKSPACE_CHANGE {"workspaceFileId":"wf-big","agentId":"ag-1","path":"src/bigModule.ts","action":"created","prevRevision":null,"revision":1,"addedLines":174,"removedLines":0,"authorType":"agent"}';
    const proposalReceipt =
      'ARCKEP_WORKSPACE_PROPOSAL {"proposalId":"prop-big","agentId":"ag-1","workspaceFileId":"wf-agents","targetPath":"AGENTS.md","proposalType":"edit","baseRevision":2,"reason":"Large rule rewrite","addedLines":180,"removedLines":10,"diffPreview":"@@ -1,10 +1,180 @@"}';

    const history: any[] = [
      // Turn 1 (older than 3 user turns when Turn 5 arrives): staged part 1 + committed part 2 with oversized diff output
      ...makeMultipartTurn({
        args: {
          baseRevision: 0,
          changeNote: 'Initial multipart upload',
          encoding: 'utf-8',
          final: false,
          lineEnding: 'lf',
          part: 1,
          path: 'src/bigModule.ts',
          text: chunk1Text,
          uploadId: 'upl-session-1',
        },
        baseTs: t0,
        toolContent:
          'Staged chunk #1 for "src/bigModule.ts" (uploadId="upl-session-1", accumulatedBytes=2400).',
        turn: 1,
      }),
      // Turn 2 (also older than 3 user turns when Turn 5 arrives): final=true on protected AGENTS.md with >4000 char diff + proposal receipt, plus committed change receipt test
      ...makeMultipartTurn({
        args: {
          baseRevision: 2,
          changeNote: 'Protected multipart proposal',
          encoding: 'utf-8-bom',
          final: true,
          lineEnding: 'CRLF',
          part: 2,
          path: 'AGENTS.md',
          text: chunk2Text,
          uploadId: 'upl-session-2',
        },
        baseTs: t0 + 600_000,
        toolContent: `Protected file proposal created.\n${'+ rule line detail\n'.repeat(300)}\n${proposalReceipt}\n${changeReceipt}`,
        turn: 2,
      }),
      // Turn 3 (within recent 3 user turns: Turns 3, 4, 5): must NOT compact text!
      ...makeMultipartTurn({
        args: {
          final: false,
          part: 1,
          path: 'src/recent.ts',
          text: recentChunkText,
          uploadId: 'upl-recent-3',
        },
        baseTs: t0 + 1_200_000,
        toolContent: 'Staged recent chunk #1',
        turn: 3,
      }),
      // Turn 4 (recent)
      {
        content: 'User turn 4',
        createdAt: t0 + 1_800_000,
        id: 'u-t4',
        role: 'user',
        updatedAt: t0 + 1_800_000,
      },
      {
        content: 'Reply 4',
        createdAt: t0 + 1_801_000,
        id: 'a-t4',
        role: 'assistant',
        updatedAt: t0 + 1_801_000,
      },
      // Turn 5 (current user turn; gap >= 5m so cacheWarm=false)
      {
        content: 'User turn 5: continue working',
        createdAt: t0 + 2_500_000,
        id: 'u-t5',
        role: 'user',
        updatedAt: t0 + 2_500_000,
      },
    ];

    const engineResult = await new MessagesEngine({
      capabilities: { isCanUseFC: () => true },
      enableSystemDate: false,
      messages: history as UIChatMessage[],
      model: 'claude-sonnet-4-5',
      provider: 'anthropic',
      systemRole: 'Workspace engineer',
      toolResultTrim: { cacheWarm: false, enabled: true },
    }).process();

    const assistantWithCalls = engineResult.messages.filter(
      (m) => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0,
    );
    expect(assistantWithCalls).toHaveLength(3);

    // Turn 1 (old): compacted with exact stub & all non-text fields preserved
    const turn1Args = JSON.parse(assistantWithCalls[0].tool_calls![0].function.arguments);
    expect(turn1Args).toEqual({
      baseRevision: 0,
      changeNote: 'Initial multipart upload',
      encoding: 'utf-8',
      final: false,
      lineEnding: 'lf',
      part: 1,
      path: 'src/bigModule.ts',
      text: `[... ${chunk1Text.length} chars of chunk #1 written to src/bigModule.ts; read current file via arckep-workspace____readProjectFile ...]`,
      uploadId: 'upl-session-1',
    });

    // Turn 2 (old): compacted with exact stub & encoding/lineEnding/uploadId/part/final preserved
    const turn2Args = JSON.parse(assistantWithCalls[1].tool_calls![0].function.arguments);
    expect(turn2Args).toEqual({
      baseRevision: 2,
      changeNote: 'Protected multipart proposal',
      encoding: 'utf-8-bom',
      final: true,
      lineEnding: 'CRLF',
      part: 2,
      path: 'AGENTS.md',
      text: `[... ${chunk2Text.length} chars of chunk #2 written to AGENTS.md; read current file via arckep-workspace____readProjectFile ...]`,
      uploadId: 'upl-session-2',
    });

    // Turn 2 tool result (>4000 chars) was trimmed, yet BOTH receipts survived intact!
    const turn2ToolMsg = engineResult.messages.find(
      (m) => m.role === 'tool' && m.tool_call_id === 'call-part-t2-p2',
    );
    expect(turn2ToolMsg?.content).toContain(proposalReceipt);
    expect(turn2ToolMsg?.content).toContain(changeReceipt);
    expect((turn2ToolMsg?.content as string).length).toBeLessThan(3000);

    // Turn 3 (within recent 3 turns): text is 100% untouched!
    const turn3Args = JSON.parse(assistantWithCalls[2].tool_calls![0].function.arguments);
    expect(turn3Args.text).toBe(recentChunkText);
    expect(turn3Args.uploadId).toBe('upl-recent-3');

    // Direct processor check on raw msg.tools (before MessageCleanup strips tools)
    const directProcessor = new ArckepToolResultTrimProcessor({ cacheWarm: false, enabled: true });
    const directOut = await directProcessor.process({
      initialState: { messages: history } as any,
      isAborted: false,
      messages: structuredClone(history),
      metadata: { supportTools: true },
    });
    const directTurn1ToolsArg = JSON.parse((directOut.messages[1] as any).tools[0].arguments);
    expect(directTurn1ToolsArg.text).toBe(
      `[... ${chunk1Text.length} chars of chunk #1 written to src/bigModule.ts; read current file via arckep-workspace____readProjectFile ...]`,
    );
  });

  it('2. MessagesEngine Mode 1 (deepseekDataGuardProtected: true, workspaceDataGuardReady: true): keeps <project_rules>, <project_workspace_index>, <workspace_updates> and scrubbed arckep-workspace args/outputs intact', async () => {
    const rulesBlock = formatProjectRulesBlock([
      { content: 'Work with [КОМПАНИЯ_1] safely.', path: 'AGENTS.md', revision: 1 },
    ]);
    const indexBlock = formatProjectWorkspaceIndexBlock([
      {
        byteSize: 512,
        isProtected: true,
        kind: 'text',
        lineCount: 12,
        loadMode: 'always',
        path: 'AGENTS.md',
        revision: 1,
        userSummary: 'Правила [КОМПАНИЯ_1]',
      },
      {
        byteSize: 2048,
        kind: 'text',
        lineCount: 80,
        loadMode: 'on_demand',
        path: 'src/report.py',
        revision: 3,
      },
    ]);

    const messages: any[] = [
      {
        content: 'Update report for [ЛИЦО_1]',
        id: 'u1',
        metadata: {
          workspaceDelta: 'Обновлён файл src/report.py (v2 -> v3) для [ЛИЦО_1]',
        },
        role: 'user',
      },
      {
        content: '',
        id: 'a1',
        role: 'assistant',
        tools: [
          {
            apiName: 'writeProjectFilePart',
            arguments: JSON.stringify({
              final: true,
              part: 1,
              path: 'src/report.py',
              text: 'client = "[ЛИЦО_1]"\n',
              uploadId: 'upl-scrubbed-1',
            }),
            id: 'tc-part-scrubbed',
            identifier: 'arckep-workspace',
            type: 'builtin',
          },
          {
            apiName: 'searchKnowledgeBase',
            arguments: JSON.stringify({ query: '[КОМПАНИЯ_1]' }),
            id: 'tc-kb-scrubbed',
            identifier: 'lobe-knowledge-base',
            type: 'builtin',
          },
        ],
      },
      {
        content:
          'Workspace file "src/report.py" updated (v2 -> v3).\nARCKEP_WORKSPACE_CHANGE {"workspaceFileId":"wf-1","agentId":"ag-1","path":"src/report.py","action":"updated","prevRevision":2,"revision":3,"addedLines":1,"removedLines":1,"authorType":"agent"}',
        id: 't1',
        plugin: {
          apiName: 'writeProjectFilePart',
          arguments: '{}',
          id: 'tc-part-scrubbed',
          identifier: 'arckep-workspace',
          type: 'builtin',
        },
        role: 'tool',
        tool_call_id: 'tc-part-scrubbed',
      },
      {
        content: 'Found scrubbed KB chunk for [КОМПАНИЯ_1].',
        id: 't2',
        plugin: {
          apiName: 'searchKnowledgeBase',
          arguments: '{"query":"[КОМПАНИЯ_1]"}',
          id: 'tc-kb-scrubbed',
          identifier: 'lobe-knowledge-base',
          type: 'builtin',
        },
        role: 'tool',
        tool_call_id: 'tc-kb-scrubbed',
      },
      { content: 'Done.', id: 'a2', role: 'assistant' },
      { content: 'Verify changes', id: 'u2', role: 'user' },
    ];

    const res = await new MessagesEngine({
      capabilities: { isCanUseFC: () => true },
      deepseekDataGuardProtected: true,
      enableSystemDate: false,
      messages: messages as UIChatMessage[],
      model: 'deepseek-chat',
      provider: 'deepseek',
      systemRole: 'Protected project assistant',
      workspaceDataGuardReady: true,
      workspaceIndexBlock: indexBlock,
      workspaceRulesBlock: rulesBlock,
    }).process();

    const joinedContents = res.messages
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n');
    const fullWire = JSON.stringify(res.messages);
    expect(joinedContents).toContain('<project_rules>');
    expect(joinedContents).toContain('Work with [КОМПАНИЯ_1] safely.');
    expect(joinedContents).toContain('<project_workspace_index trust="untrusted_workspace_data">');
    expect(joinedContents).toContain('<workspace_updates trust="untrusted_workspace_data">');
    expect(joinedContents).toContain('Обновлён файл src/report.py (v2 -> v3) для [ЛИЦО_1]');
    expect(fullWire).toContain('upl-scrubbed-1');
    expect(fullWire).toContain('ARCKEP_WORKSPACE_CHANGE');
    expect(fullWire).toContain('Found scrubbed KB chunk for [КОМПАНИЯ_1].');
    expect(fullWire).not.toContain(DATA_GUARD_MASK);
    expect(fullWire).not.toContain(MASKED_ARGS);
  });

  it('3. MessagesEngine Mode 2 (deepseekDataGuardProtected: true, workspaceDataGuardReady: false): hides rules/index/deltas, masks outputs AND arguments of all 7 arckep-workspace tools + searchKnowledgeBase, and preserves readKnowledge', async () => {
    const allSevenWorkspaceApis = [
      'listProjectFiles',
      'searchProjectFiles',
      'readProjectFile',
      'patchProjectFile',
      'writeProjectFile',
      'writeProjectFilePart',
      'deleteProjectFile',
    ] as const;

    const assistantTools = [
      ...allSevenWorkspaceApis.map((apiName, idx) => ({
        apiName,
        arguments: JSON.stringify({
          path: `secret_${idx}.py`,
          secretLeak: `UNMASKED_ARG_${apiName}_IVANOV`,
        }),
        id: `tc-ws-${idx}`,
        identifier: 'arckep-workspace',
        type: 'builtin' as const,
      })),
      {
        apiName: 'searchKnowledgeBase',
        arguments: JSON.stringify({ query: 'UNMASKED_SEARCH_QUERY_PETROV' }),
        id: 'tc-kb-search',
        identifier: 'lobe-knowledge-base',
        type: 'builtin' as const,
      },
      {
        apiName: 'readKnowledge',
        arguments: JSON.stringify({ fileIds: ['scrubbed-topic-att-1'] }),
        id: 'tc-kb-read',
        identifier: 'lobe-knowledge-base',
        type: 'builtin' as const,
      },
    ];

    const toolMessages = [
      ...allSevenWorkspaceApis.map((apiName, idx) => ({
        content: `UNMASKED_OUTPUT_${apiName}_+79991234567`,
        id: `t-ws-${idx}`,
        plugin: {
          apiName,
          arguments: JSON.stringify({ secretLeak: `UNMASKED_PLUGIN_ARG_${apiName}` }),
          id: `tc-ws-${idx}`,
          identifier: 'arckep-workspace',
          type: 'builtin',
        },
        role: 'tool',
        tool_call_id: `tc-ws-${idx}`,
      })),
      {
        content: 'UNMASKED_KB_CHUNK_INN_7701234567',
        id: 't-kb-search',
        plugin: {
          apiName: 'searchKnowledgeBase',
          arguments: JSON.stringify({ query: 'UNMASKED_SEARCH_QUERY_PETROV' }),
          id: 'tc-kb-search',
          identifier: 'lobe-knowledge-base',
          type: 'builtin',
        },
        role: 'tool',
        tool_call_id: 'tc-kb-search',
      },
      {
        content: '<file id="scrubbed-topic-att-1">[ЛИЦО_1] подписал договор.</file>',
        id: 't-kb-read',
        plugin: {
          apiName: 'readKnowledge',
          arguments: JSON.stringify({ fileIds: ['scrubbed-topic-att-1'] }),
          id: 'tc-kb-read',
          identifier: 'lobe-knowledge-base',
          type: 'builtin',
        },
        role: 'tool',
        tool_call_id: 'tc-kb-read',
      },
    ];

    const messages: any[] = [
      {
        content: 'Inspect everything',
        id: 'u1',
        metadata: {
          workspaceDelta: 'UNMASKED_DELTA_SECRET_PASSPORT_4500_123456',
        },
        role: 'user',
      },
      {
        content: '',
        id: 'a1',
        role: 'assistant',
        tools: assistantTools,
      },
      ...toolMessages,
      { content: 'Summary.', id: 'a2', role: 'assistant' },
      { content: 'Now continue with shield ON', id: 'u2', role: 'user' },
    ];

    const res = await new MessagesEngine({
      capabilities: { isCanUseFC: () => true },
      deepseekDataGuardProtected: true,
      enableSystemDate: false,
      messages: messages as UIChatMessage[],
      model: 'deepseek-chat',
      provider: 'deepseek',
      systemRole: 'Base role',
      workspaceDataGuardReady: false,
      workspaceIndexBlock:
        '<project_workspace_index trust="untrusted_workspace_data">UNMASKED_INDEX_DATA</project_workspace_index>',
      workspaceRulesBlock:
        '<project_rules><rule_file path="AGENTS.md" revision="1">UNMASKED_RULE_DATA</rule_file></project_rules>',
    }).process();

    const fullWire = JSON.stringify(res.messages);
    expect(fullWire).not.toContain('UNMASKED_RULE_DATA');
    expect(fullWire).not.toContain('UNMASKED_INDEX_DATA');
    expect(fullWire).not.toContain('UNMASKED_DELTA_SECRET_PASSPORT_4500_123456');
    expect(fullWire).not.toContain('<workspace_updates');
    expect(fullWire).not.toContain('UNMASKED_ARG_');
    expect(fullWire).not.toContain('UNMASKED_PLUGIN_ARG_');
    expect(fullWire).not.toContain('UNMASKED_OUTPUT_');
    expect(fullWire).not.toContain('UNMASKED_SEARCH_QUERY_PETROV');
    expect(fullWire).not.toContain('UNMASKED_KB_CHUNK_INN_7701234567');

    // Verify all 7 arckep-workspace + searchKnowledgeBase tool_calls have masked arguments, while readKnowledge keeps real arguments
    const a1Wire = res.messages.find(
      (m) => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length === 9,
    )!;
    expect(a1Wire).toBeDefined();

    for (let idx = 0; idx < allSevenWorkspaceApis.length; idx++) {
      const tc = a1Wire.tool_calls!.find((c) => c.id === `tc-ws-${idx}`)!;
      expect(tc.function.arguments).toBe(MASKED_ARGS);
      const tMsg = res.messages.find(
        (m) => m.role === 'tool' && m.tool_call_id === `tc-ws-${idx}`,
      )!;
      expect(tMsg.content).toBe(DATA_GUARD_MASK);
    }

    const searchTc = a1Wire.tool_calls!.find((c) => c.id === 'tc-kb-search')!;
    expect(searchTc.function.arguments).toBe(MASKED_ARGS);
    const searchRes = res.messages.find(
      (m) => m.role === 'tool' && m.tool_call_id === 'tc-kb-search',
    )!;
    expect(searchRes.content).toBe(DATA_GUARD_MASK);

    // readKnowledge is 100% preserved (both arguments and scrubbed attachment output!)
    const readTc = a1Wire.tool_calls!.find((c) => c.id === 'tc-kb-read')!;
    expect(JSON.parse(readTc.function.arguments)).toEqual({ fileIds: ['scrubbed-topic-att-1'] });
    const readRes = res.messages.find((m) => m.role === 'tool' && m.tool_call_id === 'tc-kb-read')!;
    expect(readRes.content).toBe(
      '<file id="scrubbed-topic-att-1">[ЛИЦО_1] подписал договор.</file>',
    );
  });
});
