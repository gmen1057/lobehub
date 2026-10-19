import { systemPrompt as activatorPrompt } from '@lobechat/builtin-tool-activator';
import { systemPrompt as sitesPrompt } from '@lobechat/builtin-tool-arckep-sites';
import { DEFAULT_AGENT_CONFIG } from '@lobechat/const';
import { describe, expect, it } from 'vitest';

// arckep (решение владельца 19.10.2026): оценка цены и подтверждение — только у видео. Картинки, 3D,
// озвучка и презентации — сразу create_*, цену готового результата показывает его карточка. Правило
// одно на три постоянных промпта: активатор, помощник по умолчанию и «Мои сайты». Устаревшие
// arckep-studio / createImage / estimateImage там не живут.

const prompts: Array<[string, string]> = [
  ['активатор', activatorPrompt],
  ['помощник по умолчанию', DEFAULT_AGENT_CONFIG.systemRole ?? ''],
  ['Мои сайты', sitesPrompt],
];

describe.each(prompts)('правило картинок — %s', (_name, prompt) => {
  it('рисует подключение mcp-arckep-studio-images, create_* сразу', () => {
    expect(prompt).toContain('mcp-arckep-studio-images');
    expect(prompt).toMatch(/create_image|create_\*/);
  });

  it('без оценки и подтверждения: условий «модель / несколько / 4K / лучшее качество» нет', () => {
    expect(prompt).not.toMatch(/named a specific model|several pictures|best quality/);
    expect(prompt).not.toMatch(/конкретную модель|несколько картинок|лучшее качество/);
    expect(prompt).not.toMatch(/estimate_image\s*(→|->)\s*create_image/);
    expect(prompt).not.toMatch(/estimate_image[^.]*(above|дороже) 20/);
  });

  it('не отсылает к устаревшей «Студии» arckep-studio и её createImage / estimateImage', () => {
    expect(prompt).not.toMatch(/arckep-studio(?!-)/);
    expect(prompt).not.toContain('createImage');
    expect(prompt).not.toContain('estimateImage');
  });
});

describe.each([
  ['активатор', activatorPrompt],
  ['помощник по умолчанию', DEFAULT_AGENT_CONFIG.systemRole ?? ''],
])('оценка цены и подтверждение — только видео — %s', (_name, prompt) => {
  it('видео и Higgsfield: estimate_* первым, дороже 20 ₽ — подтверждение', () => {
    expect(prompt).toContain('mcp-arckep-studio-video');
    expect(prompt).toMatch(/higgsfield/i);
    expect(prompt).toContain('estimate_');
    expect(prompt).toContain('20 ₽');
  });

  it('для остального estimate_* только по вопросу о цене', () => {
    expect(prompt).toMatch(/estimate_\*[^.]*(asks the price|спрашивает цену)/);
  });
});

describe('«Мои сайты» не требует оценки для картинок', () => {
  it('estimate_image — только если человек сам спрашивает цену, 20 ₽ не упоминается', () => {
    expect(sitesPrompt).toContain('no estimate, no confirmation');
    expect(sitesPrompt).toContain('estimate_image only if the user asks the price');
    expect(sitesPrompt).not.toContain('20 ₽');
  });
});

describe('предупреждение про Nano Banana сохранено', () => {
  it('в «Мои сайты» и в помощнике по умолчанию', () => {
    expect(sitesPrompt).toContain('Nano Banana');
    expect(DEFAULT_AGENT_CONFIG.systemRole).toContain('Nano Banana');
  });
});
