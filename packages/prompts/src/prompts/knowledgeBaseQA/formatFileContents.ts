import type { FileReadOptions } from '../files/context';
import { FILE_READ_CHARS, readFilePage } from '../files/context';

export interface FileContent {
  content: string;
  error?: string;
  fileId: string;
  filename: string;
}

/**
 * Formats a single file content with XML tags
 */
const formatFileContent = (file: FileContent, options: FileReadOptions, limit: number): string => {
  if (file.error) {
    return `<file id="${file.fileId}" name="${file.filename}" error="${file.error}" />`;
  }

  const page = readFilePage(file.content, options, limit);
  const coverage = page.complete
    ? ''
    : `\n<coverage>${JSON.stringify({ ...page, content: undefined })}</coverage>\n` +
      '[Partial source. Continue with readKnowledge(fileIds, offset=nextOffset). A query searches literal text, not meaning; no match is not proof of absence. For complete coverage omit query and read from offset=0 to nextOffset=null.]\n';
  return `<file id="${file.fileId}" name="${file.filename}">
${coverage}${page.content}
</file>`;
};

/**
 * Format file contents prompt for AI consumption using XML structure
 */
export const promptFileContents = (
  fileContents: FileContent[],
  options: FileReadOptions = {},
): string => {
  const limit = Math.max(1, Math.floor(FILE_READ_CHARS / Math.max(1, fileContents.length)));
  const filesXml = fileContents.map((file) => formatFileContent(file, options, limit)).join('\n');

  return `<knowledge_base_files totalCount="${fileContents.length}">
<instruction>Use the information from these files to answer the user's question. Always cite the source files.</instruction>
${filesXml}
</knowledge_base_files>`;
};
