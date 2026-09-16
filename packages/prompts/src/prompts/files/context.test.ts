import { describe, expect, it } from 'vitest';

import { promptFileContents } from '../knowledgeBaseQA/formatFileContents';
import { fileReferences, readFilePage } from './context';
import { filePrompts } from './file';
import { promptAgentKnowledge } from './knowledgeBase';

describe('reversible file context', () => {
  const source =
    'BEGIN:VCARD\nFN:Обычный контакт\nEND:VCARD\n'.repeat(35_000) +
    'BEGIN:VCARD\nFN:Иванов Редкий\nTEL:+70000000000\nEND:VCARD';
  const file = {
    id: 'vcf-1',
    name: 'contacts.vcf',
    fileType: 'text/vcard',
    size: source.length,
    content: source,
    url: '/source',
  };

  it('does not inject a million-character VCF, while retaining its source ID', () => {
    const prompt = filePrompts([file], true);
    expect(prompt.length).toBeLessThan(10_000);
    expect(prompt).toContain('vcf-1');
    expect(prompt).toContain('readKnowledge');
    expect(file.content).toBe(source);
  });

  it('can retrieve a relevant record at EOF without embeddings', () => {
    const result = promptFileContents([{ content: source, fileId: file.id, filename: file.name }], {
      query: 'иванов редкий',
    });
    expect(result).toContain('+70000000000');
    expect(result).toContain('"complete":false');
    expect(result.length).toBeLessThan(22_000);
  });

  it('reconstructs the entire original, including surrogate pairs, without gaps or duplication', () => {
    const original = ('a'.repeat(19999) + '😀').repeat(4) + 'END';
    let offset = 0;
    let recovered = '';
    for (let count = 0; count < 10; count++) {
      const page = readFilePage(original, { offset });
      expect(page.startOffset).toBe(offset);
      recovered += page.content;
      if (page.nextOffset === null) break;
      expect(page.nextOffset).toBeGreaterThan(offset);
      offset = page.nextOffset;
    }
    expect(recovered).toBe(original);
  });

  it('searches literal punctuation rather than executing a regex', () => {
    const page = readFilePage('prefix ' + 'x'.repeat(30_000) + '[a+b](c)', { query: '[a+b](c)' });
    expect(page.content).toContain('[a+b](c)');
    expect(page.complete).toBe(false);
  });

  it('does not represent no literal match as full-source evidence', () => {
    const page = readFilePage(source, { query: 'not present' });
    expect(page.content).toBe('');
    expect(page.complete).toBe(false);
    expect(page.nextOffset).toBeNull();
  });

  it('limits total injected file text, not just individual files', () => {
    const files = Array.from({ length: 10 }, (_, i) => ({ ...file, id: `file-${i}` }));
    expect(filePrompts(files, false).length).toBeLessThan(42_000);
    const knowledge = promptAgentKnowledge({
      fileContents: files.map((item) => ({
        fileId: item.id,
        filename: item.name,
        content: source,
      })),
    });
    expect(knowledge.length).toBeLessThan(42_000);
    for (const item of files) expect(knowledge).toContain(item.id);
  });

  it('bounds a multi-file read while retaining independent continuation cursors', () => {
    const result = promptFileContents(
      Array.from({ length: 8 }, (_, i) => ({
        fileId: String(i),
        filename: file.name,
        content: source,
      })),
    );
    expect(result.length).toBeLessThan(26_000);
    expect(result.match(/nextOffset/g)).toHaveLength(24);
  });

  it('retains original file references through nested compression without file contents', () => {
    const refs = fileReferences([
      {
        compressedMessages: [{ fileList: [file] }, { compressedMessages: [{ fileList: [file] }] }],
      },
    ]);
    expect(refs).toContain('vcf-1');
    expect(refs).not.toContain('BEGIN:VCARD');
    expect(refs.match(/vcf-1/g)).toHaveLength(1);
  });
});
