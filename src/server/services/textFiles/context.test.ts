import { expect, it } from 'vitest';

import { compactWriterContext } from './context';

it('bounds 165k+ source arguments and preserves a mixed tool call and fresh source read', () => {
  const msg = (id: string, doc: string, part: number) => ({
    role: 'tool',
    tool_call_id: id,
    content: 'ARCKEP_TEXT_FILE_V1\n' + JSON.stringify({ documentId: doc, part }),
  });
  const call = (id: string) => ({
    id,
    function: {
      name: 'arckep-text-file____writePart____builtin',
      arguments: JSON.stringify({ fileName: 'x', text: 'source'.repeat(4200) + id }),
    },
  });
  const sourceRead = {
    id: 'read',
    function: { name: 'lobe-topic-reference____getTopicContext', arguments: '{}' },
  };
  const readResult = { role: 'tool', tool_call_id: 'read', content: 'exact original source page' };
  const messages: any[] = [
    { role: 'tool', content: 'stale '.repeat(35000) },
    { role: 'user', id: 'request', content: 'Build module X' },
  ];
  for (let i = 1; i <= 12; i++) {
    messages.push(
      {
        role: 'assistant',
        content: i === 1 ? 'assistant prose' : '',
        tool_calls: i === 2 ? [call('p' + i), sourceRead] : [call('p' + i)],
      },
      msg('p' + i, 'doc', i),
    );
    if (i === 2) messages.push(readResult);
  }
  const result = compactWriterContext(messages, 'request');
  expect(JSON.stringify(result).length).toBeLessThan(6500);
  expect(result).toContainEqual(messages[1]);
  expect(result).toContainEqual(readResult);
  expect(result.find((m) => m.tool_calls?.some((c: any) => c.id === 'read')).tool_calls).toEqual([
    sourceRead,
  ]);
  expect(result.some((m) => m.content === 'assistant prose')).toBe(true);
  const latest = result.find((m) => m.tool_calls?.some((c: any) => c.id === 'p12'));
  const latestArgs = JSON.parse(latest.tool_calls[0].function.arguments);
  const fullLatestText = 'source'.repeat(4200) + 'p12';
  expect('text' in latestArgs).toBe(false);
  expect(latestArgs.fileName).toBe('x');
  expect(latestArgs._savedChars).toBe(fullLatestText.length);
  expect(latestArgs._continuationTailReadOnly).toBe(fullLatestText.slice(-4096));
  expect(result.at(-1)).toEqual(msg('p12', 'doc', 12));
});

it('drops text and omits _continuationTailReadOnly when retained writePart has final: true and text > MAX_TAIL', () => {
  const fullText = 'Sub Test()\r\n' + 'x'.repeat(6000) + '\r\nEnd Sub';
  const messages = [
    { role: 'user', id: 'req1', content: 'Write VBA module' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'w1',
          function: {
            name: 'arckep-text-file____writePart____builtin',
            arguments: JSON.stringify({
              fileName: 'Module1.bas',
              final: true,
              part: 1,
              text: fullText,
            }),
          },
        },
      ],
    },
    {
      role: 'tool',
      tool_call_id: 'w1',
      content:
        'ARCKEP_TEXT_FILE_V1\n' + JSON.stringify({ documentId: 'doc1', part: 1, status: 'ready' }),
    },
  ];

  const result = compactWriterContext(messages, 'req1');
  const callArgs = JSON.parse(result[1].tool_calls[0].function.arguments);
  expect(callArgs).toEqual({
    _savedChars: fullText.length,
    fileName: 'Module1.bas',
    final: true,
    part: 1,
  });
  expect('text' in callArgs).toBe(false);
  expect('_continuationTailReadOnly' in callArgs).toBe(false);
});

it('drops text and keeps _savedChars + _continuationTailReadOnly when retained writePart has final: false and text > MAX_TAIL', () => {
  const fullText = 'HEADER_START\n' + 'body_line\n'.repeat(600) + 'TAIL_END';
  const messages = [
    { role: 'user', id: 'req2', content: 'Write part 1' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'w2',
          function: {
            name: 'arckep-text-file____writePart____builtin',
            arguments: JSON.stringify({
              fileName: 'Module2.bas',
              final: false,
              part: 1,
              text: fullText,
            }),
          },
        },
      ],
    },
    {
      role: 'tool',
      tool_call_id: 'w2',
      content:
        'ARCKEP_TEXT_FILE_V1\n' + JSON.stringify({ documentId: 'doc2', part: 1, status: 'draft' }),
    },
  ];

  const result = compactWriterContext(messages, 'req2');
  const callArgs = JSON.parse(result[1].tool_calls[0].function.arguments);
  expect(callArgs).toEqual({
    _continuationTailReadOnly: fullText.slice(-4096),
    _savedChars: fullText.length,
    fileName: 'Module2.bas',
    final: false,
    part: 1,
  });
  expect('text' in callArgs).toBe(false);
});

it('preserves short writePart arguments untouched when text.length <= MAX_TAIL', () => {
  const shortText = 'a'.repeat(4096);
  const messages = [
    { role: 'user', id: 'req3', content: 'Write short file' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'w3',
          function: {
            name: 'arckep-text-file____writePart____builtin',
            arguments: JSON.stringify({
              fileName: 'short.bas',
              final: true,
              part: 1,
              text: shortText,
            }),
          },
        },
      ],
    },
    {
      role: 'tool',
      tool_call_id: 'w3',
      content:
        'ARCKEP_TEXT_FILE_V1\n' + JSON.stringify({ documentId: 'doc3', part: 1, status: 'ready' }),
    },
  ];

  const result = compactWriterContext(messages, 'req3');
  const callArgs = JSON.parse(result[1].tool_calls[0].function.arguments);
  expect(callArgs).toEqual({
    fileName: 'short.bas',
    final: true,
    part: 1,
    text: shortText,
  });
});

