// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { prepareImageForModel } from '../imageSlicing';
import { renderPdfPages } from '../pdfPages';

// arckep (19.10.2026): настоящие файлы владельца (макет письма JPEG 2512×23050 и PDF 603×5532 пт). Лежат в
// рабочей папке сессии разбора, в репозиторий не входят: тест идёт, только если файлы на месте
// (синтетические того же размера — в imageSlicing.test.ts и pdfPages.test.ts).
const DIR =
  '/tmp/claude-0/-opt-image-studio/2a435165-e3ab-4967-b632-06f75fc7d8ff/scratchpad/pdfcase';
const JPEG = `${DIR}/file_JensFcSYBIJ9.bin`;
const PDF = `${DIR}/tmpl.pdf`;

describe.runIf(existsSync(JPEG))('JPEG владельца 2512×23050', () => {
  it('8 кусков 1536×2048 вместо одной картинки 209×1920', async () => {
    const result = await prepareImageForModel(readFileSync(JPEG), 'image/jpeg');
    expect(result.sliced).toBe(true);
    expect(result.parts).toHaveLength(8);
    expect(result.parts.every((part) => part.width === 1536 && part.height === 2048)).toBe(true);
  }, 60_000);
});

describe.runIf(existsSync(PDF))('PDF владельца 603×5532 пт', () => {
  it('одна страница → 8 кусков 1536×2048', async () => {
    const result = await renderPdfPages(readFileSync(PDF));
    expect(result.pageCount).toBe(1);
    expect(result.images).toHaveLength(8);
    expect(result.images.every((image) => image.width === 1536 && image.height === 2048)).toBe(
      true,
    );
  }, 120_000);
});
