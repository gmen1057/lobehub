import { describe, expect, it, vi } from 'vitest';

import { processContentBlocks, replaceMediaBlocksWithText } from './contentProcessor';

const payload = (filename: string, base64 = 'aGVsbG8=') => ({
  text: JSON.stringify({ content_base64: base64, filename, success: true }),
  type: 'text' as const,
});

describe('sandbox file delivery', () => {
  it('delivers a PNG as a downloadable file and a real model image block', async () => {
    const uploadBase64 = vi.fn(async () => ({
      fileId: 'owned-scan',
      url: 'https://example.test/f/owned-scan',
    }));
    const blocks = await processContentBlocks([payload('scan.png')], { uploadBase64 } as any, {
      fileImagesAsMedia: true,
    });
    expect(blocks).toEqual([
      { text: 'Файл готов: [scan.png](https://example.test/f/owned-scan)', type: 'text' },
      {
        data: 'https://example.test/f/owned-scan',
        fileId: 'owned-scan',
        mimeType: 'image/png',
        type: 'image',
      },
    ]);
    expect(uploadBase64).toHaveBeenCalledOnce();
    expect(JSON.stringify(blocks)).not.toContain('aGVsbG8=');
  });

  it.each(['report.pdf', 'report.xlsx'])(
    'delivers %s as a file, without pretending its pixels were viewed',
    async (name) => {
      const uploadBase64 = vi.fn(async () => ({
        fileId: 'owned-file',
        url: 'https://example.test/f/owned-file',
      }));
      const blocks = await processContentBlocks([payload(name)], { uploadBase64 } as any, {
        fileImagesAsMedia: true,
      });
      expect(blocks).toEqual([
        { text: `Файл готов: [${name}](https://example.test/f/owned-file)`, type: 'text' },
      ]);
      expect(uploadBase64).toHaveBeenCalledOnce();
    },
  );

  it('does not leak a raw file when storage is unavailable', () => {
    const blocks = replaceMediaBlocksWithText(
      [payload('scan.png'), { text: 'ordinary text', type: 'text' }],
      'no storage',
    );
    expect(blocks).toEqual([
      { text: '[файл не сохранён: no storage]', type: 'text' },
      { text: 'ordinary text', type: 'text' },
    ]);
  });

  it('reports the existing inline limit instead of returning the oversized base64 to the model', async () => {
    const uploadBase64 = vi.fn();
    const blocks = await processContentBlocks(
      [payload('report.pdf', 'A'.repeat(20_000_004))],
      { uploadBase64 } as any,
      { degradeOnError: true },
    );
    expect(uploadBase64).not.toHaveBeenCalled();
    expect(JSON.stringify(blocks).length).toBeLessThan(300);
    expect(blocks[0]).toMatchObject({ text: expect.stringContaining('файл не сохранён') });
  });
});
