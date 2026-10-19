import type { LobeChatDatabase } from '@lobechat/database';
import debug from 'debug';

import { FileModel } from '@/database/models/file';
import { FileService } from '@/server/services/file';

import { extractPdfImages } from './pdfImages';
import { renderPdfPages } from './pdfPages';

const log = debug('lobe-server:pdf-prepare');

/**
 * arckep (19.10.2026): фоновая подготовка PDF — страницы картинками (pdfPages.ts) и вшитые картинки (pdfImages.ts).
 *
 * Зачем: на тяжёлом PDF (макет письма 603×5532 пт) рисование страниц занимало 11–19 с, и модель начинала отвечать
 * только после них. Студия грузит файл в движок (POST /files) до отправки сообщения, поэтому подготовку запускаем
 * при загрузке, в фоне: пока человек пишет сообщение, страницы уже рисуются.
 *
 * Результат привязан к файлу: `files.metadata.pdfPrep` записи PDF (jsonb `||`, остальные ключи не трогаем) —
 * ключи файлов-страниц и файлов-картинок человека, число страниц. Повторно файл не рисуется: если запись
 * `done` и версия совпала, берём её. `processing` без живой задачи в этом процессе (после перезапуска движка) —
 * значит задача умерла, запускаем заново; `failed` повторяется не раньше чем через минуту.
 *
 * Движок работает одним процессом (`node server.js`): живые задачи и ожидание — в памяти процесса
 * (`inflight`), остальное — в базе. Тяжёлая работа ограничена: не больше ARCKEP_PDF_PREPARE_PARALLEL (2) задач
 * одновременно, остальные ждут очереди.
 *
 * execAgent (index.ts) ждёт готовности не дольше ARCKEP_PDF_PREPARE_WAIT_MS (5000 мс); не успело — модель получает
 * только текстовый слой с пометкой «страницы ещё рисуются», а готовые вшитые картинки (они делаются первыми) идут
 * в список вложений сразу. На следующем ходе страницы подхватываются из записи (index.ts, обогащение истории).
 */

export const PDF_PREP_VERSION = 1;
/** Сколько ждать готовности в execAgent по умолчанию, мс. */
export const PDF_PREPARE_WAIT_MS = 5000;
/** После сбоя повторная попытка не раньше, мс. */
const RETRY_AFTER_FAILURE_MS = 60_000;

/** Пометка на строке PDF в списке вложений, пока страницы рисуются (по ней же её убирают, когда они готовы). */
export const PDF_PAGES_PENDING_NOTE =
  'страницы ещё рисуются: пока только текст файла, картинки страниц будут при следующем ходе';

export interface PdfPrepPage {
  fileId: string;
  height: number;
  /** Номер куска страницы с 1 */
  index: number;
  key: string;
  mime: string;
  /** Номер страницы с 1 */
  page: number;
  /** Сколько кусков у этой страницы */
  total: number;
  width: number;
}

export interface PdfPrepImage {
  fileId: string;
  height: number;
  /** Номер среди вшитых картинок файла, с 1 */
  index: number;
  mime: string;
  /** Страница, с 1 */
  page: number;
  width: number;
}

export interface PdfPrepRecord {
  error?: string;
  finishedAt?: number;
  /** Вшитые картинки: есть, как только готовы (раньше страниц) */
  images?: PdfPrepImage[];
  /** Сколько страниц в файле */
  pageCount?: number;
  /** Страницы картинками: есть, когда готовы */
  pages?: PdfPrepPage[];
  /** Сколько страниц нарисовано (по порядку с первой) */
  renderedPages?: number;
  startedAt: number;
  status: 'done' | 'failed' | 'processing';
  version: number;
}

/** Запись PDF в базе и её подготовка. */
export interface PdfPrepareStore {
  load: (
    fileId: string,
  ) => Promise<{ key: string; name: string; prep?: PdfPrepRecord } | undefined>;
  loadMany: (fileIds: string[]) => Promise<Map<string, PdfPrepRecord>>;
  save: (fileId: string, prep: PdfPrepRecord) => Promise<void>;
}

/** Хранилище файлов: прочитать PDF и сохранить картинки файлами человека. */
export interface PdfPrepareStorage {
  read: (key: string) => Promise<Uint8Array>;
  upload: (
    buffer: Buffer,
    mime: string,
    pathname: string,
  ) => Promise<{ fileId: string; key: string }>;
}

// ---- Очередь тяжёлой работы ----

const maxParallel = () => {
  const value = Number(process.env.ARCKEP_PDF_PREPARE_PARALLEL ?? 2);
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 2;
};
let running = 0;
const waiting: Array<() => void> = [];

const acquire = async () => {
  if (running < maxParallel()) {
    running++;
    return;
  }
  // слот передаётся ожидающему как есть: running не меняется
  await new Promise<void>((resolve) => waiting.push(resolve));
};

const release = () => {
  const next = waiting.shift();
  if (next) next();
  else running--;
};

