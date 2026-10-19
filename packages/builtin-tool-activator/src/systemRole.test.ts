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

// решение владельца 19.10.2026: оценка цены и подтверждение — только у видео; всё остальное — сразу create_*
describe.each([
  ['full', systemPrompt],
  ['headless', systemPromptHeadless],
])('activator prompt (%s) — price rules', (_name, prompt) => {
  it('draws pictures with mcp-arckep-studio-images: create_image right away, no estimate', () => {
    expect(prompt).toContain('mcp-arckep-studio-images');
    expect(prompt).toContain('`create_*` right away');
    expect(prompt).toContain('default model');
    expect(prompt).toContain('no estimate, no confirmation');
    expect(prompt).toContain('`create_image` right away, no estimate');
    expect(prompt).toContain('(with its price)');
  });

  it('estimate_* for pictures, 3D, speech and decks only when the user asks the price', () => {
    expect(prompt).toContain('Pictures, 3D, speech, decks');
    expect(prompt).toContain('`estimate_*` only if the user asks the price');
  });

  it('video and Higgsfield are the only exception: estimate first, above 20 ₽ confirm', () => {
    expect(prompt).toContain('is the only exception');
    expect(prompt).toContain('mcp-arckep-studio-video');
    expect(prompt).toContain('mcp-arckep-studio-higgsfield');
    expect(prompt).toContain('`estimate_video`');
    expect(prompt).toContain('above 20 ₽ ask for confirmation');
  });

  it('has no picture-specific estimate conditions, no estimate chain and no legacy arckep-studio', () => {
    expect(prompt).not.toContain('estimate_image');
    expect(prompt).not.toContain('named a specific model');
    expect(prompt).not.toContain('several pictures');
    expect(prompt).not.toContain('best quality');
    expect(prompt).not.toMatch(/estimate_\w+\)?\s*(→|->)\s*create_/);
    expect(prompt).not.toMatch(/arckep-studio(?!-)/);
    expect(prompt).not.toContain('createImage');
    expect(prompt).not.toContain('estimateImage');
  });
});
