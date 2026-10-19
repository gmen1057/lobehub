import type { ToolResultImage } from '@lobechat/context-engine';
import type { LobeChatDatabase } from '@lobechat/database';
import { isVisionImageMime } from '@lobechat/utils/isVisionImage';
import debug from 'debug';

import { FileModel } from '@/database/models/file';
import { FileService } from '@/server/services/file';

const log = debug('lobe-server:context-engineering:tool-result-image-url');

/**
 * Картинка тяжелее — модели не уходит (в тексте tool-сообщения ссылка остаётся): один слишком большой
 * файл ломает весь запрос к провайдеру. 5 МБ — по размеру самого файла; у Anthropic предел на картинку
 * 10 МБ в base64 при прямом вызове API (≈7,5 МБ файла) и 5 МБ в base64 на Bedrock/Google Cloud
 * (platform.claude.com/docs/en/build-with-claude/vision, «Request limits»). Кадры Figma (до 1568 px) — сотни КБ.
 */
export const MAX_TOOL_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * arckep (19.10.2026): адрес картинки результата инструмента, который откроет провайдер моделей.
 *
 * В pluginState лежит постоянный адрес `${APP_URL}/f/:id` — маршрут /f/:id отвечает 302 на подписанную
 * ссылку, живущую 5 минут (src/app/(backend)/f/[id]/route.ts); провайдеру моделей и серверу, который сам
 * качает картинку для Anthropic/Gemini (imageUrlToBase64), он не подходит. Передавать этот адрес в
 * getFullFileUrl тоже нельзя: getKeyFromFullUrl узнаёт его только по пути, начинающемуся с «/f/», а у нас
 * APP_URL = https://arckep.ru/chat, путь «/chat/f/…». Поэтому берём fileId из блока и идём тем же путём,
 * что для картинок, прикреплённых пользователем (aiAgent/index.ts, postProcessUrl): запись файла ТОГО ЖЕ
 * пользователя (FileModel.findById фильтрует по userId — подставленный fileId чужого файла не откроет) →
 * FileService.getFullFileUrl(ключ) → подписанная ссылка хранилища (если не задан публичный домен бакета).
 * Подпись ставится от начала текущего часа и действует S3_PREVIEW_URL_EXPIRE_IN (по умолчанию 7200 с)
 * + 1 час (S3.createPreSignedUrlForPreview): не меньше двух часов с момента запроса, а внутри часа ссылка
 * одна и та же — кэш промта у провайдера не ломается.
 *
 * Не картинка, чужой/удалённый файл, слишком большой файл или ошибка хранилища — `undefined`.
 */
export const createToolImageUrlResolver = (db: LobeChatDatabase, userId: string) => {
  const fileModel = new FileModel(db, userId);
  let fileService: FileService | undefined;

  return async ({ fileId }: ToolResultImage): Promise<string | undefined> => {
    if (!fileId) return undefined;

    try {
      const file = await fileModel.findById(fileId);
      if (!file?.url) return undefined;

      if (!isVisionImageMime(file.fileType)) {
        log('File %s is not a raster image (%s), skipped', fileId, file.fileType);
        return undefined;
      }
      if (file.size > MAX_TOOL_IMAGE_BYTES) {
        log('File %s is too large for the model (%d bytes), skipped', fileId, file.size);
        return undefined;
      }

      // FileService создаёт клиент хранилища: без настроек S3 он бросает — тогда картинок просто нет.
      fileService ??= new FileService(db, userId);
      return await fileService.getFullFileUrl(file.url);
    } catch (error) {
      log('Cannot resolve tool image %s: %O', fileId, error);
      return undefined;
    }
  };
};
