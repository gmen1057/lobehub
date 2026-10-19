import type { ChatFileItem, ChatImageItem, ChatVideoItem } from '@lobechat/types';

import { type AttachmentRef, attachmentsPrompts } from './attachments';
import { filePrompts } from './file';
import { imagesPrompts } from './image';
import { type LayoutInfo, layoutsPrompts } from './layout';
import { videosPrompts } from './video';

export { type AttachmentRef, attachmentsPrompts } from './attachments';
export type { FileReadOptions, FileReadPage } from './context';
export {
  FILE_CONTEXT_CHARS,
  FILE_PREVIEW_CHARS,
  FILE_READ_CHARS,
  filePreview,
  fileReferences,
  readFilePage,
} from './context';
export type { KnowledgeBaseInfo, PromptKnowledgeOptions } from './knowledgeBase';
export { promptAgentKnowledge } from './knowledgeBase';
export type { LayoutBlock, LayoutCrop, LayoutInfo, LayoutLine, LayoutPage } from './layout';
export { LAYOUT_MAX_CHARS, layoutPrompt, layoutsPrompts } from './layout';

export const filesPrompts = ({
  attachments,
  imageList,
  fileList,
  videoList,
  addUrl = true,
  fileBudget,
  layouts,
}: {
  addUrl?: boolean;
  /**
   * arckep: список вложений с устойчивыми адресами оригиналов (attachments.ts). Он есть — адреса копий
   * (длинные подписанные ссылки) в <image>/<file> не повторяются: это сотни токенов на каждую картинку.
   */
  attachments?: AttachmentRef[];
  fileBudget?: number;
  fileList?: ChatFileItem[];
  imageList?: ChatImageItem[];
  /**
   * arckep (19.10.2026): описание макета PDF (layout.ts) — идёт блоком `<layout>` после `<attachments>`.
   * Собирается из записи подготовки файла при каждом ходе и нигде не хранится.
   */
  layouts?: LayoutInfo[];
  videoList?: ChatVideoItem[];
}) => {
  const hasImages = (imageList || []).length > 0;
  const hasFiles = (fileList || []).length > 0;
  const hasVideos = (videoList || []).length > 0;

  if (!hasImages && !hasFiles && !hasVideos) return '';

  const hasAttachments = (attachments || []).length > 0;
  // адреса копий не повторяются, когда есть список вложений с адресами оригиналов
  const copyUrls = addUrl && !hasAttachments;

  const contentParts = [
    hasImages ? imagesPrompts(imageList!, copyUrls) : '',
    hasFiles ? filePrompts(fileList!, copyUrls, fileBudget) : '',
    hasVideos ? videosPrompts(videoList!, addUrl) : '',
    attachmentsPrompts(attachments),
    layoutsPrompts(layouts),
  ].filter(Boolean);

  const prompt = `<!-- SYSTEM CONTEXT (NOT PART OF USER QUERY) -->
<context.instruction>following part contains context information injected by the system. Please follow these instructions:

1. Always prioritize handling user-visible content.
2. the context is only required when user's queries rely on it.
</context.instruction>
<files_info>
${contentParts.join('\n')}
</files_info>
<!-- END SYSTEM CONTEXT -->`;

  return prompt.trim();
};
