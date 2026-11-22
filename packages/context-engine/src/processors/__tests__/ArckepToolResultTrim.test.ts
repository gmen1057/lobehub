import { describe, expect, it } from 'vitest';

import type { PipelineContext } from '../../types';
import {
  ArckepToolResultTrimProcessor,
  DEFAULT_CACHE_TTL_MS,
  MAX_OLD_TOOL_ARGUMENTS_CHARS,
  MAX_OLD_TOOL_CONTENT_CHARS,
  MIN_ARTIFACT_BODY_TO_COMPACT,
  RECENT_UNCOMPACTED_USER_TURNS,
} from '../ArckepToolResultTrim';

const makeContext = (
  messages: any[],
  options?: { initialMessages?: any[]; metadata?: Record<string, any> },
): PipelineContext => ({
  initialState: {
    messages: (options?.initialMessages ?? messages) as any,
  },
  isAborted: false,
  messages: messages.map((m) => ({ ...m })),
  metadata: { ...options?.metadata },
});

const makeToolPair = (params: {
  apiName: string;
  args: Record<string, unknown> | string;
  assistantContent?: string | null;
  assistantId: string;
  content: string;
  createdAt?: number;
  identifier: string;
  pluginError?: any;
  pluginState?: any;
  toolCallId: string;
  toolMsgId: string;
  type?: string;
  updatedAt?: number;
}) => {
  const argumentsStr = typeof params.args === 'string' ? params.args : JSON.stringify(params.args);
  const type = params.type ?? 'builtin';
  const fnName =
    type && type !== 'default'
      ? `${params.identifier}____${params.apiName}____${type}`
      : `${params.identifier}____${params.apiName}`;

  const assistant = {
    content: params.assistantContent !== undefined ? params.assistantContent : '',
    createdAt: params.createdAt,
    id: params.assistantId,
    role: 'assistant',
    tool_calls: [
      {
        function: { arguments: argumentsStr, name: fnName },
        id: params.toolCallId,
        type: 'function' as const,
      },
    ],
    tools: [
      {
        apiName: params.apiName,
        arguments: argumentsStr,
        id: params.toolCallId,
        identifier: params.identifier,
        type,
      },
    ],
    updatedAt: params.updatedAt ?? params.createdAt,
  };

  const tool = {
    content: params.content,
    createdAt: params.createdAt,
    id: params.toolMsgId,
    name: fnName,
    plugin: {
      apiName: params.apiName,
      arguments: argumentsStr,
      id: params.toolCallId,
      identifier: params.identifier,
      type,
    },
    ...(params.pluginError ? { pluginError: params.pluginError } : {}),
    ...(params.pluginState ? { pluginState: params.pluginState } : {}),
    role: 'tool',
    tool_call_id: params.toolCallId,
    updatedAt: params.updatedAt ?? params.createdAt,
  };

  return [assistant, tool];
};

const makeKnowledgeXml = (fileId: string, bodyChars: number, offset = 0, total = 80_000) => {
  const endOffset = offset + bodyChars;
  const nextOffset = endOffset < total ? endOffset : null;
  const coverage = JSON.stringify({
    complete: false,
    endOffset,
    nextOffset,
    startOffset: offset,
    totalCharCount: total,
  });
  return `<knowledge_base_files totalCount="1">\n<file id="${fileId}" name="${fileId}.txt">\n<coverage>${coverage}</coverage>\n${'K'.repeat(bodyChars)}\n</file>\n</knowledge_base_files>`;
};

const makeAgentDocPage = (
  id: string,
  filename: string,
  bodyChars: number,
  offset = 0,
  snapshot = `sha256:${'a'.repeat(64)}`,
) => {
  const totalLength = Math.max(bodyChars + offset, 50_000);
  const endOffset = offset + bodyChars;
  const meta = {
    complete: false,
    endOffset,
    eof: false,
    filename,
    id,
    nextOffset: endOffset < totalLength ? endOffset : null,
    snapshot,
    startOffset: offset,
    title: filename,
    totalCharCount: totalLength,
    totalLength,
  };
  return `Agent document page ${JSON.stringify(meta)}\nThe complete original is retained.\n${'D'.repeat(bodyChars)}`;
};