it('retains the latest of nine 20k Cyrillic source pages plus recoverable cursors for earlier reads', () => {
  const messages: any[] = [];
  for (let n = 0; n < 9; n++) {
    messages.push(
      {
        role: 'assistant',
        tool_calls: [
          {
            id: 'r' + n,
            function: {
              name: 'lobe-topic-reference____getTopicContext____builtin',
              arguments: JSON.stringify({
                mode: 'code_artifacts',
                fileId: 'file',
                offset: n * 20000,
              }),
            },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'r' + n,
        content:
          JSON.stringify({ fileId: 'file', startOffset: n * 20000, nextOffset: (n + 1) * 20000 }) +
          '\n' +
          'я'.repeat(20000),
      },
    );
  }
  const compacted = compactWriterContext(messages);
  expect(compacted).toHaveLength(messages.length);
  expect(compacted.at(-1)).toEqual(messages.at(-1));
  expect(compacted[1].content).toContain('"nextOffset":20000');
  expect(compacted[0]).toEqual(messages[0]);
  expect(JSON.stringify(compacted).length).toBeLessThan(25000);
});

it('compacts patchFile edits into _appliedEditsCount, parses diff-tailed receipts, and drops superseded writes/patches', () => {
  const receipt1 =
    'ARCKEP_TEXT_FILE_V1\n' +
    JSON.stringify({
      documentId: 'doc-p',
      fileId: 'f1',
      fileName: 'm.bas',
      part: 1,
      status: 'ready',
    }) +
    '\nPatch applied: 2 edits, lines 10 -> 10 (+2 / -2)\n@@ -1,2 +1,2 @@\n-a\n+b';
  const receipt2 =
    'ARCKEP_TEXT_FILE_V1\n' +
    JSON.stringify({
      documentId: 'doc-p',
      fileId: 'f2',
      fileName: 'm.bas',
      part: 2,
      status: 'ready',
    }) +
    '\nPatch applied: 3 edits, lines 10 -> 12 (+3 / -1)\n@@ -5,2 +5,4 @@\n+new line';

  const messages = [
    { content: 'Patch the file', id: 'req-p', role: 'user' },
    {
      content: '',
      role: 'assistant',
      tool_calls: [
        {
          function: {
            arguments: JSON.stringify({
              edits: [
                { newText: 'b1'.repeat(2000), oldText: 'a1'.repeat(2000) },
                { newText: 'b2', oldText: 'a2' },
              ],
              fileName: 'm.bas',
              sourceFileId: 'src-1',
            }),
            name: 'arckep-text-file____patchFile____builtin',
          },
          id: 'p1',
        },
      ],
    },
    { content: receipt1, role: 'tool', tool_call_id: 'p1' },
    {
      content: '',
      role: 'assistant',
      tool_calls: [
        {
          function: {
            arguments: JSON.stringify({
              documentId: 'doc-p',
              edits: [
                { newText: 'n1'.repeat(3000), oldText: 'o1'.repeat(3000) },
                { newText: 'n2', oldText: 'o2' },
                { newText: 'n3', oldText: 'o3' },
              ],
            }),
            name: 'arckep-text-file____patchFile____builtin',
          },
          id: 'p2',
        },
      ],
    },
    { content: receipt2, role: 'tool', tool_call_id: 'p2' },
  ];

  const compacted = compactWriterContext(messages, 'req-p');
  // p1 (superseded) dropped; p2 (latest) retained with edits folded into _appliedEditsCount
  expect(compacted).toHaveLength(3);
  const callArgs = JSON.parse(compacted[1].tool_calls[0].function.arguments);
  expect(callArgs).toEqual({
    _appliedEditsCount: 3,
    documentId: 'doc-p',
  });
  expect('edits' in callArgs).toBe(false);
  // Full tool content with diff summary is preserved for the LLM on the retained latest patch
  expect(compacted[2].content).toBe(receipt2);
});

it('retains line-based cursor fields (startLine, endLine, nextStartLine, totalLines) in compacted oldPages', () => {
  const page = (startLine: number, endLine: number, nextStartLine: number | null) =>
    JSON.stringify({
      endLine,
      fileId: 'f-lines',
      nextStartLine,
      startLine,
      totalLines: 800,
    }) +
    '\n' +
    'L1: '.repeat(1500);

  const messages = [
    {
      role: 'assistant',
      tool_calls: [
        {
          function: {
            arguments: JSON.stringify({ fileIds: ['f-lines'], startLine: 1 }),
            name: 'lobe-knowledge-base____readKnowledge____builtin',
          },
          id: 'rk1',
        },
      ],
    },
    { content: page(1, 250, 251), role: 'tool', tool_call_id: 'rk1' },
    {
      role: 'assistant',
      tool_calls: [
        {
          function: {
            arguments: JSON.stringify({ fileIds: ['f-lines'], startLine: 251 }),
            name: 'lobe-knowledge-base____readKnowledge____builtin',
          },
          id: 'rk2',
        },
      ],
    },
    { content: page(251, 500, 501), role: 'tool', tool_call_id: 'rk2' },
  ];

  const compacted = compactWriterContext(messages);
  expect(compacted[1].content).toContain('"startLine":1');
  expect(compacted[1].content).toContain('"endLine":250');
  expect(compacted[1].content).toContain('"nextStartLine":251');
  expect(compacted[1].content).toContain('"totalLines":800');
  expect(compacted[3].content).toBe(messages[3].content);
});
