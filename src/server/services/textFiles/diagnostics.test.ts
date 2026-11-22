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
    counts: {
      '["arckep-text-file","patchFile","secret patch"]': 1,
      '["arckep-text-file","writePart","secret source"]': 2,
    },
    other: { function: { name: 'weather', arguments: 'Toronto' } },
    patchCall: { function: { name: 'arckep-text-file____patchFile', arguments: 'secret patch' } },
  };
  const redacted = redactTextFileDiagnostics(raw);
  const safe = JSON.stringify(redacted);
  expect(safe).not.toContain('secret');
  expect(safe).toContain('Toronto');
  expect(safe).toContain('arckep-text-file/patchFile');
  expect(safe).toContain('arckep-text-file/writePart');
  expect(raw.payload.toolCalling.arguments).toBe('secret source');
});
