import { describe, expect, it } from 'vitest';

import { resolveAssistantParentId } from './resolveAssistantParentId';

describe('resolveAssistantParentId', () => {
  it('keeps the fallback when the last message is not a tool', () => {
    expect(
      resolveAssistantParentId(
        [
          { id: 'user-1', role: 'user', createdAt: 1 },
          { id: 'asst-1', role: 'assistant', createdAt: 2 },
        ],
        'user-1',
      ),
    ).toBe('user-1');
  });

  it('parents the next assistant to the last tool after a tool round', () => {
    expect(
      resolveAssistantParentId(
        [
          { id: 'user-1', role: 'user', createdAt: 1 },
          { id: 'asst-1', role: 'assistant', createdAt: 2 },
          { id: 'tool-1', role: 'tool', createdAt: 3 },
          { id: 'tool-2', role: 'tool', createdAt: 4 },
        ],
        'asst-1',
      ),
    ).toBe('tool-2');
  });

  it('returns the fallback when there are no messages', () => {
    expect(resolveAssistantParentId([], 'user-1')).toBe('user-1');
  });
});
