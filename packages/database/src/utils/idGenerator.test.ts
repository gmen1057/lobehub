import { describe, expect, it, vi } from 'vitest';

import { FILE_ID_SUFFIX_LENGTH, idGenerator } from './idGenerator';

describe('idGenerator', () => {
  it('should generate a 21-char CSPRNG suffix for files and 12-char for other namespaces', () => {
    const fileId = idGenerator('files');
    expect(FILE_ID_SUFFIX_LENGTH).toBe(21);
    expect(fileId).toMatch(/^file_[\dA-Za-z]{21}$/);
    expect(fileId).toHaveLength(26);

    const messageId = idGenerator('messages');
    expect(messageId).toMatch(/^msg_[\dA-Za-z]{12}$/);

    const pluginId = idGenerator('plugins');
    expect(pluginId).toMatch(/^plg_[\dA-Za-z]{12}$/);

    const sessionGroupId = idGenerator('sessionGroups');
    expect(sessionGroupId).toMatch(/^sg_[\dA-Za-z]{12}$/);

    const sessionId = idGenerator('sessions');
    expect(sessionId).toMatch(/^ssn_[\dA-Za-z]{12}$/);

    const topicId = idGenerator('topics');
    expect(topicId).toMatch(/^tpc_[\dA-Za-z]{12}$/);

    const userId = idGenerator('user');
    expect(userId).toMatch(/^user_[\dA-Za-z]{12}$/);
  });

  it('should use CSPRNG (node:crypto) and never fall back to Math.random()', () => {
    const mathRandomSpy = vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('Math.random must not be used in idGenerator');
    });

    try {
      const seen = new Set<string>();
      for (let i = 0; i < 200; i++) {
        const id = idGenerator('files');
        expect(id).toMatch(/^file_[\dA-Za-z]{21}$/);
        seen.add(id);
      }
      expect(seen.size).toBe(200);
      expect(mathRandomSpy).not.toHaveBeenCalled();
    } finally {
      mathRandomSpy.mockRestore();
    }
  });

  it('should generate an ID with custom size when explicitly requested', () => {
    const fileId = idGenerator('files', 12);
    expect(fileId).toMatch(/^file_[\dA-Za-z]{12}$/);
  });

  it('should throw an error for invalid namespace', () => {
    expect(() => idGenerator('invalid' as any)).toThrowError(
      'Invalid namespace: invalid, please check your code.',
    );
  });
});