describe('ArckepToolResultTrimProcessor', () => {
  it('exports agreed constants', () => {
    expect(RECENT_UNCOMPACTED_USER_TURNS).toBe(3);
    expect(MIN_ARTIFACT_BODY_TO_COMPACT).toBe(800);
    expect(MAX_OLD_TOOL_CONTENT_CHARS).toBe(4000);
    expect(MAX_OLD_TOOL_ARGUMENTS_CHARS).toBe(4000);
    expect(DEFAULT_CACHE_TTL_MS).toBe(300_000);
  });

  it('acts as no-op when enabled is false', async () => {
    const processor = new ArckepToolResultTrimProcessor({ enabled: false });
    const messages = [
      { content: 'u1', id: 'u1', role: 'user' },
      ...makeToolPair({
        apiName: 'readKnowledge',
        args: { fileIds: ['f1'], offset: 0 },
        assistantId: 'a1',
        content: makeKnowledgeXml('f1', 15_000),
        identifier: 'lobe-knowledge-base',
        toolCallId: 'tc1',
        toolMsgId: 't1',
      }),
      { content: 'u2', id: 'u2', role: 'user' },
      { content: 'u3', id: 'u3', role: 'user' },
      { content: 'u4', id: 'u4', role: 'user' },
    ];
    const ctx = makeContext(messages);
    const out = await processor.process(ctx);
    expect(out.messages[2].content).toBe(messages[2].content);
    expect(out.metadata.arckepToolResultTrim).toBeUndefined();
  });

  describe('Rule 1: lobe-knowledge-base / readKnowledge', () => {
    it('deduplicates earlier reads with identical (sorted fileIds, offset, query) and trims old reads with JSON cursor', async () => {
      const processor = new ArckepToolResultTrimProcessor();
      const xmlPage0 = makeKnowledgeXml('file-alpha', 12_000, 0, 60_000);
      const xmlMulti1 = makeKnowledgeXml('file-b', 10_000, 20_000, 60_000);
      const xmlMulti2 = makeKnowledgeXml('file-b', 10_000, 20_000, 60_000);

      const messages = [
        // Turn 1 (old: < appliedCutoff)
        { content: 'Turn 1', id: 'u1', role: 'user' },
        ...makeToolPair({
          apiName: 'readKnowledge',
          args: { fileIds: ['file-alpha'], offset: 0 },
          assistantId: 'a1',
          content: xmlPage0,
          identifier: 'lobe-knowledge-base',
          toolCallId: 'tc1',
          toolMsgId: 't1',
        }),
        // Turn 2 (within recent 3 turns, but duplicated in Turn 3 with reversed fileIds order)
        { content: 'Turn 2', id: 'u2', role: 'user' },
        ...makeToolPair({
          apiName: 'readKnowledge',
          args: { fileIds: ['file-b', 'file-a'], offset: 20_000, query: 'revenue' },
          assistantId: 'a2',
          content: xmlMulti1,
          identifier: 'lobe-knowledge-base',
          toolCallId: 'tc2',
          toolMsgId: 't2',
        }),
        // Turn 3 (within recent 3 turns — latest duplicate)
        { content: 'Turn 3', id: 'u3', role: 'user' },
        ...makeToolPair({
          apiName: 'readKnowledge',
          args: { fileIds: ['file-a', 'file-b'], offset: 20_000, query: 'revenue' },
          assistantId: 'a3',
          content: xmlMulti2,
          identifier: 'lobe-knowledge-base',
          toolCallId: 'tc3',
          toolMsgId: 't3',
        }),
        // Turn 4 (current user message)
        { content: 'Turn 4', id: 'u4', role: 'user' },
        // In-flight step AFTER lastUserIndex: must NOT deduplicate tc3!
        ...makeToolPair({
          apiName: 'readKnowledge',
          args: { fileIds: ['file-a', 'file-b'], offset: 20_000, query: 'revenue' },
          assistantId: 'a4-step',
          content: xmlMulti2,
          identifier: 'lobe-knowledge-base',
          toolCallId: 'tc4-step',
          toolMsgId: 't4-step',
        }),
      ];

      const out = await processor.process(makeContext(messages));

      // t1 (< appliedCutoff) is replaced with deterministic cursor stub
      expect(out.messages[2].content).toContain('Original knowledge page retained');
      expect(out.messages[2].content).toContain('"fileId":"file-alpha"');
      expect(out.messages[2].content).toContain('"startOffset":0');
      expect(out.messages[2].content).toContain('"endOffset":12000');
      expect(out.messages[2].content).toContain('"nextOffset":12000');
      expect(out.messages[2].content).toContain('"totalCharCount":60000');

      // t2 (deduplicated by t3) is replaced with deterministic cursor stub
      expect(out.messages[5].content).toContain('Original knowledge page retained');
      expect(out.messages[5].content).toContain('"startOffset":20000');

      // t3 (latest within <= lastUserIndex) is preserved intact!
      expect(out.messages[8].content).toBe(xmlMulti2);
      // t4-step (> lastUserIndex) is preserved intact!
      expect(out.messages[11].content).toBe(xmlMulti2);
      expect(out.metadata.arckepToolResultTrim?.deduplicatedCount).toBe(1);
    });

    it('keeps distinct startLine/maxLines pages separate and preserves line cursors in stubs', async () => {
      const processor = new ArckepToolResultTrimProcessor();
      const makeLineKnowledgeXml = (
        fileId: string,
        startLine: number,
        endLine: number,
        nextStartLine: number | null,
        totalLines: number,
      ) => {
        const cov = JSON.stringify({
          complete: false,
          endLine,
          endOffset: endLine * 50,
          lineEnding: 'CRLF',
          nextOffset: nextStartLine ? endLine * 50 : null,
          nextStartLine,
          startLine,
          startOffset: (startLine - 1) * 50,
          totalCharCount: totalLines * 50,
          totalLines,
        });
        const body = `L${startLine}: ${'x'.repeat(6000)}`;
        return `<knowledge_base_files totalCount="1">\n<file id="${fileId}" name="Module1.bas">\n<coverage>${cov}</coverage>\n${body}\n</file>\n</knowledge_base_files>`;
      };

      const oldPage = makeLineKnowledgeXml('vba-1', 1, 250, 251, 900);
      const page1 = makeLineKnowledgeXml('vba-1', 1, 250, 251, 900);
      const page2 = makeLineKnowledgeXml('vba-1', 251, 500, 501, 900);
      const page1Short = makeLineKnowledgeXml('vba-1', 1, 100, 101, 900);

      const messages = [
        // Turn 1 (old: < appliedCutoff)
        { content: 'Turn 1', id: 'u1', role: 'user' },
        ...makeToolPair({
          apiName: 'readKnowledge',
          args: { fileIds: ['vba-1'], startLine: 1 },
          assistantId: 'a1',
          content: oldPage,
          identifier: 'lobe-knowledge-base',
          toolCallId: 'tc-old',
          toolMsgId: 't-old',
        }),
        // Turn 2 (recent: startLine=1 default maxLines=250 -> will be deduped by Turn 3 explicit maxLines=250)
        { content: 'Turn 2', id: 'u2', role: 'user' },
        ...makeToolPair({
          apiName: 'readKnowledge',
          args: { fileIds: ['vba-1'], startLine: 1 },
          assistantId: 'a2',
          content: page1,
          identifier: 'lobe-knowledge-base',
          toolCallId: 'tc-p1-a',
          toolMsgId: 't-p1-a',
        }),
        // Turn 3 (recent: distinct startLine=251 AND distinct maxLines=100 AND duplicate startLine=1,maxLines=250)
        { content: 'Turn 3', id: 'u3', role: 'user' },
        ...makeToolPair({
          apiName: 'readKnowledge',
          args: { fileIds: ['vba-1'], startLine: 251 },
          assistantId: 'a3-p2',
          content: page2,
          identifier: 'lobe-knowledge-base',
          toolCallId: 'tc-p2',
          toolMsgId: 't-p2',
        }),
        ...makeToolPair({
          apiName: 'readKnowledge',
          args: { fileIds: ['vba-1'], maxLines: 100, startLine: 1 },
          assistantId: 'a3-short',
          content: page1Short,
          identifier: 'lobe-knowledge-base',
          toolCallId: 'tc-short',
          toolMsgId: 't-short',
        }),
        ...makeToolPair({
          apiName: 'readKnowledge',
          args: { fileIds: ['vba-1'], maxLines: 250, startLine: 1 },
          assistantId: 'a3-p1-b',
          content: page1,
          identifier: 'lobe-knowledge-base',
          toolCallId: 'tc-p1-b',
          toolMsgId: 't-p1-b',
        }),
        // Turn 4 (current)
        { content: 'Turn 4', id: 'u4', role: 'user' },
      ];

      const out = await processor.process(makeContext(messages));

      // t-old and t-p1-a are stubbed with line cursor fields preserved
      const oldStub = out.messages.find((m) => m.id === 't-old')?.content;
      expect(oldStub).toContain('Original knowledge page retained');
      expect(oldStub).toContain('"startLine":1');
      expect(oldStub).toContain('"endLine":250');
      expect(oldStub).toContain('"nextStartLine":251');
      expect(oldStub).toContain('"totalLines":900');

      const dupStub = out.messages.find((m) => m.id === 't-p1-a')?.content;
      expect(dupStub).toContain('Original knowledge page retained');
      expect(dupStub).toContain('"startLine":1');
      expect(dupStub).toContain('"nextStartLine":251');

      // Different startLine (251), different maxLines (100), and latest startLine=1 are ALL kept intact!
      expect(out.messages.find((m) => m.id === 't-p2')?.content).toBe(page2);
      expect(out.messages.find((m) => m.id === 't-short')?.content).toBe(page1Short);
      expect(out.messages.find((m) => m.id === 't-p1-b')?.content).toBe(page1);
    });
  });

  describe('Rule 2: getTopicContext & searchKnowledgeBase', () => {
    it('trims old >4000 outputs keeping 1200 head, JSON cursor, and 400 tail', async () => {
      const processor = new ArckepToolResultTrimProcessor();
      const archiveHeader = `Original conversation archive. ${JSON.stringify({
        complete: false,
        endOffset: 20_000,
        nextOffset: 20_000,
        snapshotAt: '2026-11-21T12:00:00.000Z',
        startOffset: 0,
        totalCharCount: 75_000,
      })}`;
      const archiveContent = `${archiveHeader}\nHEAD_MARKER_${'A'.repeat(8000)}_TAIL_MARKER`;
      const searchContent = `SEARCH_HEAD_${'S'.repeat(6000)}_SEARCH_TAIL`;

      const messages = [
        { content: 'u1', id: 'u1', role: 'user' },
        ...makeToolPair({
          apiName: 'getTopicContext',
          args: { mode: 'archive', topicId: 't-1' },
          assistantId: 'a1',
          content: archiveContent,
          identifier: 'lobe-topic-reference',
          toolCallId: 'tc1',
          toolMsgId: 't1',
        }),
        ...makeToolPair({
          apiName: 'searchKnowledgeBase',
          args: { query: 'budget' },
          assistantId: 'a1b',
          content: searchContent,
          identifier: 'lobe-knowledge-base',
          toolCallId: 'tc1b',
          toolMsgId: 't1b',
        }),
        { content: 'u2', id: 'u2', role: 'user' },
        { content: 'u3', id: 'u3', role: 'user' },
        { content: 'u4', id: 'u4', role: 'user' },
      ];

      const out = await processor.process(makeContext(messages));
      const trimmedTopic = out.messages[2].content as string;
      expect(trimmedTopic.length).toBeLessThan(2500);
      expect(trimmedTopic).toContain('HEAD_MARKER_');
      expect(trimmedTopic).toContain('_TAIL_MARKER');
      expect(trimmedTopic).toContain('"nextOffset":20000');
      expect(trimmedTopic).toContain('"snapshotAt":"2026-11-21T12:00:00.000Z"');

      const trimmedSearch = out.messages[4].content as string;
      expect(trimmedSearch.length).toBeLessThan(2000);
      expect(trimmedSearch.startsWith('SEARCH_HEAD_')).toBe(true);
      expect(trimmedSearch.endsWith('_SEARCH_TAIL')).toBe(true);
    });
  });

  describe('Rule 3: lobe-agent-documents / readDocument & readDocumentByFilename', () => {
    it('supersedes earlier reads after successful edit/upsert/remove or repeat read, but ignores failed mutations', async () => {
      const processor = new ArckepToolResultTrimProcessor();
      const doc1Page = makeAgentDocPage('doc-1', 'plan.md', 9000, 0);
      const doc2Page = makeAgentDocPage('doc-2', 'keep.md', 9000, 0);

      const messages = [
        // Recent window (only 2 user turns -> appliedCutoff = 0)
        { content: 'u1', id: 'u1', role: 'user' },
        // Read doc-1 by filename, then editDocument by id -> superseded!
        ...makeToolPair({
          apiName: 'readDocumentByFilename',
          args: { filename: 'plan.md' },
          assistantId: 'a1',
          content: doc1Page,
          identifier: 'lobe-agent-documents',
          toolCallId: 'tc1',
          toolMsgId: 't1',
        }),
        ...makeToolPair({
          apiName: 'editDocument',
          args: { content: 'updated', id: 'doc-1' },
          assistantId: 'a2',
          content: 'Updated document doc-1.',
          identifier: 'lobe-agent-documents',
          pluginState: { id: 'doc-1', updated: true },
          toolCallId: 'tc2',
          toolMsgId: 't2',
        }),
        // Read doc-2, followed by FAILED removeDocument -> NOT superseded!
        ...makeToolPair({
          apiName: 'readDocument',
          args: { id: 'doc-2' },
          assistantId: 'a3',
          content: doc2Page,
          identifier: 'lobe-agent-documents',
          toolCallId: 'tc3',
          toolMsgId: 't3',
        }),
        ...makeToolPair({
          apiName: 'removeDocument',
          args: { id: 'doc-2' },
          assistantId: 'a4',
          content: 'Document not found: doc-2',
          identifier: 'lobe-agent-documents',
          toolCallId: 'tc4',
          toolMsgId: 't4',
        }),
        { content: 'u2', id: 'u2', role: 'user' },
      ];

      const out = await processor.process(makeContext(messages));

      // t1 was superseded by editDocument on doc-1
      expect(out.messages[2].content).toContain('Original agent document page retained');
      expect(out.messages[2].content).toContain('"id":"doc-1"');
      expect(out.messages[2].content).toContain('"filename":"plan.md"');
      expect(out.messages[2].content).toContain('"totalLength":50000');
      expect(out.messages[2].content).toContain('"snapshot":"sha256:');

      // t3 was NOT superseded because removeDocument failed (and cutoff = 0)
      expect(out.messages[6].content).toBe(doc2Page);
    });
  });

  describe('Rule 4 (Invariant #2): lobe-activator / activateSkill', () => {
    it('always retains the latest successful activateSkill per skillName intact even older than 3 turns, while collapsing earlier duplicates', async () => {
      const processor = new ArckepToolResultTrimProcessor();
      const artifactsSkillBody = `<skill name="Artifacts">\n${'S'.repeat(12_000)}\n</skill>`;
      const chartsSkillBody = `<skill name="Charts">\n${'C'.repeat(11_000)}\n</skill>`;

      const messages = [
        // Turn 1 (older than 3 user turns!)
        { content: 'u1', id: 'u1', role: 'user' },
        ...makeToolPair({
          apiName: 'activateSkill',
          args: { name: 'Artifacts' },
          assistantId: 'a1',
          content: artifactsSkillBody,
          identifier: 'lobe-activator',
          toolCallId: 'tc-skill-dup',
          toolMsgId: 't-skill-dup',
        }),
        ...makeToolPair({
          apiName: 'activateSkill',
          args: { skillName: 'Charts' },
          assistantId: 'a1b',
          content: chartsSkillBody,
          identifier: 'lobe-activator',
          toolCallId: 'tc-charts-only',
          toolMsgId: 't-charts-only',
        }),
        // Turn 2 (also older than 3 user turns! Second call to Artifacts)
        { content: 'u2', id: 'u2', role: 'user' },
        ...makeToolPair({
          apiName: 'activateSkill',
          args: { identifier: 'Artifacts' },
          assistantId: 'a2',
          content: artifactsSkillBody,
          identifier: 'lobe-activator',
          toolCallId: 'tc-skill-latest',
          toolMsgId: 't-skill-latest',
        }),
        { content: 'u3', id: 'u3', role: 'user' },
        { content: 'u4', id: 'u4', role: 'user' },
        { content: 'u5', id: 'u5', role: 'user' },
      ];

      const out = await processor.process(makeContext(messages));

      // Earlier duplicate of Artifacts is collapsed
      expect(out.messages[2].content).toBe(
        'Skill "Artifacts" already activated; full instructions retained in the latest activateSkill("Artifacts") result below.',
      );
      // Only call to Charts (in Turn 1, >3 turns ago, 11 KB) is 100% untouched!
      expect(out.messages[4].content).toBe(chartsSkillBody);
      // Latest call to Artifacts (in Turn 2, >3 turns ago, 12 KB) is 100% untouched!
      expect(out.messages[7].content).toBe(artifactsSkillBody);
    });
  });

  describe('Rule 5 & Rule 6: list_models, JSON args, <lobeArtifact> with src, and arckep-text-file protection', () => {
    it('compacts old JSON arguments, deduplicates list_models, ignores <lobeArtifact src="..."> without body, and never touches arckep-text-file', async () => {
      const processor = new ArckepToolResultTrimProcessor();
      const bigCode = `import os\n${'x = 1\n'.repeat(1200)}print("done")`;
      const writePartText = 'W'.repeat(9000);
      const writePartReceipt = `ARCKEP_TEXT_FILE_V1\n${JSON.stringify({
        bytes: 9000,
        documentId: 'doc-w1',
        part: 1,
      })}`;
      const htmlV1 = `<div>${'A'.repeat(1200)}</div>`;
      const htmlV2 = `<div>${'B'.repeat(1300)}</div>`;
      const modelListJson = JSON.stringify({
        models: Array.from({ length: 200 }, (_, i) => `model-${i}-${'m'.repeat(80)}`),
      });

      const messages = [
        // Turn 1 (old: < appliedCutoff)
        { content: 'u1', id: 'u1', role: 'user' },
        ...makeToolPair({
          apiName: 'execute_code',
          args: { code: bigCode, language: 'python' },
          assistantContent: null,
          assistantId: 'a-exec',
          content: `STDOUT:\n${'L'.repeat(6000)}\nEND_STDOUT`,
          identifier: 'mcp-arckep-e2b-sandbox',
          toolCallId: 'tc-exec',
          toolMsgId: 't-exec',
          type: 'mcp',
        }),
        ...makeToolPair({
          apiName: 'writePart',
          args: { documentId: 'doc-w1', part: 1, text: writePartText },
          assistantId: 'a-write',
          content: writePartReceipt,
          identifier: 'arckep-text-file',
          toolCallId: 'tc-write',
          toolMsgId: 't-write',
        }),
        ...makeToolPair({
          apiName: 'list_models',
          args: { category: 'image', limit: 50 },
          assistantId: 'a-models-1',
          content: modelListJson,
          identifier: 'mcp-arckep-studio-image',
          toolCallId: 'tc-models-1',
          toolMsgId: 't-models-1',
          type: 'mcp',
        }),
        {
          content: `Version 1:\n<lobeArtifact identifier="email-tpl" type="text/html">${htmlV1}</lobeArtifact>\nAnd keep:\n<lobeArtifact identifier="kept-art" type="text/html">${htmlV1}</lobeArtifact>`,
          id: 'a-art-1',
          role: 'assistant',
        },
        // Turn 2
        { content: 'u2', id: 'u2', role: 'user' },
        // Same list_models with reversed JSON key order -> deduplicates t-models-1!
        ...makeToolPair({
          apiName: 'list_models',
          args: { limit: 50, category: 'image' },
          assistantId: 'a-models-2',
          content: modelListJson,
          identifier: 'mcp-arckep-studio-image',
          toolCallId: 'tc-models-2',
          toolMsgId: 't-models-2',
          type: 'mcp',
        }),
        // External src="..." reference with empty body must NOT supersede kept-art!
        // While email-tpl gets a full new inline body -> supersedes email-tpl in a-art-1!
        {
          content: `<lobeArtifact identifier="kept-art" src="https://cdn.example.com/kept.html"></lobeArtifact>\n<lobeArtifact identifier="kept-art" src="https://cdn.example.com/kept2.html" />\n<lobeArtifact identifier="email-tpl" type="text/html">${htmlV2}</lobeArtifact>`,
          id: 'a-art-2',
          role: 'assistant',
        },
        { content: 'u3', id: 'u3', role: 'user' },
        { content: 'u4', id: 'u4', role: 'user' },
      ];

      const out = await processor.process(makeContext(messages));

      // Preserves exact message count and IDs (Invariant #3)
      expect(out.messages.map((m) => m.id)).toEqual(messages.map((m) => m.id));

      // Assistant content: null with tool_calls normalized to ''
      expect(out.messages[1].content).toBe('');
      // Old execute_code JSON arguments shrunk & still 100% valid JSON, synced across tool_calls and tools
      const shrunkArgs = out.messages[1].tool_calls[0].function.arguments;
      expect(shrunkArgs.length).toBeLessThan(2000);
      expect(() => JSON.parse(shrunkArgs)).not.toThrow();
      expect(out.messages[1].tools[0].arguments).toBe(shrunkArgs);
      // Old execute_code stdout trimmed
      expect(out.messages[2].content.length).toBeLessThan(2000);
      expect(out.messages[2].content).toContain('END_STDOUT');

      // arckep-text-file writePart args and receipt are 100% UNTOUCHED!
      expect(JSON.parse(out.messages[3].tool_calls[0].function.arguments).text).toBe(writePartText);
      expect(out.messages[4].content).toBe(writePartReceipt);

      // list_models #1 deduplicated, list_models #2 (in recent turns) kept full
      expect(out.messages[6].content).toContain('Model list');
      expect(out.messages[10].content).toBe(modelListJson);

      // email-tpl in a-art-1 compacted, kept-art in a-art-1 NOT compacted despite src="..." tags!
      expect(out.messages[7].content).toContain('Предыдущая версия макета');
      expect(out.messages[7].content).toContain(htmlV1); // kept-art still has full htmlV1
      expect(out.messages[11].content).toContain(htmlV2);
    });
  });

  describe('User turn detection & Warm-cache break-even gate + Sticky replay', () => {
    it('ignores systemInjection, compressed_history_summary, and non-user initialState messages when counting user turns', async () => {
      const processor = new ArckepToolResultTrimProcessor();
      const bigOutput = 'X'.repeat(8000);

      const initialMessages = [
        { content: 'Compressed summary', id: 'cg-1', role: 'compressedGroup' },
        { content: 'Real user 1', id: 'u1', role: 'user' },
        {
          agentId: 'other-agent',
          content: 'Other agent reply',
          id: 'other-asst-1',
          role: 'assistant',
        },
        ...makeToolPair({
          apiName: 'web_search',
          args: { q: 'arckep' },
          assistantId: 'a1',
          content: bigOutput,
          identifier: 'mcp-arckep-studio-web',
          toolCallId: 'tc1',
          toolMsgId: 't1',
        }),
        { content: 'Real user 2', id: 'u2', role: 'user' },
      ];

      // Simulate pipeline state after BaseFirstUserContentProvider, CompressedGroupRoleTransform, and GroupRoleTransform
      const pipelineMessages = [
        {
          content: '<memory>injected</memory>',
          id: 'system-injection-1',
          meta: { systemInjection: true },
          role: 'user',
        },
        {
          compressedMessages: [{ id: 'old' }],
          content:
            '<compressed_history_summary>\nCompressed summary\n</compressed_history_summary>',
          id: 'cg-1',
          role: 'user',
        },
        initialMessages[1], // Real user 1
        {
          content: '<speaker name="Helper" />\nOther agent reply',
          id: 'other-asst-1',
          role: 'user',
        },
        initialMessages[3], // a1
        initialMessages[4], // t1
        initialMessages[5], // Real user 2
      ];

      const out = await processor.process(makeContext(pipelineMessages, { initialMessages }));

      // Only 2 real human user messages exist (u1, u2) -> cutoffIndex MUST be 0, so t1 is NOT trimmed!
      expect(out.metadata.arckepToolResultTrim?.cutoffIndex).toBe(0);
      expect(out.messages[5].content).toBe(bigOutput);
    });

    it('defers window shift on warm cache when savings are small, shifts when savings break even or maxDeferredTurns reached', async () => {
      const baseTime = 1_760_000_000_000;
      const smallToolOut = 'S'.repeat(4500); // saves ~2800 chars (< warmMinSavedChars 4000)
      const tailPadding = 'T'.repeat(20_000); // large cached tail in recent turns

      // Turn 4 (cold history): establishes sticky baseline cutoff at u2
      const turn4Messages = [
        { content: 'u1', createdAt: baseTime, id: 'u1', role: 'user' },
        ...makeToolPair({
          apiName: 'web_search',
          args: { q: '1' },
          assistantId: 'a1',
          content: 'A'.repeat(10_000),
          createdAt: baseTime + 1000,
          identifier: 'mcp-arckep-studio-web',
          toolCallId: 'tc1',
          toolMsgId: 't1',
        }),
        { content: 'u2', createdAt: baseTime + 600_000, id: 'u2', role: 'user' },
        ...makeToolPair({
          apiName: 'web_search',
          args: { q: '2' },
          assistantId: 'a2',
          content: smallToolOut,
          createdAt: baseTime + 601_000,
          identifier: 'mcp-arckep-studio-web',
          toolCallId: 'tc2',
          toolMsgId: 't2',
        }),
        { content: `u3 ${tailPadding}`, createdAt: baseTime + 1_200_000, id: 'u3', role: 'user' },
        { content: 'a3', createdAt: baseTime + 1_201_000, id: 'a3', role: 'assistant' },
        { content: `u4 ${tailPadding}`, createdAt: baseTime + 1_800_000, id: 'u4', role: 'user' },
      ];

      const coldProcessor = new ArckepToolResultTrimProcessor({ cacheWarm: false });
      const turn4Out = await coldProcessor.process(makeContext(turn4Messages));
      // On Turn 4: u1's tool is trimmed, u2's tool is inside recent 3 turns (u2, u3, u4) so kept full
      expect(turn4Out.messages[2].content.length).toBeLessThan(2000);
      expect(turn4Out.messages[5].content).toBe(smallToolOut);

      // Turn 5 (warm follow-up 30s later, small savings in u2 < break-even + new duplicate in Turn 4):
      const turn5WarmSmall = [
        ...turn4Messages,
        // Assistant in Turn 4 produced a small duplicate artifact or reply
        {
          content: 'Turn 4 reply',
          createdAt: baseTime + 1_805_000,
          id: 'a4',
          role: 'assistant',
        },
        { content: 'u5 warm', createdAt: baseTime + 1_830_000, id: 'u5', role: 'user' },
      ];

      const warmProcessor = new ArckepToolResultTrimProcessor({ cacheWarm: true });
      const turn5SmallOut = await warmProcessor.process(makeContext(turn5WarmSmall));

      // Cutoff MUST remain at u2 (index 3), preserving byte-identical prefix with Turn 4!
      expect(turn5SmallOut.metadata.arckepToolResultTrim?.cacheWarm).toBe(true);
      expect(turn5SmallOut.metadata.arckepToolResultTrim?.cutoffIndex).toBe(
        turn4Out.metadata.arckepToolResultTrim?.cutoffIndex,
      );
      expect(JSON.stringify(turn5SmallOut.messages.slice(0, turn4Out.messages.length))).toBe(
        JSON.stringify(turn4Out.messages),
      );

      // Now test Turn 5 warm with HUGE 60 KB tool output in u2 -> exceeds break-even and shifts window!
      const turn5WarmHuge = turn5WarmSmall.map((m) =>
        m.id === 't2' ? { ...m, content: 'H'.repeat(60_000) } : m,
      );
      const turn5HugeOut = await warmProcessor.process(makeContext(turn5WarmHuge));
      expect(turn5HugeOut.metadata.arckepToolResultTrim?.cutoffIndex).toBeGreaterThan(
        turn4Out.metadata.arckepToolResultTrim!.cutoffIndex,
      );
      expect(turn5HugeOut.messages[5].content.length).toBeLessThan(2000);
    });

    it('does not burn deferredTurns on idle plain-text warm turns and measures cachedTailChars from true firstDiffIdx', async () => {
      const t0 = 1_760_500_000_000;
      const small4500 = 'S'.repeat(4500); // saves ~2837 chars
      const cached60KB = 'T'.repeat(30_000);

      // Turns 1..4 cold (10m apart), Turns 2 & 3 are plain text (0 trimmable bytes!), Turn 4 has small4500 tool,
      // followed by 2 warm plain-text turns (Turn 5 at +30s, Turn 6 at +60s) and Turn 7 warm (+90s) when Turn 4 ages out!
      const messages = [
        { content: 'u1', createdAt: t0, id: 'u1', role: 'user' },
        ...makeToolPair({
          apiName: 'web_search',
          args: { q: 'init' },
          assistantId: 'a1',
          content: 'A'.repeat(12_000),
          createdAt: t0 + 1000,
          identifier: 'mcp-arckep-studio-web',
          toolCallId: 'tc1',
          toolMsgId: 't1',
        }),
        { content: 'u2 plain', createdAt: t0 + 600_000, id: 'u2', role: 'user' },
        { content: 'a2 plain', createdAt: t0 + 601_000, id: 'a2', role: 'assistant' },
        { content: 'u3 plain', createdAt: t0 + 1_200_000, id: 'u3', role: 'user' },
        { content: 'a3 plain', createdAt: t0 + 1_201_000, id: 'a3', role: 'assistant' },
        { content: 'u4 small tool', createdAt: t0 + 1_800_000, id: 'u4', role: 'user' },
        ...makeToolPair({
          apiName: 'web_search',
          args: { q: 'small' },
          assistantId: 'a4',
          content: small4500,
          createdAt: t0 + 1_801_000,
          identifier: 'mcp-arckep-studio-web',
          toolCallId: 'tc4',
          toolMsgId: 't4',
        }),
        // Turn 5 warm (+30s): ages out u2 (plain text -> deltaSavedChars === 0, must NOT increment deferredTurns!)
        { content: `u5 warm ${cached60KB}`, createdAt: t0 + 1_830_000, id: 'u5', role: 'user' },
        { content: 'a5', createdAt: t0 + 1_831_000, id: 'a5', role: 'assistant' },
        // Turn 6 warm (+60s): ages out u3 (plain text -> deltaSavedChars === 0, must NOT increment deferredTurns!)
        { content: `u6 warm ${cached60KB}`, createdAt: t0 + 1_860_000, id: 'u6', role: 'user' },
        { content: 'a6', createdAt: t0 + 1_861_000, id: 'a6', role: 'assistant' },
        // Turn 7 warm (+90s): ages out u4 (small4500, saves ~2837 chars vs >60KB warm tail) -> MUST defer!
        { content: 'u7 warm', createdAt: t0 + 1_890_000, id: 'u7', role: 'user' },
      ];

      const processor = new ArckepToolResultTrimProcessor();
      const turn7Out = await processor.process(makeContext(messages));

      // Turn 4's small4500 tool MUST still be untrimmed (not prematurely evicted after 2 idle turns!)
      const t4Msg = turn7Out.messages.find((m) => m.id === 't4');
      expect(t4Msg?.content).toBe(small4500);

      // Turn 8 warm (+120s): Turn 5 was plain text, but firstDiffIdx is STILL back at t4 in Turn 4,
      // so cachedTailChars includes Turn 5 (30KB) + Turn 6 (30KB) + Turn 7 -> still deferred (deferredTurns = 2 < 3)!
      const turn8Messages = [
        ...messages,
        { content: 'a7', createdAt: t0 + 1_891_000, id: 'a7', role: 'assistant' },
        { content: 'u8 warm', createdAt: t0 + 1_920_000, id: 'u8', role: 'user' },
      ];
      const turn8Out = await processor.process(makeContext(turn8Messages));
      expect(turn8Out.messages.find((m) => m.id === 't4')?.content).toBe(small4500);
    });

    it('ignores orphan tool rows without matching assistant tool_call_id and normalizes content: null on plain assistant rows', async () => {
      const processor = new ArckepToolResultTrimProcessor();
      const realXml = makeKnowledgeXml('f-real', 12_000, 0);

      const messages = [
        { content: 'u1', id: 'u1', role: 'user' },
        ...makeToolPair({
          apiName: 'readKnowledge',
          args: { fileIds: ['f-real'], offset: 0 },
          assistantId: 'a1',
          content: realXml,
          identifier: 'lobe-knowledge-base',
          toolCallId: 'tc-real',
          toolMsgId: 't-real',
        }),
        { content: null, id: 'a1-reply-null', role: 'assistant' },
        { content: 'u2', id: 'u2', role: 'user' },
        // Orphan DB tool row with unmatched tool_call_id claiming to read f-real again: must NOT deduplicate t-real!
        {
          content: realXml,
          id: 't-orphan',
          plugin: {
            apiName: 'readKnowledge',
            arguments: JSON.stringify({ fileIds: ['f-real'], offset: 0 }),
            id: 'tc-orphan',
            identifier: 'lobe-knowledge-base',
            type: 'builtin',
          },
          role: 'tool',
          tool_call_id: 'tc-orphan',
        },
        { content: 'u3', id: 'u3', role: 'user' },
      ];

      const out = await processor.process(makeContext(messages));
      expect(out.messages.find((m) => m.id === 't-real')?.content).toBe(realXml);
      expect(out.messages.find((m) => m.id === 'a1-reply-null')?.content).toBe('');
    });
  });
});
