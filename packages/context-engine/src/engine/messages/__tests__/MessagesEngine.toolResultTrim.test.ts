import { parse } from '@lobechat/conversation-flow';
import { describe, expect, it } from 'vitest';

import type { UIChatMessage } from '@/types/index';

import { hydrateGroupMessages } from '../../../processors/GroupMessageFlatten';
import { MessagesEngine } from '../MessagesEngine';

const makeKnowledgeXml = (fileId: string, bodyChars: number, offset = 0, total = 100_000) => {
  const endOffset = offset + bodyChars;
  const nextOffset = endOffset < total ? endOffset : null;
  const coverage = JSON.stringify({
    complete: false,
    endOffset,
    nextOffset,
    startOffset: offset,
    totalCharCount: total,
  });
  return `<knowledge_base_files totalCount="1">\n<file id="${fileId}" name="${fileId}.pdf">\n<coverage>${coverage}</coverage>\n${'P'.repeat(bodyChars)}\n</file>\n</knowledge_base_files>`;
};

interface FlatTurnSpec {
  artifactBody?: string;
  artifactId?: string;
  baseTs: number;
  fileId: string;
  knowledgeChars: number;
  parentId: string | null;
  skillBody?: string;
  skillName?: string;
  turn: number;
}

/**
 * Builds flat DB-shaped messages with proper `parentId` chains so `@lobechat/conversation-flow`'s
 * `parse(latestMessages)` groups assistant + tool chains into `role: 'assistantGroup'` exactly as
 * `RuntimeExecutors.call_tools_batch` does in production.
 */
const buildHistoricalTurn = (spec: FlatTurnSpec): { lastId: string; messages: any[] } => {
  const {
    turn,
    parentId,
    baseTs,
    fileId,
    knowledgeChars,
    skillName,
    skillBody,
    artifactId,
    artifactBody,
  } = spec;
  const uId = `user-t${turn}`;
  const aToolId = `asst-tool-t${turn}`;
  const tcReadId = `call-read-t${turn}`;
  const toolReadMsgId = `tool-read-t${turn}`;

  const readArgs = JSON.stringify({ fileIds: [fileId], offset: 0 });
  const tools: any[] = [
    {
      apiName: 'readKnowledge',
      arguments: readArgs,
      id: tcReadId,
      identifier: 'lobe-knowledge-base',
      type: 'builtin',
    },
  ];

  const toolMsgs: any[] = [
    {
      content: makeKnowledgeXml(fileId, knowledgeChars, 0),
      createdAt: baseTs + 2000,
      id: toolReadMsgId,
      parentId: aToolId,
      plugin: {
        apiName: 'readKnowledge',
        arguments: readArgs,
        id: tcReadId,
        identifier: 'lobe-knowledge-base',
        type: 'builtin',
      },
      role: 'tool',
      tool_call_id: tcReadId,
      updatedAt: baseTs + 2000,
    },
  ];

  if (skillName && skillBody) {
    const tcSkillId = `call-skill-t${turn}`;
    const skillArgs = JSON.stringify({ name: skillName });
    tools.push({
      apiName: 'activateSkill',
      arguments: skillArgs,
      id: tcSkillId,
      identifier: 'lobe-activator',
      type: 'builtin',
    });
    toolMsgs.push({
      content: skillBody,
      createdAt: baseTs + 2100,
      id: `tool-skill-t${turn}`,
      parentId: aToolId,
      plugin: {
        apiName: 'activateSkill',
        arguments: skillArgs,
        id: tcSkillId,
        identifier: 'lobe-activator',
        type: 'builtin',
      },
      role: 'tool',
      tool_call_id: tcSkillId,
      updatedAt: baseTs + 2100,
    });
  }

  const aReplyId = `asst-reply-t${turn}`;
  const artifactMarkup =
    artifactId && artifactBody
      ? `\n<lobeArtifact identifier="${artifactId}" type="text/html">${artifactBody}</lobeArtifact>`
      : '';

  const messages: any[] = [
    {
      content: `User question in turn ${turn}`,
      createdAt: baseTs,
      id: uId,
      parentId,
      role: 'user',
      updatedAt: baseTs,
    },
    {
      // Simulate DB row where content is null on pure tool-calling assistant row!
      content: null,
      createdAt: baseTs + 1000,
      id: aToolId,
      parentId: uId,
      role: 'assistant',
      tools,
      updatedAt: baseTs + 1000,
    },
    ...toolMsgs,
    {
      content: `Assistant summary for turn ${turn}.${artifactMarkup}`,
      createdAt: baseTs + 3000,
      id: aReplyId,
      parentId: toolMsgs[0].id,
      role: 'assistant',
      updatedAt: baseTs + 3000,
    },
  ];

  return { lastId: aReplyId, messages };
};