/** Живые задачи этого процесса: «пользователь:файл» → результат. Никогда не отклоняются. */
const inflight = new Map<string, Promise<PdfPrepRecord>>();

const pad = (value: number) => String(value).padStart(2, '0');
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const isPdfMime = (mime?: string | null, name?: string | null) =>
  mime === 'application/pdf' || (!mime && /\.pdf$/i.test(name ?? ''));

/** Настройки из окружения (читаются при каждом запуске, чтобы выключатель действовал без перезапуска тестов). */
export const pdfPrepareOptions = () => ({
  embeddedImages: process.env.ARCKEP_PDF_EMBEDDED_IMAGES !== '0',
  onUpload: process.env.ARCKEP_PDF_PREPARE_ON_UPLOAD !== '0',
  pageImages: process.env.ARCKEP_PDF_PAGE_IMAGES !== '0',
  waitMs: (() => {
    const value = Number(process.env.ARCKEP_PDF_PREPARE_WAIT_MS ?? PDF_PREPARE_WAIT_MS);
    return Number.isFinite(value) && value >= 0 ? value : PDF_PREPARE_WAIT_MS;
  })(),
});

export class PdfPrepareService {
  constructor(
    private readonly userId: string,
    private readonly store: PdfPrepareStore,
    private readonly storage: PdfPrepareStorage,
  ) {}

  /** Рабочий вариант: записи — files.metadata.pdfPrep, файлы — через FileService. */
  static forUser(db: LobeChatDatabase, userId: string) {
    const fileModel = new FileModel(db, userId);
    const fileService = new FileService(db, userId);
    const prepOf = (metadata: unknown) =>
      (metadata as { pdfPrep?: PdfPrepRecord } | null | undefined)?.pdfPrep;

    return new PdfPrepareService(
      userId,
      {
        load: async (fileId) => {
          const file = await fileModel.findById(fileId);
          return file ? { key: file.url, name: file.name, prep: prepOf(file.metadata) } : undefined;
        },
        loadMany: async (fileIds) => {
          const records = new Map<string, PdfPrepRecord>();
          if (fileIds.length === 0) return records;
          for (const file of await fileModel.findByIds(fileIds)) {
            const prep = prepOf(file.metadata);
            if (prep) records.set(file.id, prep);
          }
          return records;
        },
        save: async (fileId, prep) => {
          await fileModel.mergeMetadata(fileId, { pdfPrep: prep });
        },
      },
      {
        read: (key) => fileService.getFileByteArray(key),
        upload: (buffer, mime, pathname) => fileService.uploadFromBuffer(buffer, mime, pathname),
      },
    );
  }

  /**
   * Запущенная или готовая подготовка файла. Не отклоняется: ошибка — запись `failed`.
   * Вторая просьба по тому же файлу получает ту же задачу, а не новую.
   */
  ensure(fileId: string): Promise<PdfPrepRecord> {
    const key = `${this.userId}:${fileId}`;
    const existing = inflight.get(key);
    if (existing) return existing;

    const promise = this.compute(fileId).finally(() => inflight.delete(key));
    inflight.set(key, promise);
    return promise;
  }

