import { marked } from 'marked';
import PDFDocument from 'pdfkit';

const REGULAR_FONT_URL =
  'https://cdn.jsdelivr.net/gh/adobe-fonts/source-han-sans@2.004R/OTF/SimplifiedChinese/SourceHanSansSC-Regular.otf';

let regularFontCache: Buffer | null = null;
// Promise mutex: prevents N concurrent cold-start requests from each fetching the font.
let fontLoadPromise: Promise<Buffer | null> | null = null;

const fetchRegularFont = async (): Promise<Buffer | null> => {
  try {
    const response = await fetch(REGULAR_FONT_URL, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return null;

    const fontBuffer = Buffer.from(await response.arrayBuffer());
    regularFontCache = fontBuffer;
    return fontBuffer;
  } catch (error) {
    console.error('[documents:pdf] Failed to load CJK font, using PDFKit fallback:', error);
    return null;
  }
};

const loadRegularFont = async (): Promise<Buffer | null> => {
  if (regularFontCache) return regularFontCache;
  fontLoadPromise ??= fetchRegularFont().finally(() => {
    fontLoadPromise = null;
  });
  return fontLoadPromise;
};

export const generatePdfFromMarkdown = async (
  markdownContent: string,
  title?: string,
): Promise<Buffer> => {
  const regularFont = await loadRegularFont();

  return new Promise((resolve, reject) => {
    try {
      const tokens = marked.lexer(markdownContent);
      const doc = new PDFDocument({
        bufferPages: true,
        margins: { bottom: 50, left: 50, right: 50, top: 50 },
        size: 'A4',
      });
      const chunks: Buffer[] = [];

      if (regularFont) {
        doc.registerFont('Regular', regularFont);
        doc.font('Regular');
      } else {
        doc.font('Helvetica');
      }

      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      if (title) doc.fontSize(20).text(title, { align: 'center' });
      doc.moveDown(2);

      let currentY = doc.y;
      for (const token of tokens) {
        if (currentY > 700) {
          doc.addPage();
          currentY = 50;
        }

        switch (token.type) {
          case 'heading': {
            const headingSize = Math.max(16 - (token.depth - 1) * 2, 12);
            doc.fontSize(headingSize).fillColor('#222').text(token.text);
            doc.moveDown(0.5);
            break;
          }
          case 'paragraph': {
            doc.fontSize(12).fillColor('#333').text(token.text, { align: 'left', lineGap: 2 });
            doc.moveDown(1);
            break;
          }
          case 'list': {
            for (const item of token.items) {
              doc.fontSize(12).fillColor('#333').text(`• ${item.text}`, { indent: 20, lineGap: 2 });
            }
            doc.moveDown(1);
            break;
          }
          case 'blockquote': {
            doc.fontSize(12).fillColor('#666').text(token.text, { indent: 20, lineGap: 2 });
            doc.moveDown(1);
            break;
          }
          case 'code': {
            doc.fontSize(10).fillColor('#333').text(token.text, { indent: 20, lineGap: 1 });
            doc.moveDown(1);
            break;
          }
          case 'hr': {
            doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
            doc.moveDown(1);
            break;
          }
          default: {
            if ('text' in token && token.text) {
              doc.fontSize(12).fillColor('#333').text(token.text, { align: 'left', lineGap: 2 });
              doc.moveDown(1);
            }
          }
        }
        currentY = doc.y;
      }

      const pages = doc.bufferedPageRange();
      for (let i = 0; i < pages.count; i += 1) {
        doc.switchToPage(i);
        doc
          .fontSize(8)
          .fillColor('#666')
          .text(`Page ${i + 1} of ${pages.count}`, 50, 750, {
            align: 'center',
            width: 495,
          });
      }

      doc.end();
    } catch (error) {
      reject(
        new Error(
          `PDFKit PDF generation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        ),
      );
    }
  });
};
