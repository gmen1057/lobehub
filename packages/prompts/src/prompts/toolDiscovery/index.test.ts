import { describe, expect, it } from 'vitest';

import {
  availableToolPrompt,
  availableToolsPrompts,
  TOOL_LIST_DESCRIPTION_LIMIT,
  truncateToolDescription,
} from './index';

describe('toolDiscovery prompts', () => {
  it('returns empty string for empty tools list', () => {
    expect(availableToolsPrompts([])).toBe('');
  });

  it('keeps short descriptions intact and collapses whitespace', () => {
    expect(truncateToolDescription('  Генерация   картинок\nи редактирование  ')).toBe(
      'Генерация картинок и редактирование',
    );
  });

  it('caps overly long MCP/third-party descriptions at word boundary', () => {
    const longDesc =
      'Делает видео по тексту или картинке, удаляет и меняет фон у видео (Alpha-Gen), управляет 3D-камерой и светом (MiniMax, LightX): оценка цены, запуск, статус. Сначала нужный estimate_* и цена; дороже 20 ₽ — подтверждение; готовый ролик появляется в чате карточкой. Модели higgsfield-* — в «Студия: Higgsfield».';
    const truncated = truncateToolDescription(longDesc);

    expect(truncated.length).toBeLessThanOrEqual(TOOL_LIST_DESCRIPTION_LIMIT + 1);
    expect(truncated.endsWith('…')).toBe(true);
    expect(truncated).toContain('Alpha-Gen');
    expect(truncated).toContain('MiniMax');
    expect(truncated).not.toContain('higgsfield-*');
  });

  it('formats <available_tools> block with truncated tool descriptions', () => {
    const out = availableToolsPrompts([
      {
        description: 'Вычисление математических выражений',
        identifier: 'lobe-calculator',
        name: 'Калькулятор',
      },
    ]);

    expect(out).toContain('<available_tools description=');
    expect(out).toContain(
      availableToolPrompt({
        description: 'Вычисление математических выражений',
        identifier: 'lobe-calculator',
        name: 'Калькулятор',
      }),
    );
    expect(out).toContain('</available_tools>');
  });
});
