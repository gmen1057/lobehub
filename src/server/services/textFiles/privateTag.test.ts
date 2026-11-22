import { describe, expect, it, vi } from 'vitest';

import { HtmlArtifactStreamGate } from '@/server/services/arckepLayout/htmlSyntax';

const id = '849f7fc2-dd0e-4b18-9aa8-aab327c49b30';
const open = `<lobeArtifact type="application/lobe.artifacts.code" identifier="doc" title="x.bas" src="/chat/code-artifact/${id}/"`;

describe('private tags in streamed model text', () => {
  it.each([false, true])(
    'always rejects model-emitted bodyless /chat/code-artifact/ tags even when trusted callback returns %s',
    async (trusted) => {
      for (const close of [' />', '></lobeArtifact>', '>\n   </lobeArtifact>']) {
        const tag = open + close;
        const check = vi.fn(async () => trusted);
        const gate = new HtmlArtifactStreamGate(check);
        let delivered = '';
        for (const char of 'Before ' + tag + ' after.') delivered += gate.push(char);
        expect(delivered).toBe('Before ');
        const result = await gate.finalize();
        expect(result.valid).toBe(false);
        expect(result.diagnostics).toEqual([]);
        expect(result.codeArtifactDiagnostics).toHaveLength(1);
        expect(result.codeArtifactDiagnostics[0]).toContain('x.bas');
        expect(result.codeArtifactDiagnostics[0]).toContain(`/chat/code-artifact/${id}/`);
        expect(result.finalContent).toBe('Before Файл не сохранён. after.');
        expect(delivered + result.postStreamDelta).toBe(result.finalContent);
        expect(result.sanitizedAttemptContent).toBe(
          'Before [omitted invalid empty file reference tag] after.',
        );
        expect(result.sanitizedAttemptContent).not.toContain('/chat/code-artifact/');
        expect(result.finalContent).not.toContain('/chat/code-artifact/');
      }
    },
  );

  it('suppresses premature fallback and trailing prose when suppressCodeArtifactFallback is true', async () => {
    const gate = new HtmlArtifactStreamGate();
    let delivered = '';
    for (const char of 'Before ' + open + '></lobeArtifact> after.') delivered += gate.push(char);
    expect(delivered).toBe('Before ');

    const result = await gate.finalize({ suppressCodeArtifactFallback: true });
    expect(result.valid).toBe(false);
    expect(result.codeArtifactDiagnostics).toHaveLength(1);
    expect(result.finalContent).toBe('Before ');
    expect(result.postStreamDelta).toBe('');
    expect(result.codeArtifactFallbackContent).toBe('Before Файл не сохранён. after.');
    expect(result.codeArtifactFallbackDelta).toBe('Файл не сохранён. after.');
    expect(result.sanitizedAttemptContent).toBe(
      'Before [omitted invalid empty file reference tag] after.',
    );
  });

  it('rejects unclosed /chat/code-artifact/ tags truncated at EOF', async () => {
    const gate = new HtmlArtifactStreamGate();
    const delivered = gate.push('Before ' + open);
    expect(delivered).toBe('Before ');

    const result = await gate.finalize();
    expect(result.valid).toBe(false);
    expect(result.codeArtifactDiagnostics).toHaveLength(1);
    expect(result.finalContent).toBe('Before Файл не сохранён.');
    expect(delivered + result.postStreamDelta).toBe(result.finalContent);
  });

  it('keeps inline source verbatim when the model attaches a bogus URL (even with suppressCodeArtifactFallback)', async () => {
    for (const suppressCodeArtifactFallback of [false, true]) {
      const gate = new HtmlArtifactStreamGate();
      const body = '>const x = 2;\r\n</lobeArtifact>';
      gate.push(open + body);
      const result = await gate.finalize({ suppressCodeArtifactFallback });
      expect(result.valid).toBe(true);
      expect(result.codeArtifactDiagnostics).toEqual([]);
      expect(result.diagnostics).toEqual([]);
      expect(result.finalContent).toBe(open.split(' src=')[0] + body);
      expect(result.postStreamDelta).toBe(result.finalContent);
    }
  });
});
