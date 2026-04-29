export const MARKDOWN_MIME_TYPE = 'text/markdown; charset=utf-8';

export const renderMarkdownDocument = async (markdown: string): Promise<Buffer> => {
  return Buffer.from(markdown, 'utf8');
};
