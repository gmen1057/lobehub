import { describe, expect, it } from 'vitest';

import {
  classifySavedCodeArtifactNotePrefix,
  isSavedCodeArtifactNote,
  messageContentContainsMarker,
  rewriteMessageContentCodeArtifactTags,
  rewriteSavedCodeArtifactTagsForLLM,
  rewriteStoredMessageContentForLLM,
  SAVED_CODE_ARTIFACT_NOTE_RE,
} from '../codeArtifactTags';

const FILE_ID = '849f7fc2-dd0e-4b18-9aa8-aab327c49b30';

describe('rewriteSavedCodeArtifactTagsForLLM', () => {
  it('rewrites server-generated bodyless code-artifact tags to deterministic plain-text notes', () => {
    const input = `Вот модуль:\n\n<lobeArtifact type="application/lobe.artifacts.code" identifier="code-vb-abc123" title="Module1.bas" language="vb" src="/chat/code-artifact/${FILE_ID}/"></lobeArtifact>\n\nГотово.`;

    const expected = `Вот модуль:\n\n[Saved "Module1.bas" (vb), fileId=${FILE_ID} — previous code block stored by server. Use getTopicContext(mode="code_artifacts", fileId="${FILE_ID}") if you need to inspect it.]\n\nГотово.`;

    const first = rewriteSavedCodeArtifactTagsForLLM(input);
    const second = rewriteSavedCodeArtifactTagsForLLM(input);

    expect(first).toBe(expected);
    expect(second).toBe(first);
    expect(first).not.toContain('<lobeArtifact');
    expect(first).not.toContain('/chat/code-artifact/');
  });

  it('handles self-closing tags, single-quoted attributes, case-insensitive tag names, and no trailing slash', () => {
    const input = `<LOBEARTIFACT src='/chat/code-artifact/${FILE_ID}' language='python' title='script.py' type='application/lobe.artifacts.code' />`;

    expect(rewriteSavedCodeArtifactTagsForLLM(input)).toBe(
      `[Saved "script.py" (python), fileId=${FILE_ID} — previous code block stored by server. Use getTopicContext(mode="code_artifacts", fileId="${FILE_ID}") if you need to inspect it.]`,
    );
  });

  it('handles whitespace-only body as bodyless', () => {
    const input = `<lobeArtifact type="application/lobe.artifacts.code" title="a.ts" language="typescript" src="/chat/code-artifact/${FILE_ID}/">\n   \t\n</lobeArtifact>`;

    expect(rewriteSavedCodeArtifactTagsForLLM(input)).toBe(
      `[Saved "a.ts" (typescript), fileId=${FILE_ID} — previous code block stored by server. Use getTopicContext(mode="code_artifacts", fileId="${FILE_ID}") if you need to inspect it.]`,
    );
  });

  it('decodes XML entities in attributes including escaped quotes', () => {
    const input = `<lobeArtifact type="application/lobe.artifacts.code" title="A &quot;B&quot; &amp; &#39;C&#39; &lt;1&gt;.bas" language="vb" src="/chat/code-artifact/${FILE_ID}/"></lobeArtifact>`;

    expect(rewriteSavedCodeArtifactTagsForLLM(input)).toBe(
      `[Saved "A "B" & 'C' <1>.bas" (vb), fileId=${FILE_ID} — previous code block stored by server. Use getTopicContext(mode="code_artifacts", fileId="${FILE_ID}") if you need to inspect it.]`,
    );
  });

  it('handles missing title, language, or fileId gracefully', () => {
    const noTitleOrLang = `<lobeArtifact src="/chat/code-artifact/${FILE_ID}/"></lobeArtifact>`;
    expect(rewriteSavedCodeArtifactTagsForLLM(noTitleOrLang)).toBe(
      `[Saved code file, fileId=${FILE_ID} — previous code block stored by server. Use getTopicContext(mode="code_artifacts", fileId="${FILE_ID}") if you need to inspect it.]`,
    );

    const noFileId = `<lobeArtifact title="empty.py" src="/chat/code-artifact/"></lobeArtifact>`;
    expect(rewriteSavedCodeArtifactTagsForLLM(noFileId)).toBe(
      `[Saved "empty.py" — previous code block stored by server.]`,
    );
  });

  it('leaves HTML artifacts (/chat/f/) and text/html tags untouched', () => {
    const htmlTag =
      '<lobeArtifact identifier="calc" type="text/html" title="Калькулятор" src="/chat/f/file_123/"></lobeArtifact>';
    expect(rewriteSavedCodeArtifactTagsForLLM(htmlTag)).toBe(htmlTag);

    const htmlWithCodePath = `<lobeArtifact identifier="calc" type="text/html" title="Калькулятор" src="/chat/code-artifact/${FILE_ID}/"></lobeArtifact>`;
    expect(rewriteSavedCodeArtifactTagsForLLM(htmlWithCodePath)).toBe(htmlWithCodePath);
  });

  it('preserves non-empty inline code bodies and strips only the src attribute from the opening tag', () => {
    const input = `<lobeArtifact type="application/lobe.artifacts.code" title="x.bas" src="/chat/code-artifact/${FILE_ID}/">Sub Main()\n  MsgBox "Hi"\nEnd Sub</lobeArtifact>`;

    const result = rewriteSavedCodeArtifactTagsForLLM(input);
    expect(result).toBe(
      '<lobeArtifact type="application/lobe.artifacts.code" title="x.bas">Sub Main()\n  MsgBox "Hi"\nEnd Sub</lobeArtifact>',
    );
    expect(result).not.toContain('/chat/code-artifact/');
  });

  it('rewrites multiple tags in one message without swallowing text between them', () => {
    const id2 = '11111111-2222-3333-4444-555555555555';
    const input = [
      'Part 1:',
      `<lobeArtifact type="application/lobe.artifacts.code" title="Part1.bas" language="vb" src="/chat/code-artifact/${FILE_ID}/" />`,
      'Middle note.',
      `<lobeArtifact type="application/lobe.artifacts.code" title="Part2.bas" language="vb" src="/chat/code-artifact/${id2}/"></lobeArtifact>`,
    ].join('\n');

    const result = rewriteSavedCodeArtifactTagsForLLM(input);
    expect(result).toContain(`fileId=${FILE_ID}`);
    expect(result).toContain('Middle note.');
    expect(result).toContain(`fileId=${id2}`);
    expect(result).not.toContain('<lobeArtifact');
  });

  it('returns plain text without /chat/code-artifact/ unchanged via fast path', () => {
    const text = 'Plain assistant message without tags.';
    expect(rewriteSavedCodeArtifactTagsForLLM(text)).toBe(text);
  });
});

