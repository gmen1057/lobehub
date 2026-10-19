import type { MessageAttachmentRef } from '@lobechat/types';

/**
 * arckep (19.10.2026): список вложений для модели — имя, тип, размер картинки в точках и устойчивый адрес
 * ОРИГИНАЛА (`https://arckep.ru/chat/f/<id>/`), а не ужатой копии. Модель вставляет адрес в HTML-предпросмотр
 * (`<img src>`, `@font-face`) или скачивает файл в песочнице, чтобы вырезать фрагмент. Только адреса, не
 * содержимое: одна строка на файл.
 */
export type AttachmentRef = MessageAttachmentRef;

const attachmentLine = (item: AttachmentRef) => {
  const size = item.width && item.height ? `${item.width}×${item.height} px` : undefined;
  return `- ${[item.name, item.mime, size, item.note, item.url].filter(Boolean).join(' · ')}`;
};

export const attachmentsPrompts = (items: AttachmentRef[] | undefined) => {
  if (!items || items.length === 0) return '';

  return `<attachments>
<attachments_docstring>original files of the person: put these addresses into HTML (img src, @font-face) or download them in the sandbox</attachments_docstring>
${items.map((item) => attachmentLine(item)).join('\n')}
</attachments>`;
};
