import { describe, expect, it } from 'vitest';

import { systemPrompt } from './systemRole';

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
