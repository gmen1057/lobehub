import { systemPrompt as activatorPrompt } from '@lobechat/builtin-tool-activator';
import { systemPrompt as sitesPrompt } from '@lobechat/builtin-tool-arckep-sites';
import { DEFAULT_AGENT_CONFIG } from '@lobechat/const';
import { describe, expect, it } from 'vitest';

// arckep (решение владельца 19.10.2026): цену картинки показывает карточка результата, отдельный шаг
// «узнать цену» не обязателен. Правило одно на три постоянных промпта: активатор, помощник по
// умолчанию и «Мои сайты». Устаревшие arckep-studio / createImage / estimateImage там не живут.

const prompts: Array<[string, string]> = [
  ['активатор', activatorPrompt],
  ['помощник по умолчанию', DEFAULT_AGENT_CONFIG.systemRole ?? ''],
  ['Мои сайты', sitesPrompt],
];

describe.each(prompts)('правило картинок — %s', (_name, prompt) => {
  it('рисует подключение mcp-arckep-studio-images, create_image сразу', () => {
    expect(prompt).toContain('mcp-arckep-studio-images');
    expect(prompt).toContain('create_image');
  });

  it('estimate_image — только в названных случаях, дороже 20 ₽ — подтверждение', () => {
    expect(prompt).toContain('estimate_image');
    expect(prompt).toContain('20 ₽');
    expect(prompt).not.toMatch(/estimate_image\s*(→|->)\s*create_image/);
  });

  it('не отсылает к устаревшей «Студии» arckep-studio и её createImage / estimateImage', () => {
    expect(prompt).not.toMatch(/arckep-studio(?!-)/);
    expect(prompt).not.toContain('createImage');
    expect(prompt).not.toContain('estimateImage');
  });
});

describe('предупреждение про Nano Banana сохранено', () => {
  it('в «Мои сайты» и в помощнике по умолчанию', () => {
    expect(sitesPrompt).toContain('Nano Banana');
    expect(DEFAULT_AGENT_CONFIG.systemRole).toContain('Nano Banana');
  });
});
