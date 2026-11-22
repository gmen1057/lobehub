import { describe, expect, it } from 'vitest';

import { findActiveTurnStartIndex, hasCompressibleHistory } from './activeTurn';

describe('activeTurn synthetic repair prompt handling', () => {
  it('anchors Turn 1 on the original user prompt and reports no compressible history when code-artifact repair prompt is appended', () => {
    const turn1Messages = [
      { content: 'Напиши модуль Module1.bas', role: 'user' },
      {
        content: 'Вот модуль:\n[omitted invalid empty file reference tag]',
        metadata: { internalRepairAttempt: true },
        role: 'assistant',
      },
      {
        content:
          'Model emitted an invalid empty <lobeArtifact> reference\n\nВ твоём предыдущем ответе вместо реального кода оказался пустой служебный тег ссылки на файл (/chat/code-artifact/...). Повтори ответ целиком.',
        role: 'user',
      },
    ];

    expect(findActiveTurnStartIndex(turn1Messages)).toBe(0);
    expect(hasCompressibleHistory(turn1Messages)).toBe(false);
  });

  it('still detects compressible prior history on Turn 2+ during a code-artifact repair pass', () => {
    const turn2Messages = [
      { content: 'Turn 1 request', role: 'user' },
      { content: 'Turn 1 answer', role: 'assistant' },
      { content: 'Turn 2 request', role: 'user' },
      {
        content: '[omitted invalid empty file reference tag]',
        metadata: { internalRepairAttempt: true },
        role: 'assistant',
      },
      {
        content:
          'Model emitted an invalid empty <lobeArtifact> reference\n\nВ твоём предыдущем ответе вместо реального кода оказался пустой служебный тег ссылки на файл (/chat/code-artifact/...).',
        role: 'user',
      },
    ];

    expect(findActiveTurnStartIndex(turn2Messages)).toBe(2);
    expect(hasCompressibleHistory(turn2Messages)).toBe(true);
  });
});