describe('rewriteMessageContentCodeArtifactTags', () => {
  it('rewrites string content and multimodal text parts while preserving identity when unchanged', () => {
    const tag = `<lobeArtifact type="application/lobe.artifacts.code" title="m.py" language="python" src="/chat/code-artifact/${FILE_ID}/"></lobeArtifact>`;
    expect(rewriteMessageContentCodeArtifactTags(tag)).toContain(`fileId=${FILE_ID}`);

    const unchangedParts = [
      { text: 'Just text', type: 'text' },
      { image_url: { url: 'https://example.com/a.png' }, type: 'image_url' },
    ];
    expect(rewriteMessageContentCodeArtifactTags(unchangedParts)).toBe(unchangedParts);

    const imagePart = { image_url: { url: 'https://example.com/a.png' }, type: 'image_url' };
    const mixedParts = [{ text: `Code:\n${tag}`, type: 'text' }, imagePart];
    const rewritten = rewriteMessageContentCodeArtifactTags(mixedParts) as any[];
    expect(rewritten).not.toBe(mixedParts);
    expect(rewritten[0].text).not.toContain('/chat/code-artifact/');
    expect(rewritten[0].text).toContain(`fileId=${FILE_ID}`);
    expect(rewritten[1]).toBe(imagePart);

    expect(rewriteMessageContentCodeArtifactTags(null)).toBeNull();
    expect(rewriteMessageContentCodeArtifactTags(undefined)).toBeUndefined();
  });
});

