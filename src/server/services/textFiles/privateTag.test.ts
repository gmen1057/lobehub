import { describe, expect, it, vi } from 'vitest';

import { HtmlArtifactStreamGate } from '@/server/services/arckepLayout/htmlSyntax';

const id = '849f7fc2-dd0e-4b18-9aa8-aab327c49b30';
const open = `<lobeArtifact type="application/lobe.artifacts.code" identifier="doc" title="x.bas" src="/chat/code-artifact/${id}/"`;
describe('private tags in streamed model text', () => {
  it.each([false, true])(
    'validates a private id before both SSE delivery and persistence (trusted=%s)',
    async (trusted) => {
      for (const close of [' />', '></lobeArtifact>']) {
        const tag = open + close;
        const check = vi.fn(async () => trusted);
        const gate = new HtmlArtifactStreamGate(check);
        let delivered = '';
        for (const char of 'Before ' + tag + ' after.') delivered += gate.push(char);
        expect(delivered).toBe('Before ');
        const { finalContent, postStreamDelta } = await gate.finalize();
        expect(check).toHaveBeenCalledWith(id);
        expect(finalContent).toBe('Before ' + (trusted ? tag : 'Файл не сохранён.') + ' after.');
        expect(delivered + postStreamDelta).toBe(finalContent);
      }
    },
  );
  it('keeps inline source verbatim when the model attaches a bogus URL', async () => {
    const gate = new HtmlArtifactStreamGate();
    const body = '>const x = 2;\r\n</lobeArtifact>';
    gate.push(open + body);
    const { finalContent, postStreamDelta } = await gate.finalize();
    expect(finalContent).toBe(open.split(' src=')[0] + body);
    expect(postStreamDelta).toBe(finalContent);
  });
});
