import { isPdfMime } from '../aiAgent/pdfPrepare';
import { hasHtmlArtifact } from './artifacts';

/**
 * arckep (19.10.2026): когда в ход включается инструмент `arckep-layout` (сверка с макетом и правки артефакта
 * кусками): в теме есть PDF (макет — его вложили сейчас или раньше) или HTML-артефакт, который уже писал помощник.
 * Схема инструмента небольшая (≈ 0,5 тыс. токенов), поэтому он не «по требованию», а сразу в первом шаге —
 * модель должна вызвать его сама, не подключая. Выключатель: `ARCKEP_LAYOUT_CHECK=0`.
 */
export const isLayoutCheckEnabled = () => process.env.ARCKEP_LAYOUT_CHECK !== '0';

interface FileLike {
  fileType?: string | null;
  mimeType?: string | null;
  name?: string | null;
}

export const needsLayoutTool = (input: {
  /** Файлы текущего сообщения */
  files?: FileLike[];
  /** История темы (сообщения базы: role, content, fileList) */
  history: Array<{ content?: unknown; fileList?: FileLike[]; role?: string }>;
}): boolean => {
  const isPdf = (file: FileLike) => isPdfMime(file.mimeType ?? file.fileType, file.name);
  if (input.files?.some(isPdf)) return true;
  return input.history.some((message) => {
    if (message.role === 'user') return Boolean(message.fileList?.some(isPdf));
    if (message.role === 'assistant') {
      return typeof message.content === 'string' && hasHtmlArtifact(message.content);
    }
    return false;
  });
};