describe('H1 linear scanner edge cases & serialized multimodal JSON', () => {
  it('handles backslash-escaped attribute quotes in paired and self-closing tags', () => {
    const escapedPaired = `<lobeArtifact type=\\"application/lobe.artifacts.code\\" title=\\"Mod1.bas\\" language=\\"vb\\" src=\\"/chat/code-artifact/${FILE_ID}/\\"></lobeArtifact>`;
    expect(rewriteSavedCodeArtifactTagsForLLM(escapedPaired)).toBe(
      `[Saved "Mod1.bas" (vb), fileId=${FILE_ID} — previous code block stored by server. Use getTopicContext(mode="code_artifacts", fileId="${FILE_ID}") if you need to inspect it.]`,
    );

    const escapedInline = `<lobeArtifact type=\\"application/lobe.artifacts.code\\" title=\\"Mod1.bas\\" src=\\"/chat/code-artifact/${FILE_ID}/\\">Sub Main()\nEnd Sub</lobeArtifact>`;
    const rewrittenInline = rewriteSavedCodeArtifactTagsForLLM(escapedInline);
    expect(rewrittenInline).toContain('Sub Main()\nEnd Sub');
    expect(rewrittenInline).not.toContain('/chat/code-artifact/');
  });

  it('rewrites unclosed code-artifact tags at EOF and never swallows across a following <lobeArtifact>', () => {
    const id2 = '11111111-2222-3333-4444-555555555555';

    // Unclosed empty tag at EOF
    const unclosedEmptyEof = `Вот файл:\n<lobeArtifact type="application/lobe.artifacts.code" title="A.bas" language="vb" src="/chat/code-artifact/${FILE_ID}/">   \n`;
    expect(rewriteSavedCodeArtifactTagsForLLM(unclosedEmptyEof)).toBe(
      `Вот файл:\n[Saved "A.bas" (vb), fileId=${FILE_ID} — previous code block stored by server. Use getTopicContext(mode="code_artifacts", fileId="${FILE_ID}") if you need to inspect it.]`,
    );

    // Unclosed tag with inline body at EOF: keeps body, strips only src
    const unclosedBodyEof = `<lobeArtifact type="application/lobe.artifacts.code" title="A.bas" src="/chat/code-artifact/${FILE_ID}/">Sub Main()\nEnd Sub`;
    const rewrittenBodyEof = rewriteSavedCodeArtifactTagsForLLM(unclosedBodyEof);
    expect(rewrittenBodyEof).toBe(
      '<lobeArtifact type="application/lobe.artifacts.code" title="A.bas">Sub Main()\nEnd Sub',
    );
    expect(rewrittenBodyEof).not.toContain('/chat/code-artifact/');

    // Unclosed tag followed by a second tag: neither is swallowed
    const unclosedThenClosed = `<lobeArtifact type="application/lobe.artifacts.code" title="A.bas" language="vb" src="/chat/code-artifact/${FILE_ID}/">\n<lobeArtifact type="application/lobe.artifacts.code" title="B.bas" language="vb" src="/chat/code-artifact/${id2}/"></lobeArtifact>`;
    const rewrittenBoth = rewriteSavedCodeArtifactTagsForLLM(unclosedThenClosed);
    expect(rewrittenBoth).toContain(`"A.bas" (vb), fileId=${FILE_ID}`);
    expect(rewrittenBoth).toContain(`"B.bas" (vb), fileId=${id2}`);
    expect(rewrittenBoth).not.toContain('<lobeArtifact');
    expect(rewrittenBoth).not.toContain('/chat/code-artifact/');

    // Truncated opening tag without '>' at EOF
    const truncatedOpen = `Before <lobeArtifact type="application/lobe.artifacts.code" title="Cut.bas" src="/chat/code-artifact/${FILE_ID}/"`;
    expect(rewriteSavedCodeArtifactTagsForLLM(truncatedOpen)).toBe(
      `Before [Saved "Cut.bas", fileId=${FILE_ID} — previous code block stored by server. Use getTopicContext(mode="code_artifacts", fileId="${FILE_ID}") if you need to inspect it.]`,
    );
  });

  it('completes in linear O(n) time (< 50 ms) on 38 KB adversarial repeated unclosed tags', () => {
    const adversarial1 = '<lobeArtifact a="1" '.repeat(2000) + `/chat/code-artifact/${FILE_ID}/`;
    const adversarial2 = '<lobeArtifact a="1">'.repeat(2000) + `/chat/code-artifact/${FILE_ID}/`;

    const start = performance.now();
    expect(rewriteSavedCodeArtifactTagsForLLM(adversarial1)).toBe(adversarial1);
    expect(rewriteSavedCodeArtifactTagsForLLM(adversarial2)).toBe(adversarial2);
    const elapsedMs = performance.now() - start;

    expect(elapsedMs).toBeLessThan(50);
  });

  it('rewrites serialized multimodal DB JSON strings in rewriteStoredMessageContentForLLM', () => {
    const rawTag = `<lobeArtifact type="application/lobe.artifacts.code" identifier="code-vb-1" title="Mod1.bas" language="vb" src="/chat/code-artifact/${FILE_ID}/"></lobeArtifact>`;
    const serialized = JSON.stringify([
      { text: `Part 1:\n${rawTag}`, type: 'text' },
      { image: 'https://example.com/chart.png', type: 'image' },
    ]);

    const rewritten = rewriteStoredMessageContentForLLM(serialized);
    expect(typeof rewritten).toBe('string');
    expect(rewritten as string).not.toContain('/chat/code-artifact/');
    expect(rewritten as string).not.toContain('<lobeArtifact');

    const parsed = JSON.parse(rewritten as string);
    expect(parsed).toEqual([
      {
        text: `Part 1:\n[Saved "Mod1.bas" (vb), fileId=${FILE_ID} — previous code block stored by server. Use getTopicContext(mode="code_artifacts", fileId="${FILE_ID}") if you need to inspect it.]`,
        type: 'text',
      },
      { image: 'https://example.com/chart.png', type: 'image' },
    ]);

    // Plain non-JSON string starting with '[' falls through cleanly
    const plainBracket = `[Note] ${rawTag}`;
    expect(rewriteStoredMessageContentForLLM(plainBracket)).toBe(
      `[Note] [Saved "Mod1.bas" (vb), fileId=${FILE_ID} — previous code block stored by server. Use getTopicContext(mode="code_artifacts", fileId="${FILE_ID}") if you need to inspect it.]`,
    );
  });
});

