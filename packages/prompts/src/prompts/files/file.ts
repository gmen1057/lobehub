import type { ChatFileItem } from '@lobechat/types';

import { FILE_CONTEXT_CHARS, FILE_PREVIEW_CHARS, filePreview } from './context';

const filePrompt = (item: ChatFileItem, addUrl: boolean, limit: number) => {
  const rawContent = item.content || '';
  const content = filePreview(rawContent, limit);
  return addUrl
    ? `<file id="${item.id}" name="${item.name}" type="${item.fileType}" size="${item.size}" url="${item.url}">${content}</file>`
    : `<file id="${item.id}" name="${item.name}" type="${item.fileType}" size="${item.size}">${content}</file>`;
};

export const filePrompts = (
  fileList: ChatFileItem[],
  addUrl: boolean,
  budget = FILE_CONTEXT_CHARS,
) => {
  if (fileList.length === 0) return '';

  let remaining = budget;
  const prompt = `<files>
<files_docstring>here are user upload files you can refer to</files_docstring>
${fileList
  .map((item) => {
    const limit = Math.max(0, Math.min(FILE_PREVIEW_CHARS, remaining));
    remaining -= Math.min(item.content?.length || 0, limit);
    return filePrompt(item, addUrl, limit);
  })
  .join('\n')}
</files>`;

  return prompt.trim();
};
