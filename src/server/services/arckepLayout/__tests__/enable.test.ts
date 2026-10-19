import { afterEach, describe, expect, it } from 'vitest';

import { isLayoutCheckEnabled, needsLayoutTool } from '../enable';

// arckep (19.10.2026): когда в ход включается инструмент arckep-layout — в теме есть PDF или HTML-артефакт.

const artifact =
  '<lobeArtifact identifier="mail" type="text/html" title="Письмо"><p>x</p></lobeArtifact>';

describe('включение arckep-layout в ход', () => {
  afterEach(() => {
    delete process.env.ARCKEP_LAYOUT_CHECK;
  });

  it('PDF в текущем сообщении (по mime или по имени)', () => {
    expect(
      needsLayoutTool({ files: [{ mimeType: 'application/pdf', name: 'a' }], history: [] }),
    ).toBe(true);
    expect(needsLayoutTool({ files: [{ name: 'макет.PDF' }], history: [] })).toBe(true);
  });

  it('PDF в сообщении человека из истории темы', () => {
    expect(
      needsLayoutTool({
        history: [{ fileList: [{ fileType: 'application/pdf', name: 'new.pdf' }], role: 'user' }],
      }),
    ).toBe(true);
  });

  it('HTML-артефакт в прежнем ответе помощника', () => {
    expect(needsLayoutTool({ history: [{ content: `Вот: ${artifact}`, role: 'assistant' }] })).toBe(
      true,
    );
  });

  it('нет ни PDF, ни HTML-артефакта — не включается: картинки, SVG, обычный текст и pdf-подобные имена', () => {
    expect(
      needsLayoutTool({
        files: [{ mimeType: 'image/png', name: 'a.png' }],
        history: [
          { content: 'привет', role: 'assistant' },
          {
            content: '<lobeArtifact identifier="s" type="image/svg+xml"><svg/></lobeArtifact>',
            role: 'assistant',
          },
          { fileList: [{ fileType: 'text/plain', name: 'pdf.txt' }], role: 'user' },
          { content: artifact, role: 'user' },
          { content: artifact, role: 'tool' },
        ],
      }),
    ).toBe(false);
    expect(needsLayoutTool({ history: [] })).toBe(false);
  });

  it('выключатель ARCKEP_LAYOUT_CHECK=0', () => {
    expect(isLayoutCheckEnabled()).toBe(true);
    process.env.ARCKEP_LAYOUT_CHECK = '0';
    expect(isLayoutCheckEnabled()).toBe(false);
    process.env.ARCKEP_LAYOUT_CHECK = '1';
    expect(isLayoutCheckEnabled()).toBe(true);
  });
});