describe('MessagesEngine + ArckepToolResultTrimProcessor invariants', () => {
  it('Invariant #1, #2, #3: preserves byte-identical prefix across Step 0, Step 1a (call_tool), and Step 1b (call_tools_batch via conversation-flow parse)', async () => {
    const t0 = 1_760_000_000_000;
    const skillContent12KB = `<skill name="Artifacts">\n${'I'.repeat(12_000)}\n</skill>`;
    const artifactOldBody = `<section>${'V'.repeat(1500)}</section>`;
    const artifactLatestBody = `<section>${'N'.repeat(1600)}</section>`;

    const rawDbHistory: any[] = [];
    let lastParentId: string | null = null;

    for (let turn = 1; turn <= 5; turn++) {
      const built = buildHistoricalTurn({
        artifactBody: turn === 2 ? artifactOldBody : turn === 4 ? artifactLatestBody : undefined,
        artifactId: turn === 2 || turn === 4 ? 'dashboard-card' : undefined,
        baseTs: t0 + (turn - 1) * 600_000, // 10 min apart (cold turns)
        fileId: `file-t${turn}`,
        knowledgeChars: 20_000,
        parentId: lastParentId,
        skillBody: turn === 1 ? skillContent12KB : undefined,
        skillName: turn === 1 ? 'Artifacts' : undefined,
        turn,
      });
      rawDbHistory.push(...built.messages);
      lastParentId = built.lastId;
    }

    const newUserMessage = {
      content: 'Now compare all 5 reports and update the dashboard.',
      createdAt: t0 + 5 * 600_000,
      id: 'user-t6',
      parentId: lastParentId,
      role: 'user',
      updatedAt: t0 + 5 * 600_000,
    };

    const runEngine = (messages: UIChatMessage[], cacheWarm?: boolean) =>
      new MessagesEngine({
        capabilities: {
          isCanUseFC: () => true,
          isCanUseVision: () => true,
        },
        enableSystemDate: false,
        messages,
        model: 'claude-sonnet-5-5',
        provider: 'anthropic',
        systemRole: 'You are Arckép assistant.',
        ...(cacheWarm !== undefined ? { toolResultTrim: { cacheWarm } } : {}),
      }).process();

    // =========================================================================
    // Step 0: Initial call_llm right after execAgent appends newUserMessage
    // (tested against raw flat history rows where assistant tool rows have content: null!)
    // =========================================================================
    const step0Input = [...rawDbHistory, newUserMessage] as UIChatMessage[];
    const step0 = await runEngine(step0Input, false);

    // Verify Invariant #2: activateSkill("Artifacts") from Turn 1 (12 KB, 5 turns old!) is 100% intact
    const skillWireMsg = step0.messages.find(
      (m) => m.role === 'tool' && m.tool_call_id === 'call-skill-t1',
    );
    expect(skillWireMsg?.content).toBe(skillContent12KB);

    // Verify Turns 1..3 readKnowledge (20 KB) are trimmed to short cursor stubs, while Turns 4..5 stay 20 KB
    for (const oldTurn of [1, 2, 3]) {
      const m = step0.messages.find(
        (msg) => msg.role === 'tool' && msg.tool_call_id === `call-read-t${oldTurn}`,
      );
      expect(typeof m?.content).toBe('string');
      expect((m!.content as string).length).toBeLessThan(350);
      expect(m!.content).toContain(`"fileId":"file-t${oldTurn}"`);
    }
    for (const recentTurn of [4, 5]) {
      const m = step0.messages.find(
        (msg) => msg.role === 'tool' && msg.tool_call_id === `call-read-t${recentTurn}`,
      );
      expect((m!.content as string).length).toBeGreaterThan(20_000);
    }

    // Verify Turn 2 <lobeArtifact> was superseded by Turn 4, and Turn 4 stays full
    const allAssistantContents = step0.messages
      .filter((m) => m.role === 'assistant' && typeof m.content === 'string')
      .map((m) => m.content as string);
    expect(allAssistantContents.some((c) => c.includes('Предыдущая версия макета'))).toBe(true);
    expect(allAssistantContents.some((c) => c.includes(artifactLatestBody))).toBe(true);

    // Verify Invariant #3: metadata.messageSourceIds matches wire messages 1-to-1
    expect(step0.metadata.messageSourceIds).toBeDefined();
    expect(step0.metadata.messageSourceIds?.length).toBe(step0.messages.length);
    expect(step0.metadata.messageSourceIds?.at(-1)).toBe('user-t6');

    // =========================================================================
    // Step 1a: Single call_tool (in-memory state.messages with active tool step)
    // Even if the active step re-reads file-t4 or emits a new <lobeArtifact>,
    // messages[0 .. step0.messages.length - 1] MUST stay 100% byte-identical!
    // =========================================================================
    const step1Assistant = {
      content: null,
      createdAt: t0 + 5 * 600_000 + 1000,
      id: 'asst-step1',
      parentId: 'user-t6',
      role: 'assistant',
      tools: [
        {
          apiName: 'readKnowledge',
          arguments: JSON.stringify({ fileIds: ['file-t4'], offset: 0 }),
          id: 'call-step1-a',
          identifier: 'lobe-knowledge-base',
          type: 'builtin',
        },
        {
          apiName: 'readKnowledge',
          arguments: JSON.stringify({ fileIds: ['file-t5'], offset: 20_000 }),
          id: 'call-step1-b',
          identifier: 'lobe-knowledge-base',
          type: 'builtin',
        },
      ],
      updatedAt: t0 + 5 * 600_000 + 1000,
    };
    const step1ToolA = {
      content: makeKnowledgeXml('file-t4', 20_000, 0),
      createdAt: t0 + 5 * 600_000 + 2000,
      id: 'tool-step1-a',
      parentId: 'asst-step1',
      plugin: step1Assistant.tools[0],
      role: 'tool',
      tool_call_id: 'call-step1-a',
      updatedAt: t0 + 5 * 600_000 + 2000,
    };
    const step1ToolB = {
      content: makeKnowledgeXml('file-t5', 20_000, 20_000),
      createdAt: t0 + 5 * 600_000 + 2100,
      id: 'tool-step1-b',
      parentId: 'asst-step1',
      plugin: step1Assistant.tools[1],
      role: 'tool',
      tool_call_id: 'call-step1-b',
      updatedAt: t0 + 5 * 600_000 + 2100,
    };

    const step1SingleAssistant = {
      ...step1Assistant,
      tools: [step1Assistant.tools[0]],
    };
    const step1aInput = [...step0Input, step1SingleAssistant, step1ToolA] as UIChatMessage[];
    const step1a = await runEngine(step1aInput, false);

    expect(step1a.messages.length).toBe(step0.messages.length + 2);
    expect(JSON.stringify(step1a.messages.slice(0, step0.messages.length))).toBe(
      JSON.stringify(step0.messages),
    );

    // =========================================================================
    // Step 1b: Parallel call_tools_batch via real parse(latestMessages) from @lobechat/conversation-flow
    // Old turns and current step are grouped into role: 'assistantGroup'!
    // =========================================================================
    const latestDbMessages = [...step0Input, step1Assistant, step1ToolA, step1ToolB];
    const { flatList } = parse(latestDbMessages as unknown as UIChatMessage[]);
    expect(flatList.some((m) => m.role === 'assistantGroup')).toBe(true);

    const step1b = await runEngine(flatList as unknown as UIChatMessage[], false);
    expect(step1b.messages.length).toBe(step0.messages.length + 3);
    expect(JSON.stringify(step1b.messages.slice(0, step0.messages.length))).toBe(
      JSON.stringify(step0.messages),
    );
    expect(step1b.metadata.messageSourceIds?.length).toBe(step1b.messages.length);
  });

  it('Warm follow-up gate: preserves cached prefix on small delta and shifts window on huge 60 KB delta', async () => {
    const t0 = 1_760_100_000_000;
    const rawHistory: any[] = [];
    let lastParentId: string | null = null;

    // Build 5 turns: Turns 1..3 have 20 KB, Turn 4 has small 2 KB (not worth busting 40 KB warm tail), Turn 5 has 25 KB
    for (let turn = 1; turn <= 5; turn++) {
      const chars = turn === 4 ? 2000 : turn === 5 ? 25_000 : 20_000;
      const built = buildHistoricalTurn({
        baseTs: t0 + (turn - 1) * 600_000,
        fileId: `doc-${turn}`,
        knowledgeChars: chars,
        parentId: lastParentId,
        turn,
      });
      rawHistory.push(...built.messages);
      lastParentId = built.lastId;
    }

    // Turn 6 (cold): cutoff lands at Turn 4's user message (Turns 4, 5, 6 are recent)
    const turn6Built = buildHistoricalTurn({
      baseTs: t0 + 5 * 600_000,
      fileId: 'doc-6',
      knowledgeChars: 20_000,
      parentId: lastParentId,
      turn: 6,
    });
    const afterTurn6 = [...rawHistory, ...turn6Built.messages];

    // Turn 6 cold run (before Turn 6 assistant reply, just to check Turn 6 prefix)
    const turn6Step0 = await new MessagesEngine({
      enableSystemDate: false,
      messages: [...rawHistory, turn6Built.messages[0]] as UIChatMessage[],
      model: 'claude-sonnet-5-5',
      provider: 'anthropic',
      systemRole: 'System',
      toolResultTrim: { cacheWarm: false },
    }).process();

    // Now Turn 7 arrives 45s later (cacheWarm: true)!
    const userTurn7 = {
      content: 'Quick follow-up question!',
      createdAt: t0 + 5 * 600_000 + 45_000,
      id: 'user-t7',
      parentId: turn6Built.lastId,
      role: 'user',
      updatedAt: t0 + 5 * 600_000 + 45_000,
    };

    const turn7WarmSmall = await new MessagesEngine({
      enableSystemDate: false,
      messages: parse([...afterTurn6, userTurn7]).flatList as unknown as UIChatMessage[],
      model: 'claude-sonnet-5-5',
      provider: 'anthropic',
      systemRole: 'System',
      toolResultTrim: { cacheWarm: true },
    }).process();

    // Because Turn 4 only saves ~1.8 KB against a ~45 KB cached tail, cutoff MUST NOT shift!
    expect(turn7WarmSmall.metadata.arckepToolResultTrim?.cutoffIndex).toBe(
      turn6Step0.metadata.arckepToolResultTrim?.cutoffIndex,
    );
    expect(JSON.stringify(turn7WarmSmall.messages.slice(0, turn6Step0.messages.length))).toBe(
      JSON.stringify(turn6Step0.messages),
    );

    // Now suppose Turn 4 had a HUGE 60 KB tool output -> savings (~59.8 KB) easily beat break-even!
    const historyWithHugeTurn4 = afterTurn6.map((m) =>
      m.id === 'tool-read-t4' ? { ...m, content: makeKnowledgeXml('doc-4', 60_000, 0) } : m,
    );
    const turn7WarmHuge = await new MessagesEngine({
      enableSystemDate: false,
      messages: parse([...historyWithHugeTurn4, userTurn7]).flatList as unknown as UIChatMessage[],
      model: 'claude-sonnet-5-5',
      provider: 'anthropic',
      systemRole: 'System',
      toolResultTrim: { cacheWarm: true },
    }).process();

    expect(turn7WarmHuge.metadata.arckepToolResultTrim?.cutoffIndex).toBeGreaterThan(
      turn6Step0.metadata.arckepToolResultTrim!.cutoffIndex,
    );
    const turn4ToolInHuge = turn7WarmHuge.messages.find(
      (m) => m.role === 'tool' && m.tool_call_id === 'call-read-t4',
    );
    expect((turn4ToolInHuge!.content as string).length).toBeLessThan(350);
  });

  it('Step 0 <-> Step 1b byte-for-byte parity under multi-step updatedAt drift, out-of-order Promise.all tools, orphan DB tool rows, thoughtSignature, and content: null', async () => {
    const t0 = 1_761_000_000_000;
    const rawHistory: any[] = [];
    let parentId: string | null = null;

    // Turns 1..3: 20 KB readKnowledge each (cold, 10m apart)
    for (let turn = 1; turn <= 3; turn++) {
      const built = buildHistoricalTurn({
        baseTs: t0 + (turn - 1) * 600_000,
        fileId: `f-${turn}`,
        knowledgeChars: 20_000,
        parentId,
        turn,
      });
      rawHistory.push(...built.messages);
      parentId = built.lastId;
    }

    // Turn 4: parallel batch [tc4_a, tc4_b] reading SAME (fileId, offset) where tc4_b finished BEFORE tc4_a in DB,
    // WITH Gemini thoughtSignature, multimodal metadata, orphan tool row, and final reply at +90s (content: null)!
    // Turn 5 arrives at +340s (250s after a4-reply -> WARM < 300s, even though 330s after a4-tool >= 300s!).
    const t4Base = t0 + 3 * 600_000;
    const dupReadArgs = JSON.stringify({ fileIds: ['f-dup'], offset: 0 });
    rawHistory.push(
      {
        content: 'Turn 4 parallel & slow chain',
        createdAt: t4Base,
        id: 'u-t4',
        parentId,
        role: 'user',
        updatedAt: t4Base,
      },
      {
        content: null,
        createdAt: t4Base + 10_000,
        id: 'a-t4-batch',
        metadata: { isMultimodal: true },
        parentId: 'u-t4',
        role: 'assistant',
        tools: [
          {
            apiName: 'readKnowledge',
            arguments: dupReadArgs,
            id: 'tc4-first',
            identifier: 'lobe-knowledge-base',
            thoughtSignature: 'sig-gemini-1',
            type: 'builtin',
          },
          {
            apiName: 'readKnowledge',
            arguments: dupReadArgs,
            id: 'tc4-second',
            identifier: 'lobe-knowledge-base',
            thoughtSignature: 'sig-gemini-2',
            type: 'builtin',
          },
        ],
        updatedAt: t4Base + 10_000,
      },
      // Out-of-order Promise.all DB insert: tc4-second finished at +11s, tc4-first finished at +12s!
      {
        content: makeKnowledgeXml('f-dup', 10_000, 0),
        createdAt: t4Base + 11_000,
        id: 'tool-t4-second',
        parentId: 'a-t4-batch',
        plugin: {
          apiName: 'readKnowledge',
          arguments: dupReadArgs,
          id: 'tc4-second',
          identifier: 'lobe-knowledge-base',
          type: 'builtin',
        },
        role: 'tool',
        tool_call_id: 'tc4-second',
        updatedAt: t4Base + 11_000,
      },
      {
        content: makeKnowledgeXml('f-dup', 10_000, 0),
        createdAt: t4Base + 12_000,
        id: 'tool-t4-first',
        parentId: 'a-t4-batch',
        plugin: {
          apiName: 'readKnowledge',
          arguments: dupReadArgs,
          id: 'tc4-first',
          identifier: 'lobe-knowledge-base',
          type: 'builtin',
        },
        role: 'tool',
        tool_call_id: 'tc4-first',
        updatedAt: t4Base + 12_000,
      },
      // Orphan DB tool row without matching assistant tool_call_id
      {
        content: makeKnowledgeXml('f-3', 20_000, 0),
        createdAt: t4Base + 15_000,
        id: 'tool-orphan-db',
        parentId: 'u-t4',
        plugin: {
          apiName: 'readKnowledge',
          arguments: JSON.stringify({ fileIds: ['f-3'], offset: 0 }),
          id: 'tc-orphan-missing',
          identifier: 'lobe-knowledge-base',
          type: 'builtin',
        },
        role: 'tool',
        tool_call_id: 'tc-orphan-missing',
        updatedAt: t4Base + 15_000,
      },
      {
        content: null,
        createdAt: t4Base + 90_000,
        id: 'a-t4-final',
        parentId: 'tool-t4-first',
        role: 'assistant',
        updatedAt: t4Base + 90_000,
      },
    );

    // Turn 5 arrives at t4Base + 340_000 (250s after a-t4-final -> warm!), with small 2KB output in Turn 3? No, Turn 2 had 20KB,
    // let's make Turn 3 have a small 4.5KB output so Turn 5 being warm DEFERS trimming Turn 3!
    const historyAdjusted = rawHistory.map((m) =>
      m.id === 'tool-read-t3' ? { ...m, content: makeKnowledgeXml('f-3', 4500, 0) } : m,
    );
    const t5Base = t4Base + 340_000;
    historyAdjusted.push(
      {
        content: 'Turn 5 warm (<300s after a-t4-final, >=300s after a-t4-batch)',
        createdAt: t5Base,
        id: 'u-t5',
        parentId: 'a-t4-final',
        role: 'user',
        updatedAt: t5Base,
      },
      {
        content: 'Turn 5 quick reply ' + 'R'.repeat(25_000),
        createdAt: t5Base + 5000,
        id: 'a-t5',
        parentId: 'u-t5',
        role: 'assistant',
        updatedAt: t5Base + 5000,
      },
    );

    // Turn 6 arrives 40s after Turn 5 (warm!)
    const userTurn6 = {
      content: 'Turn 6 active turn',
      createdAt: t5Base + 45_000,
      id: 'u-t6',
      parentId: 'a-t5',
      role: 'user',
      updatedAt: t5Base + 45_000,
    };

    const run = (msgs: UIChatMessage[]) =>
      new MessagesEngine({
        capabilities: { isCanUseFC: () => true, isCanUseVision: () => true },
        enableSystemDate: false,
        messages: msgs,
        model: 'gemini-4-neon',
        provider: 'google',
        systemRole: 'System',
        toolResultTrim: { cacheWarm: true },
      }).process();

    // Step 0: flat DB rows + userTurn6
    const step0Input = [...historyAdjusted, userTurn6] as UIChatMessage[];
    const step0 = await run(step0Input);

    // Step 1b: after call_tools_batch reloads DB -> parse() -> hydrateGroupMessages()
    const step1Asst = {
      content: null,
      createdAt: t5Base + 46_000,
      id: 'a-t6-step1',
      parentId: 'u-t6',
      role: 'assistant',
      tools: [
        {
          apiName: 'readKnowledge',
          arguments: JSON.stringify({ fileIds: ['f-new'], offset: 0 }),
          id: 'tc6-1',
          identifier: 'lobe-knowledge-base',
          thoughtSignature: 'sig-step1',
          type: 'builtin',
        },
      ],
      updatedAt: t5Base + 46_000,
    };
    const step1Tool = {
      content: makeKnowledgeXml('f-new', 8000, 0),
      createdAt: t5Base + 47_000,
      id: 'tool-t6-step1',
      parentId: 'a-t6-step1',
      plugin: step1Asst.tools[0],
      role: 'tool',
      tool_call_id: 'tc6-1',
      updatedAt: t5Base + 47_000,
    };
    const latestDb = [...step0Input, step1Asst, step1Tool];
    const hydratedFlat = hydrateGroupMessages(
      parse(latestDb as unknown as UIChatMessage[]).flatList,
      latestDb,
    );
    const step1b = await run(hydratedFlat as unknown as UIChatMessage[]);

    // Exact byte-for-byte prefix match including thoughtSignature, content: '', tool order, and cutoff!
    expect(JSON.stringify(step1b.messages.slice(0, step0.messages.length))).toBe(
      JSON.stringify(step0.messages),
    );
    expect(JSON.stringify(step0.messages)).toContain('"thoughtSignature":"sig-gemini-1"');
  });

  it('1-hour warm cache with imageList attachments (via MessageContentProcessor) preserves byte-identical prefix across 6+ warm turns', async () => {
    const t0 = 1_762_000_000_000;
    const oneHourMs = 60 * 60 * 1000;
    const tinyPngDataUri =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

    // Turn 1: user uploads 25 screenshots (25 * 6,400 = 160K equiv chars ≈ 40K tokens)
    const rawHistory: any[] = [
      {
        content: 'Analyze these 25 screenshots from the dashboard.',
        createdAt: t0,
        id: 'user-t1',
        imageList: Array.from({ length: 25 }, (_, idx) => ({
          alt: `screen-${idx}.png`,
          id: `img-${idx}`,
          url: tinyPngDataUri,
        })),
        parentId: null,
        role: 'user',
        updatedAt: t0,
      },
      {
        content: 'Reviewed all 25 screenshots.',
        createdAt: t0 + 10_000,
        id: 'asst-reply-t1',
        parentId: 'user-t1',
        role: 'assistant',
        updatedAt: t0 + 10_000,
      },
    ];

    let lastParentId = 'asst-reply-t1';
    // Turns 2..6: each 4 minutes apart (warm within 1h TTL) with a 10 KB readKnowledge tool output
    for (let turn = 2; turn <= 6; turn++) {
      const built = buildHistoricalTurn({
        baseTs: t0 + (turn - 1) * 240_000,
        fileId: `report-${turn}`,
        knowledgeChars: 10_000,
        parentId: lastParentId,
        turn,
      });
      rawHistory.push(...built.messages);
      lastParentId = built.lastId;
    }

    const runWarm1h = (messages: any[]) =>
      new MessagesEngine({
        capabilities: {
          isCanUseFC: () => true,
          isCanUseVision: () => true,
        },
        enableSystemDate: false,
        messages: parse(messages as unknown as UIChatMessage[])
          .flatList as unknown as UIChatMessage[],
        model: 'claude-sonnet-4-5',
        provider: 'anthropic',
        systemRole: 'You are Arckép assistant.',
        toolResultTrim: {
          cacheTtlMs: oneHourMs,
          cacheWarm: true,
        },
      }).process();

    // Turns 7..10: 4 consecutive warm follow-ups (exceeding the old 3-turn deferred cap!)
    let prevOut: Awaited<ReturnType<typeof runWarm1h>> | null = null;
    const running = [...rawHistory];
    for (let turn = 7; turn <= 10; turn++) {
      const ts = t0 + (turn - 1) * 240_000;
      const uId = `user-t${turn}`;
      running.push({
        content: `Warm follow-up ${turn}`,
        createdAt: ts,
        id: uId,
        parentId: lastParentId,
        role: 'user',
        updatedAt: ts,
      });

      const out = await runWarm1h(running);
      expect(out.metadata.arckepToolResultTrim?.cacheWarm).toBe(true);
      // Every earlier 10 KB tool result MUST stay untrimmed so the 1h Anthropic cache is never busted!
      for (let t = 2; t <= 6; t++) {
        const toolMsg = out.messages.find(
          (m) => m.role === 'tool' && m.tool_call_id === `call-read-t${t}`,
        );
        expect((toolMsg?.content as string).length).toBeGreaterThan(10_000);
      }
      if (prevOut) {
        expect(JSON.stringify(out.messages.slice(0, prevOut.messages.length))).toBe(
          JSON.stringify(prevOut.messages),
        );
      }
      prevOut = out;

      const aId = `asst-reply-t${turn}`;
      running.push({
        content: `Reply ${turn}`,
        createdAt: ts + 5000,
        id: aId,
        parentId: uId,
        role: 'assistant',
        updatedAt: ts + 5000,
      });
      lastParentId = aId;
    }
  });
});
