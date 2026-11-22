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

  it('returns totalMatches and up to 50 line/offset/preview entries for query searches', () => {
    const lines = Array.from(
      { length: 75 },
      (_, i) => `Sub Proc_${i + 1}() ' описание расчёта #${i + 1}`,
    );
    const doc = lines.join('\r\n') + '\r\n';
    const page = readFilePage(doc, { query: 'sub proc_' });

    expect(page.complete).toBe(false);
    expect(page.totalMatches).toBe(75);
    expect(page.matches).toHaveLength(50);
    expect(page.matches![0]).toEqual({
      line: 1,
      offset: 0,
      preview: "Sub Proc_1() ' описание расчёта #1",
    });
    expect(page.matches![1].line).toBe(2);
    expect(page.matches![1].offset).toBe(lines[0].length + 2);
    expect(page.matches![49].line).toBe(50);

    // Offset narrows match index to matches from offset onward while preserving true 1-based line numbers
    const fromLine60Offset = lines.slice(0, 59).reduce((acc, l) => acc + l.length + 2, 0);
    const tailPage = readFilePage(doc, { offset: fromLine60Offset, query: 'Sub Proc_' });
    expect(tailPage.totalMatches).toBe(16);
    expect(tailPage.matches).toHaveLength(16);
    expect(tailPage.matches![0].line).toBe(60);
    expect(tailPage.matches![0].offset).toBe(fromLine60Offset);
  });

  it('bounds long-line match previews to <= 160 chars centered around the match', () => {
    const longLine = 'a'.repeat(500) + 'TARGET_TOKEN' + 'b'.repeat(500);
    const page = readFilePage(longLine, { query: 'TARGET_TOKEN' });

    expect(page.totalMatches).toBe(1);
    expect(page.matches).toHaveLength(1);
    expect(page.matches![0].line).toBe(1);
    expect(page.matches![0].offset).toBe(500);
    expect(page.matches![0].preview).toContain('TARGET_TOKEN');
    expect(page.matches![0].preview.length).toBeLessThanOrEqual(160);
  });

  it('returns totalMatches=0 and empty matches array when literal query misses', () => {
    const page = readFilePage('alpha\nbeta\ngamma\n', { query: 'delta' });
    expect(page.totalMatches).toBe(0);
    expect(page.matches).toEqual([]);
    expect(page.content).toBe('');
    expect(page.nextOffset).toBeNull();
  });

  it('reads line-numbered pages with startLine/maxLines, clamping and exact cursors', () => {
    const lines = Array.from({ length: 620 }, (_, i) => `line_${i + 1}`);
    const crlfDoc = lines.join('\r\n') + '\r\n';

    // Default maxLines = 250
    const page1 = readFilePage(crlfDoc, { startLine: 1 });
    expect(page1.complete).toBe(false);
    expect(page1.startLine).toBe(1);
    expect(page1.endLine).toBe(250);
    expect(page1.nextStartLine).toBe(251);
    expect(page1.totalLines).toBe(620);
    expect(page1.lineEnding).toBe('CRLF');
    expect(page1.content.startsWith('L1: line_1\nL2: line_2')).toBe(true);
    expect(page1.content.endsWith('L250: line_250')).toBe(true);

    // Clamp maxLines above 500 -> 500
    const clampedHigh = readFilePage(crlfDoc, { maxLines: 9999, startLine: 1 });
    expect(clampedHigh.endLine).toBe(500);
    expect(clampedHigh.nextStartLine).toBe(501);

    // Clamp maxLines below 1 -> 1, startLine below 1 -> 1
    const clampedLow = readFilePage(crlfDoc, { maxLines: 0, startLine: -5 });
    expect(clampedLow.startLine).toBe(1);
    expect(clampedLow.endLine).toBe(1);
    expect(clampedLow.content).toBe('L1: line_1');

    // Final page
    const lastPage = readFilePage(crlfDoc, { maxLines: 200, startLine: 501 });
    expect(lastPage.startLine).toBe(501);
    expect(lastPage.endLine).toBe(620);
    expect(lastPage.nextStartLine).toBeNull();
    expect(lastPage.complete).toBe(false);

    // Small doc read completely in line mode
    const small = 'first\nsecond\n';
    const full = readFilePage(small, { startLine: 1 });
    expect(full.complete).toBe(true);
    expect(full.startLine).toBe(1);
    expect(full.endLine).toBe(2);
    expect(full.nextStartLine).toBeNull();
    expect(full.totalLines).toBe(2);
    expect(full.lineEnding).toBe('LF');
    expect(full.content).toBe('L1: first\nL2: second');
  });

  it('enforces the character limit in line mode and safely truncates giant minified lines without splitting surrogate pairs', () => {
    // 1) Multi-line file where character budget caps page before maxLines
    const wideLines = Array.from({ length: 100 }, (_, i) => `row_${i + 1}_` + 'x'.repeat(500)).join(
      '\n',
    );
    const bounded = readFilePage(wideLines, { maxLines: 100, startLine: 1 }, 2_000);
    expect(bounded.content.length).toBeLessThanOrEqual(2_000);
    expect(bounded.endLine).toBeGreaterThanOrEqual(1);
    expect(bounded.endLine).toBeLessThan(100);
    expect(bounded.nextStartLine).toBe(bounded.endLine! + 1);

    // 2) Single minified line > limit with surrogate pair right on the cut boundary
    const limit = 100;
    const prefixLen = 'L1: '.length;
    const totalLineLen = 2000;
    const suffixLen = `… [truncated: ${totalLineLen} chars]`.length;
    const available = limit - prefixLen - suffixLen;
    // Place emoji so its high surrogate lands exactly at available - 1
    const minified = 'a'.repeat(available - 1) + '😀' + 'b'.repeat(totalLineLen - available - 1);
    expect(minified.length).toBe(totalLineLen);

    const truncatedPage = readFilePage(minified, { startLine: 1 }, limit);
    expect(truncatedPage.content.length).toBeLessThanOrEqual(limit);
    expect(truncatedPage.complete).toBe(false);
    expect(truncatedPage.startLine).toBe(1);
    expect(truncatedPage.endLine).toBe(1);
    expect(truncatedPage.nextStartLine).toBeNull();
    expect(truncatedPage.nextOffset).not.toBeNull();
    // Ensure no lone high surrogate exists anywhere in output
    expect(truncatedPage.content).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(truncatedPage.content).toContain('[truncated: 2000 chars]');
  });

  it('supports combining startLine and query in line mode', () => {
    const doc = Array.from(
      { length: 40 },
      (_, i) => `row ${i + 1}${i === 25 ? ' NEEDLE' : ''}`,
    ).join('\n');
    const page = readFilePage(doc, { maxLines: 10, query: 'needle', startLine: 10 });
    expect(page.totalMatches).toBe(1);
    expect(page.matches).toHaveLength(1);
    expect(page.matches![0].line).toBe(26);
    expect(page.startLine).toBe(21);
    expect(page.endLine).toBe(30);
    expect(page.content).toContain('L26: row 26 NEEDLE');
  });
});
