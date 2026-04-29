import { describe, expect, it } from 'vitest';

import { renderDocxFromMarkdown } from '../renderers/docx';
import { renderMarkdownDocument } from '../renderers/markdown';
import { generatePdfFromMarkdown } from '../renderers/pdf';
import { renderXlsxDocument, resolveSheets } from '../renderers/xlsx';

const markdown = `# Quarterly Report

| Metric | Value |
| --- | --- |
| Revenue | 120 |
| Cost | 30 |`;

describe('document renderers', () => {
  it('renders a non-empty PDF buffer', async () => {
    const buffer = await generatePdfFromMarkdown(markdown, 'Quarterly Report');

    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.length).toBeGreaterThan(100);
    expect(buffer.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('renders a non-empty DOCX buffer', async () => {
    const buffer = await renderDocxFromMarkdown(markdown, 'Quarterly Report');

    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.length).toBeGreaterThan(100);
    expect(buffer.subarray(0, 2).toString()).toBe('PK');
  });

  it('renders a non-empty XLSX buffer', async () => {
    const sheets = resolveSheets(markdown, undefined, 'Report');
    const buffer = await renderXlsxDocument(sheets);

    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.length).toBeGreaterThan(100);
    expect(buffer.subarray(0, 2).toString()).toBe('PK');
  });

  it('renders markdown passthrough buffer', async () => {
    const buffer = await renderMarkdownDocument(markdown);

    expect(buffer.toString('utf8')).toContain('Quarterly Report');
  });
});