  /**
   * Ждать готовности не дольше `waitMs`. Не успело — `pending: true` и то, что уже записано (вшитые картинки
   * готовятся первыми, поэтому часто они уже есть).
   */
  async waitFor(
    fileId: string,
    waitMs: number,
  ): Promise<{ pending: boolean; record?: PdfPrepRecord }> {
    const done = this.ensure(fileId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), Math.max(0, waitMs));
    });
    const result = await Promise.race([done, timeout]);
    if (timer) clearTimeout(timer);
    if (result !== 'timeout') return { pending: false, record: result };

    const partial = (await this.store.load(fileId).catch(() => undefined))?.prep;
    return { pending: true, record: partial?.version === PDF_PREP_VERSION ? partial : undefined };
  }

  /** Записи подготовки уже известных файлов (для истории); ничего не запускает. */
  async peek(fileIds: string[]): Promise<Map<string, PdfPrepRecord>> {
    try {
      return await this.store.loadMany(fileIds);
    } catch (error) {
      log('peek failed: %s', errorText(error));
      return new Map();
    }
  }

  private async compute(fileId: string): Promise<PdfPrepRecord> {
    const failed = (error: unknown): PdfPrepRecord => ({
      error: errorText(error),
      finishedAt: Date.now(),
      startedAt: Date.now(),
      status: 'failed',
      version: PDF_PREP_VERSION,
    });

    try {
      const file = await this.store.load(fileId);
      if (!file) return failed('file not found');

      const prep = file.prep;
      if (prep?.version === PDF_PREP_VERSION) {
        if (prep.status === 'done') return prep;
        if (
          prep.status === 'failed' &&
          Date.now() - (prep.finishedAt ?? 0) < RETRY_AFTER_FAILURE_MS
        ) {
          return prep;
        }
      }

      await acquire();
      try {
        return await this.run(fileId, file);
      } finally {
        release();
      }
    } catch (error) {
      log('prepare %s failed: %s', fileId, errorText(error));
      return failed(error);
    }
  }

  private async persist(fileId: string, record: PdfPrepRecord) {
    try {
      await this.store.save(fileId, record);
    } catch (error) {
      // результат всё равно вернётся ждущему в этом процессе
      log('could not save the record of %s: %s', fileId, errorText(error));
    }
  }

  private async run(fileId: string, file: { key: string; name: string }): Promise<PdfPrepRecord> {
    const options = pdfPrepareOptions();
    const record: PdfPrepRecord = {
      startedAt: Date.now(),
      status: 'processing',
      version: PDF_PREP_VERSION,
    };

    try {
      if (!options.embeddedImages && !options.pageImages) {
        return { ...record, finishedAt: Date.now(), images: [], pages: [], status: 'done' };
      }
      await this.persist(fileId, record);

      const pdf = Buffer.from(await this.storage.read(file.key));
      const { nanoid } = await import('@lobechat/utils');
      const folder = `files/${this.userId}/${nanoid()}`;
      const name = file.name || 'file.pdf';

      // 1. Вшитые картинки: быстро (около секунды), поэтому первыми — их адреса пригодятся сразу
      if (options.embeddedImages) {
        record.images = [];
        try {
          for (const image of await extractPdfImages(pdf)) {
            const ext = image.mimeType === 'image/jpeg' ? 'jpg' : 'png';
            const uploaded = await this.storage.upload(
              image.buffer,
              image.mimeType,
              `${folder}/${name}.image-${pad(image.index)}.p${image.page}.${ext}`,
            );
            record.images.push({
              fileId: uploaded.fileId,
              height: image.height,
              index: image.index,
              mime: image.mimeType,
              page: image.page,
              width: image.width,
            });
          }
          log('pdf %s → %d embedded image(s)', fileId, record.images.length);
        } catch (error) {
          log('embedded images of %s failed: %s', fileId, errorText(error));
          record.images = [];
        }
        await this.persist(fileId, record);
      }

      // 2. Страницы картинками
      if (options.pageImages) {
        record.pages = [];
        try {
          const rendered = await renderPdfPages(pdf);
          record.pageCount = rendered.pageCount;
          record.renderedPages = rendered.renderedPages;
          for (const image of rendered.images) {
            const ext = image.mimeType === 'image/jpeg' ? 'jpg' : 'png';
            const fileName =
              image.total === 1
                ? `${name}.page-${pad(image.page)}.${ext}`
                : `${name}.page-${pad(image.page)}.part-${pad(image.index)}-of-${pad(image.total)}.${ext}`;
            const uploaded = await this.storage.upload(
              image.buffer,
              image.mimeType,
              `${folder}/${fileName}`,
            );
            record.pages.push({
              fileId: uploaded.fileId,
              height: image.height,
              index: image.index,
              key: uploaded.key,
              mime: image.mimeType,
              page: image.page,
              total: image.total,
              width: image.width,
            });
          }
          log(
            'pdf %s → %d page image(s) (%d of %d pages)',
            fileId,
            record.pages.length,
            rendered.renderedPages,
            rendered.pageCount,
          );
        } catch (error) {
          log('page images of %s failed: %s', fileId, errorText(error));
          record.pages = [];
        }
      }

      const done: PdfPrepRecord = { ...record, finishedAt: Date.now(), status: 'done' };
      await this.persist(fileId, done);
      return done;
    } catch (error) {
      log('prepare %s failed: %s', fileId, errorText(error));
      const failed: PdfPrepRecord = {
        ...record,
        error: errorText(error),
        finishedAt: Date.now(),
        status: 'failed',
      };
      await this.persist(fileId, failed);
      return failed;
    }
  }
}

/**
 * Запустить подготовку при загрузке файла (POST /files). Ничего не ждёт и не бросает: загрузка не должна зависеть
 * от подготовки. Не запускается для документов базы знаний (там PDF нужен для индексации, не для чата),
 * не-PDF и при ARCKEP_PDF_PREPARE_ON_UPLOAD=0. Возвращает задачу для тестов.
 */
export const schedulePdfPrepare = (
  db: LobeChatDatabase,
  userId: string,
  file: { id: string; knowledgeBaseId?: string; mime?: string | null; name?: string | null },
): Promise<PdfPrepRecord> | undefined => {
  const options = pdfPrepareOptions();
  if (!options.onUpload || (!options.pageImages && !options.embeddedImages)) return undefined;
  if (file.knowledgeBaseId || !isPdfMime(file.mime, file.name)) return undefined;

  try {
    return PdfPrepareService.forUser(db, userId).ensure(file.id);
  } catch (error) {
    log('could not schedule the preparation of %s: %s', file.id, errorText(error));
    return undefined;
  }
};
