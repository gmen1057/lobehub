import { zipSync } from 'fflate';
import { marked } from 'marked';

const DOCX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const textEncoder = new TextEncoder();

interface DocxConstructor {
  new (options: Record<string, unknown>): unknown;
}

interface DocxModule {
  Document: DocxConstructor;
  HeadingLevel: Record<string, unknown>;
  Packer: { toBuffer: (document: unknown) => Promise<Buffer> };
  Paragraph: DocxConstructor;
  TextRun: DocxConstructor;
}

export { DOCX_MIME_TYPE };

const escapeXml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');

const toBytes = (value: string) => textEncoder.encode(value);

const loadDocx = async (): Promise<DocxModule | null> => {
  try {
    const packageName = 'docx';
    const mod = (await import(packageName)) as unknown as DocxModule;
    return mod.Document && mod.Packer && mod.Paragraph && mod.TextRun ? mod : null;
  } catch {
    return null;
  }
};

const tokenText = (token: unknown) => {
  const record = token as Record<string, unknown>;
  return typeof record.text === 'string' ? record.text : '';
};

const renderWithDocxPackage = async (markdown: string, title: string) => {
  const docx = await loadDocx();
  if (!docx) return null;

  const children: unknown[] = [
    new docx.Paragraph({
      children: [new docx.TextRun({ bold: true, size: 32, text: title })],
    }),
  ];

  for (const token of marked.lexer(markdown)) {
    if (token.type === 'space') continue;

    if (token.type === 'heading') {
      const depth = Math.min(Math.max((token as { depth?: number }).depth ?? 1, 1), 3);
      children.push(
        new docx.Paragraph({
          heading: docx.HeadingLevel[`HEADING_${depth}`],
          text: tokenText(token),
        }),
      );
      continue;
    }

    if (token.type === 'list') {
      const items = (token as { items?: unknown[] }).items ?? [];
      for (const item of items) {
        children.push(new docx.Paragraph({ text: `• ${tokenText(item)}` }));
      }
      continue;
    }

    const text = tokenText(token);
    if (text) children.push(new docx.Paragraph({ text }));
  }

  const document = new docx.Document({ sections: [{ children }] });
  return docx.Packer.toBuffer(document);
};

const paragraphXml = (text: string, options?: { bold?: boolean; size?: number }) => {
  const bold = options?.bold ? '<w:b/>' : '';
  const size = options?.size ? `<w:sz w:val="${options.size}"/>` : '';
  const runProps = bold || size ? `<w:rPr>${bold}${size}</w:rPr>` : '';

  return `<w:p><w:r>${runProps}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
};

const fallbackParagraphs = (markdown: string, title: string) => {
  const paragraphs = [paragraphXml(title, { bold: true, size: 32 })];

  for (const token of marked.lexer(markdown)) {
    if (token.type === 'heading') {
      paragraphs.push(paragraphXml(tokenText(token), { bold: true, size: 28 }));
      continue;
    }

    if (token.type === 'list') {
      const items = (token as { items?: unknown[] }).items ?? [];
      for (const item of items) paragraphs.push(paragraphXml(`• ${tokenText(item)}`));
      continue;
    }

    if (token.type === 'hr') {
      paragraphs.push(paragraphXml('────────'));
      continue;
    }

    const text = tokenText(token);
    if (text) paragraphs.push(paragraphXml(text));
  }

  return paragraphs.join('');
};

const fallbackDocx = (markdown: string, title: string) => {
  const documentXml = `${XML_HEADER}
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${fallbackParagraphs(markdown, title)}<w:sectPr/></w:body>
</w:document>`;

  const files = {
    '[Content_Types].xml': toBytes(`${XML_HEADER}
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`),
    '_rels': {
      '.rels': toBytes(`${XML_HEADER}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`),
    },
    'word': { 'document.xml': toBytes(documentXml) },
  };

  return Buffer.from(zipSync(files, { level: 0 }));
};

export const renderDocxFromMarkdown = async (markdown: string, title: string): Promise<Buffer> => {
  const packageBuffer = await renderWithDocxPackage(markdown, title);
  return packageBuffer ?? fallbackDocx(markdown, title);
};