describe('SAVED_CODE_ARTIFACT_NOTE_RE & classifySavedCodeArtifactNotePrefix', () => {
  const validVariants = [
    `[Saved "Module1.bas" (vb), fileId=${FILE_ID} — previous code block stored by server. Use getTopicContext(mode="code_artifacts", fileId="${FILE_ID}") if you need to inspect it.]`,
    `[Saved code file, fileId=${FILE_ID} — previous code block stored by server. Use getTopicContext(mode="code_artifacts", fileId="${FILE_ID}") if you need to inspect it.]`,
    `[Saved "empty.py" — previous code block stored by server.]`,
    `[Saved "C# helper.cs" (c#), fileId=abc_123-XYZ — previous code block stored by server.]`,
    `[Saved "${'a'.repeat(260)}" (${'x'.repeat(40)}), fileId=${'f'.repeat(80)} — previous code block stored by server. Use getTopicContext(mode="code_artifacts", fileId="${'f'.repeat(80)}") if you need to inspect it.]`,
  ];

  it('matches all canonical server-generated saved-note variants and classifies prefixes incrementally', () => {
    for (const note of validVariants) {
      expect(SAVED_CODE_ARTIFACT_NOTE_RE.test(note)).toBe(true);
      expect(isSavedCodeArtifactNote(note)).toBe(true);
      expect(classifySavedCodeArtifactNotePrefix(note)).toEqual({
        end: note.length,
        kind: 'match',
      });
      expect(classifySavedCodeArtifactNotePrefix(`${note} trailing`)).toEqual({
        end: note.length,
        kind: 'match',
      });

      // Every strict prefix must remain pending
      for (let len = 7; len < note.length; len += 1) {
        expect(classifySavedCodeArtifactNotePrefix(note.slice(0, len))).toEqual({
          kind: 'pending',
        });
      }
    }
  });

  it('rejects ordinary text and out-of-bounds fields immediately', () => {
    const nonNotes = [
      '[Saved changes]',
      '[Saved ch',
      '[Saved 3 files]',
      '[Saved "report" ok]',
      '[Saved "" — previous code block stored by server.]',
      `[Saved "${'a'.repeat(261)}" — previous code block stored by server.]`,
      `[Saved "a.ts" (${'x'.repeat(41)}) — previous code block stored by server.]`,
      `[Saved "a.ts", fileId=${'f'.repeat(81)} — previous code block stored by server.]`,
      '[Saved "a.ts"\n — previous code block stored by server.]',
      '[Saved "a.ts", fileId=abc]',
    ];

    for (const sample of nonNotes) {
      expect(isSavedCodeArtifactNote(sample)).toBe(false);
      expect(classifySavedCodeArtifactNotePrefix(sample)).toEqual({ kind: 'mismatch' });
    }
  });

  it('detects marker in plain string and multimodal content arrays', () => {
    expect(
      messageContentContainsMarker('Why does it say previous code block stored by server?'),
    ).toBe(true);
    expect(
      messageContentContainsMarker([
        { image_url: { url: 'https://example.com/1.png' }, type: 'image_url' },
        { text: 'Check previous code block stored by server please', type: 'text' },
      ]),
    ).toBe(true);
    expect(messageContentContainsMarker('Regular prompt asking for VBA code')).toBe(false);
    expect(messageContentContainsMarker(null)).toBe(false);
  });
});
