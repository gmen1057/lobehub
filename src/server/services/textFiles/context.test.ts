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
  expect(JSON.parse(latest.tool_calls[0].function.arguments).text).toBe(
    ('source'.repeat(4200) + 'p12').slice(-4096),
  );
  expect(result.at(-1)).toEqual(msg('p12', 'doc', 12));
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
