import { describe, expect, it } from 'vitest';

import { systemPrompt, systemPromptHeadless } from './systemRole';

describe('activator systemPrompt — attached file translation', () => {
  it('tells the model to write markdown, not shop the skill store', () => {
    expect(systemPrompt).toContain('<attached_file_translation>');
    expect(systemPrompt).toContain('TRANSLATE-ATTACHED-FIRST');
    expect(systemPrompt).toContain('Do **NOT** activate `lobe-skill-store`');
    expect(systemPrompt).toContain('createDocument');
    expect(systemPrompt).toContain('Never paste the full book into the chat');
  });

  it('does not treat attached-file translation as generating a PDF', () => {
    expect(systemPrompt).toContain('generating PDFs **from scratch**');
    expect(systemPrompt).toContain('**except** translating/localizing files they already attached');
    expect(systemPrompt).toContain('PDF only after the user wants an export');
  });
});

describe('activator systemPrompt — full variant keeps the skill store', () => {
  it('still has the skill store discovery rules and the marketplace advice', () => {
    expect(systemPrompt).toContain('<skill_store_discovery>');
    expect(systemPrompt).toContain('SKILL-FIRST');
    expect(systemPrompt).toContain('search the Skill Marketplace first');
    expect(systemPrompt).toContain('activate `lobe-skill-store`');
  });
});

// arckep (19.10.2026): в движке без интерфейса (ARCKEP_HEADLESS_TOOLS=1) магазина навыков нет
describe('activator systemPromptHeadless — no skill store', () => {
  it('has no skill store block, SKILL-FIRST, marketplace advice or lobe-skill-store mentions', () => {
    expect(systemPromptHeadless).not.toContain('<skill_store_discovery>');
    expect(systemPromptHeadless).not.toContain('SKILL-FIRST');
    expect(systemPromptHeadless).not.toContain('Skill Marketplace');
    expect(systemPromptHeadless).not.toContain('lobe-skill-store');
    expect(systemPromptHeadless).not.toContain('skill-store');
    expect(systemPromptHeadless).not.toContain('importFromMarket');
  });

  it('keeps attached-file translation, activateTools/activateSkill and the other rules', () => {
    expect(systemPromptHeadless).toContain('<attached_file_translation>');
    expect(systemPromptHeadless).toContain('TRANSLATE-ATTACHED-FIRST');
    expect(systemPromptHeadless).toContain('createDocument');
    expect(systemPromptHeadless).toContain('PDF only after the user wants an export');
    expect(systemPromptHeadless).toContain('**activateSkill**');
    expect(systemPromptHeadless).toContain('**activateTools**');
    expect(systemPromptHeadless).toContain('<credentials_management>');
    expect(systemPromptHeadless).toContain('CREDS-FIRST');
    expect(systemPromptHeadless).toContain('<on_demand_tools>');
    expect(systemPromptHeadless).toContain('<best_practices>');
  });

  it('is shorter than the full prompt and well-formed (every block closed)', () => {
    expect(systemPromptHeadless.length).toBeLessThan(systemPrompt.length);
    for (const tag of [
      'how_it_works',
      'tool_selection_guidelines',
      'attached_file_translation',
      'credentials_management',
      'on_demand_tools',
      'best_practices',
    ]) {
      expect(systemPromptHeadless).toContain(`<${tag}>`);
      expect(systemPromptHeadless).toContain(`</${tag}>`);
    }
  });
});

// решение владельца 19.10.2026: цену картинки показывает карточка результата
describe.each([
  ['full', systemPrompt],
  ['headless', systemPromptHeadless],
])('activator prompt (%s) — pictures', (_name, prompt) => {
  it('draws with mcp-arckep-studio-images: create_image right away, default model', () => {
    expect(prompt).toContain('mcp-arckep-studio-images');
    expect(prompt).toContain('call `create_image` right away');
    expect(prompt).toContain('default model');
    expect(prompt).toContain('result card');
  });

  it('asks estimate_image only for a named model, several pictures, 4K or the price; above 20 ₽ — confirm', () => {
    expect(prompt).toContain('`estimate_image` first only if');
    expect(prompt).toContain('named a specific model');
    expect(prompt).toContain('several pictures');
    expect(prompt).toContain('4K');
    expect(prompt).toContain('asks the price');
    expect(prompt).toContain('above 20 ₽, ask for confirmation');
  });

  it('has no mandatory estimate_image → create_image chain and no legacy arckep-studio', () => {
    expect(prompt).not.toMatch(/estimate_image\)?\s*(→|->)\s*create_image/);
    expect(prompt).not.toMatch(/arckep-studio(?!-)/);
    expect(prompt).not.toContain('createImage');
    expect(prompt).not.toContain('estimateImage');
  });
});
