import { describe, expect, it } from 'vitest';

import { mergeChatConfig, normalizeChatConfig } from '../chatConfig';

describe('normalizeChatConfig (arckep: searchMode из REST)', () => {
  it('пустое остаётся пустым', () => {
    expect(normalizeChatConfig(null)).toBeNull();
    expect(normalizeChatConfig(undefined)).toBeUndefined();
  });

  it('старые слова REST переводятся в слова движка', () => {
    expect(normalizeChatConfig({ searchMode: 'disabled' })).toEqual({ searchMode: 'off' });
    expect(normalizeChatConfig({ searchMode: 'enabled' })).toEqual({ searchMode: 'on' });
  });

  it('слова движка и прочие поля не трогаются', () => {
    const cfg = { enableReasoning: true, searchMode: 'auto' };
    expect(normalizeChatConfig(cfg)).toBe(cfg);
    expect(normalizeChatConfig({ historyCount: 8 })).toEqual({ historyCount: 8 });
  });
});

describe('mergeChatConfig (arckep: PATCH поверх сохранённого)', () => {
  it('частичная правка не стирает остальные поля', () => {
    expect(
      mergeChatConfig({ historyCount: 8, searchMode: 'on' }, { searchMode: 'disabled' }),
    ).toEqual({ historyCount: 8, searchMode: 'off' });
  });

  it('явный null сбрасывает настройки целиком', () => {
    expect(mergeChatConfig({ historyCount: 8 }, null)).toBeNull();
  });

  it('без сохранённых настроек берётся правка', () => {
    expect(mergeChatConfig(undefined, { searchMode: 'enabled' })).toEqual({ searchMode: 'on' });
  });
});
