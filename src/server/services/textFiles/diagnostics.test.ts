import { expect, it } from 'vitest';

import { CONTINUATION_CONTEXT, redactTextFileDiagnostics } from './diagnostics';

it('omits source arguments and continuation tail from Langfuse and step diagnostics', () => {
  const raw = {
    messages: [{ role: 'user', content: 'continue' + CONTINUATION_CONTEXT + 'secret tail' }],
    tool_calls: [
      { function: { name: 'arckep-text-file____writePart', arguments: 'secret source' } },
    ],
    payload: {
      toolCalling: {
        identifier: 'arckep-text-file',
        apiName: 'writePart',
        arguments: 'secret source',
      },
    },
    counts: { '["arckep-text-file","writePart","secret source"]': 2 },
    other: { function: { name: 'weather', arguments: 'Toronto' } },
  };
  const safe = JSON.stringify(redactTextFileDiagnostics(raw));
  expect(safe).not.toContain('secret');
  expect(safe).toContain('Toronto');
  expect(raw.payload.toolCalling.arguments).toBe('secret source');
});
