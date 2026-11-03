import { ARCKEP_E2B_CONNECTOR_ID } from '@lobechat/builtin-tools';
import type { LobeToolManifest } from '@lobechat/context-engine';

export interface JsonFilePayload {
  content_base64: unknown;
  filename?: unknown;
  success?: unknown;
}

/** The gateway returns bytes; the chat adapter owns the model-facing delivery contract. */
export const parseJsonFilePayload = (text: string): JsonFilePayload | undefined => {
  if (!text.includes('content_base64')) return;
  try {
    const parsed = JSON.parse(text);
    if (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      'content_base64' in parsed
    )
      return parsed;
  } catch {
    // Ordinary tool text may mention the field without being a file payload.
  }
};

const FILE_DELIVERY_DESCRIPTION =
  'В этом чате результат — ссылка на сохранённый файл для скачивания, не base64. ' +
  'PNG/JPEG дополнительно доступны для передачи как изображение через проверку владельца и возможностей модели. ' +
  'Ссылка сама по себе не означает, что содержимое просмотрено; PDF/Excel возвращаются только файлом. ' +
  'Если файл не сохранён, результата для скачивания нет.';

/** Apply at schema assembly, so existing installs get the actual chat contract without a DB rewrite. */
export const applyChatFileDeliveryContract = (manifest: LobeToolManifest): LobeToolManifest => {
  if (manifest.identifier !== ARCKEP_E2B_CONNECTOR_ID) return manifest;
  return {
    ...manifest,
    api: manifest.api.map((api) => {
      if (api.name !== 'read_file' && api.name !== 'execute_and_get_file') return api;
      return {
        ...api,
        description: `${api.description.replaceAll(/(?:Файл возвращается как|Возвращает) base64\.\s*/g, '').trim()} ${FILE_DELIVERY_DESCRIPTION}`,
      };
    }),
    systemRole: [
      manifest.systemRole,
      'read_file и execute_and_get_file возвращают ссылку на сохранённый файл. PNG/JPEG также передаются как изображение, если файл доступен владельцу и модель поддерживает изображения. PDF/Excel возвращаются ссылкой для скачивания, без просмотра их содержимого. При ошибке сохранения ссылка на результат отсутствует.',
    ]
      .filter(Boolean)
      .join('\n\n'),
  };
};
