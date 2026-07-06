import { type DocumentChunk } from '../../types';

/**
 * pdfjs-dist 5.x touches DOMMatrix and friends at module initialization,
 * which don't exist in Node.js. Polyfill them from @napi-rs/canvas before
 * the first import (same approach as packages/file-loaders).
 */
const ensureDomPolyfills = async () => {
  if (typeof (globalThis as any).DOMMatrix !== 'undefined') return;
  try {
    const mod: any = await import('@napi-rs/canvas');
    const canvas = mod.default ?? mod;
    (globalThis as any).DOMMatrix = canvas.DOMMatrix;
    (globalThis as any).DOMPoint = canvas.DOMPoint;
    (globalThis as any).DOMRect = canvas.DOMRect;
    (globalThis as any).Path2D = canvas.Path2D;
  } catch (e) {
    console.error('[PdfLoader] Error importing @napi-rs/canvas:', e);
  }
};

const loadWithPdfjs = async (buffer: Buffer): Promise<DocumentChunk[]> => {
  await ensureDomPolyfills();
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.length),
    useSystemFonts: true,
  }).promise;

  const chunks: DocumentChunk[] = [];
  for (let i = 1; i <= doc.numPages; i += 1) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();

    let lastY: number | undefined;
    const textItems: string[] = [];
    for (const item of content.items) {
      if ('str' in item) {
        textItems.push(lastY === item.transform[5] || !lastY ? item.str : `\n${item.str}`);
        lastY = item.transform[5];
      }
    }

    const pageContent = textItems.join('').replaceAll('\0', '').trim();
    if (pageContent.length === 0) continue;

    chunks.push({
      metadata: { loc: { pageNumber: i } },
      pageContent,
    });
  }

  return chunks;
};

// Legacy parser (bundles pdf.js ~1.x). Extracts nothing from many modern PDFs
// (CID fonts, presentation exports), kept only as a fallback for documents
// that crash pdfjs-dist 5.x (e.g. encrypted files).
const loadWithPdfParse = async (buffer: Buffer): Promise<DocumentChunk[]> => {
  const pdfParse = (await import('pdf-parse')).default;
  const data = await pdfParse(buffer);

  const pages: string[] = data.text
    ? data.text.split(/\f/).filter((page: string) => page.trim().length > 0)
    : [];

  return pages.map((pageContent: string, index: number) => ({
    metadata: {
      loc: { pageNumber: index + 1 },
    },
    pageContent: pageContent.trim(),
  }));
};

export const PdfLoader = async (fileBlob: Blob): Promise<DocumentChunk[]> => {
  const buffer = Buffer.from(await fileBlob.arrayBuffer());

  try {
    return await loadWithPdfjs(buffer);
  } catch (e) {
    console.error('[PdfLoader] pdfjs-dist failed, falling back to pdf-parse:', e);
    return loadWithPdfParse(buffer);
  }
};
