import type { LobeChatDatabase } from '@lobechat/database';
import type { LayoutBlock, LayoutLine, LayoutPage } from '@lobechat/prompts';
import debug from 'debug';

import { FileModel } from '@/database/models/file';
import { FileService } from '@/server/services/file';

import { extractPdfImages } from './pdfImages';
import {
  analysePdfLayout,
  LAYOUT_MAX_BLOCKS_PER_PAGE,
  LAYOUT_MAX_CROPS,
  LAYOUT_MAX_LINES,
  LAYOUT_MAX_LINES_PER_PAGE,
  LAYOUT_MAX_PAGES,
  matchImagePlaces,
} from './pdfLayout';
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
 * Запись лежит в `files.metadata`, а metadata клиент способен записать сам (tRPC `file.createFile` принимает любой
 * `metadata`): ей нельзя верить. Любая запись, прочитанная из базы (готовая, частичная, из истории), проходит
 * `verify`: формат строго проверяется, каждый `fileId` обязан быть файлом ЭТОГО человека, а ключ хранилища берётся
 * из его записи файла, а не из подделываемой записи подготовки. Не прошла — считается, что записи нет.
 *
 * Движок работает одним процессом (`node server.js`): живые задачи и ожидание — в памяти процесса
 * (`inflight`), остальное — в базе. Тяжёлая работа ограничена: не больше ARCKEP_PDF_PREPARE_PARALLEL (2) задач
 * одновременно, остальные ждут очереди.
 *
 * execAgent (index.ts) ждёт готовности не дольше ARCKEP_PDF_PREPARE_WAIT_MS (45 000 мс); не успело — модель получает
 * только текстовый слой с пометкой «страницы ещё рисуются», а готовые вшитые картинки (они делаются первыми) идут
 * в список вложений сразу. На следующем ходе страницы подхватываются из записи (index.ts, обогащение истории).
 * Ждём долго: 19.10 первый ход по PDF ушёл без страниц (5 с не хватило), и модель сочинила другое письмо.
 *
 * Версия 2 (19.10.2026): после страниц считается «описание макета» (pdfLayout.ts, `layout` в записи): строки
 * текста, блоки, вырезки картинок и значков (файлами человека), подсказка шрифта. Страницы пишутся в запись сразу,
 * до описания: описание занимает до двух минут, а страницы нужны модели раньше. Записи версии 1 не используются
 * и пересчитываются (как любая неподходящая запись).
 */

export const PDF_PREP_VERSION = 2;
/** Сколько ждать готовности в execAgent по умолчанию, мс. */
export const PDF_PREPARE_WAIT_MS = 45_000;
/** После сбоя повторная попытка не раньше, мс. */
const RETRY_AFTER_FAILURE_MS = 60_000;

/** Пометка на строке PDF в списке вложений, пока страницы рисуются (по ней же её убирают, когда они готовы). */
export const PDF_PAGES_PENDING_NOTE =
  'страницы ещё рисуются: пока только текст файла, картинки страниц будут при следующем ходе';

export interface PdfPrepPage {
  fileId: string;
  /** Где кусок лежит на странице (по вертикали, пункты страницы): у кусков нарезанной страницы */
  fromPt?: number;
  height: number;
  /** Номер куска страницы с 1 */
  index: number;
  key: string;
  mime: string;
  /** Номер страницы с 1 */
  page: number;
  toPt?: number;
  /** Сколько кусков у этой страницы */
  total: number;
  width: number;
}

/** Место вшитой картинки на странице, пункты страницы. */
export interface PdfPrepPlace {
  h: number;
  w: number;
  x: number;
  y: number;
}

export interface PdfPrepImage {
  fileId: string;
  height: number;
  /** Номер среди вшитых картинок файла, с 1 */
  index: number;
  mime: string;
  /** Страница, с 1 */
  page: number;
  /** Где картинка на странице, если удалось определить (pdfLayout.ts) */
  place?: PdfPrepPlace;
  width: number;
}

/** Вырезка макета (фото или значок) — файл человека. */
export interface PdfPrepCrop {
  fileId: string;
  h: number;
  kind: 'icon' | 'photo';
  mime: string;
  w: number;
  x: number;
  y: number;
}

/** Страница описания макета: как LayoutPage (packages/prompts), но вырезки — со ссылкой на файл, а не адресом. */
export type PdfPrepLayoutPage = Omit<LayoutPage, 'crops'> & { crops: PdfPrepCrop[] };

export interface PdfPrepLayout {
  pages: PdfPrepLayoutPage[];
}

export interface PdfPrepRecord {
  error?: string;
  finishedAt?: number;
  /** Вшитые картинки: есть, как только готовы (раньше страниц) */
  images?: PdfPrepImage[];
  /** Описание макета (pdfLayout.ts): есть, когда готово и файл похож на макет */
  layout?: PdfPrepLayout;
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
  /** Какие из этих файлов принадлежат человеку: id → ключ в хранилище. Чужие и несуществующие не возвращаются. */
  owned: (fileIds: string[]) => Promise<Map<string, string>>;
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
  /** Описание макета; нужны страницы-картинки (берёт их отрисовку), без них не работает */
  layout: process.env.ARCKEP_PDF_LAYOUT !== '0',
  onUpload: process.env.ARCKEP_PDF_PREPARE_ON_UPLOAD !== '0',
  pageImages: process.env.ARCKEP_PDF_PAGE_IMAGES !== '0',
  waitMs: (() => {
    const value = Number(process.env.ARCKEP_PDF_PREPARE_WAIT_MS ?? PDF_PREPARE_WAIT_MS);
    return Number.isFinite(value) && value >= 0 ? value : PDF_PREPARE_WAIT_MS;
  })(),
});

const IMAGE_MIMES = new Set(['image/jpeg', 'image/png']);
const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// ---- Проверка описания макета (запись из базы недоверенная) ----

const COLOR = /^#[\dA-F]{6}$/;
const MAX_LAYOUT_TEXT = 300;
/** Координаты в пунктах страницы: конечные числа в разумных пределах. */
const isCoord = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1_000_000;
const isSize = (value: unknown): value is number => isCoord(value) && value >= 0;
const isColor = (value: unknown): value is string => typeof value === 'string' && COLOR.test(value);
const isShortText = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= MAX_LAYOUT_TEXT;
const isOptional = <T>(
  value: unknown,
  check: (item: unknown) => item is T,
): value is T | undefined => value === undefined || check(value);

const verifyPlace = (raw: unknown): PdfPrepPlace | undefined | 'bad' => {
  if (raw === undefined) return undefined;
  if (!isRecord(raw) || !isCoord(raw.x) || !isCoord(raw.y) || !isSize(raw.w) || !isSize(raw.h)) {
    return 'bad';
  }
  return { h: raw.h, w: raw.w, x: raw.x, y: raw.y };
};

const verifyLine = (raw: unknown): LayoutLine | undefined => {
  if (!isRecord(raw)) return undefined;
  if (!isCoord(raw.x) || !isCoord(raw.y) || !isSize(raw.w)) return undefined;
  if (!isSize(raw.size) || raw.size < 1 || raw.size > 500) return undefined;
  if (!isShortText(raw.text) || raw.text === '') return undefined;
  if (!isOptional(raw.color, isColor) || !isOptional(raw.link, isShortText)) return undefined;
  if (raw.bold !== undefined && typeof raw.bold !== 'boolean') return undefined;
  if (raw.center !== undefined && typeof raw.center !== 'boolean') return undefined;
  return {
    ...(raw.bold ? { bold: true } : {}),
    ...(raw.center ? { center: true } : {}),
    ...(raw.color ? { color: raw.color } : {}),
    ...(raw.link ? { link: raw.link } : {}),
    size: raw.size,
    text: raw.text,
    w: raw.w,
    x: raw.x,
    y: raw.y,
  };
};

const verifyBlock = (raw: unknown): LayoutBlock | undefined => {
  if (!isRecord(raw)) return undefined;
  if (raw.kind !== 'fill' && raw.kind !== 'frame' && raw.kind !== 'line') return undefined;
  if (!isColor(raw.color)) return undefined;
  if (!isCoord(raw.x) || !isCoord(raw.y) || !isSize(raw.w) || !isSize(raw.h)) return undefined;
  if (raw.thickness !== undefined && !(isSize(raw.thickness) && raw.thickness <= 1000))
    return undefined;
  let radii: LayoutBlock['radii'];
  if (raw.radii !== undefined) {
    if (
      !Array.isArray(raw.radii) ||
      raw.radii.length !== 4 ||
      !raw.radii.every((value) => isCoord(value) && value >= -1 && value <= 10_000)
    ) {
      return undefined;
    }
    radii = raw.radii as [number, number, number, number];
  }
  return {
    color: raw.color,
    h: raw.h,
    kind: raw.kind,
    ...(radii ? { radii } : {}),
    ...(raw.thickness === undefined ? {} : { thickness: raw.thickness }),
    w: raw.w,
    x: raw.x,
    y: raw.y,
  };
};

/** fileId вырезок записи описания (формат уже проверен выше: страницы и вырезки — массивы записей со строкой). */
const layoutFileIds = (raw: unknown): string[] | undefined => {
  if (raw === undefined) return [];
  if (!isRecord(raw) || !Array.isArray(raw.pages) || raw.pages.length > LAYOUT_MAX_PAGES)
    return undefined;
  const ids: string[] = [];
  for (const page of raw.pages) {
    if (!isRecord(page) || !Array.isArray(page.crops) || page.crops.length > LAYOUT_MAX_CROPS) {
      return undefined;
    }
    for (const crop of page.crops) {
      if (!isRecord(crop) || typeof crop.fileId !== 'string' || crop.fileId === '')
        return undefined;
      ids.push(crop.fileId);
    }
  }
  return ids;
};

/** Описание макета: типы, конечные числа, строки ≤300 знаков, пределы количеств, чужие вырезки — всё или ничего. */
const verifyLayout = (
  raw: unknown,
  owned: Map<string, string>,
): PdfPrepLayout | undefined | 'bad' => {
  if (raw === undefined) return undefined;
  if (!isRecord(raw) || !Array.isArray(raw.pages)) return 'bad';

  const pages: PdfPrepLayoutPage[] = [];
  let totalLines = 0;
  let totalCrops = 0;
  for (const page of raw.pages as unknown[]) {
    if (!isRecord(page)) return 'bad';
    if (!isCount(page.page) || page.page < 1) return 'bad';
    if (!isSize(page.width) || !isSize(page.height) || !isColor(page.background)) return 'bad';
    if (!isOptional(page.textColor, isColor)) return 'bad';
    if (
      page.fontRatio !== undefined &&
      !(isCoord(page.fontRatio) && page.fontRatio > 0 && page.fontRatio < 20)
    ) {
      return 'bad';
    }
    if (page.omittedLines !== undefined && !isCount(page.omittedLines)) return 'bad';
    let fontNames: string[] | undefined;
    if (page.fontNames !== undefined) {
      if (
        !Array.isArray(page.fontNames) ||
        page.fontNames.length > 5 ||
        !page.fontNames.every((name) => typeof name === 'string' && name.length <= 60)
      ) {
        return 'bad';
      }
      fontNames = page.fontNames as string[];
    }
    if (!Array.isArray(page.lines) || page.lines.length > LAYOUT_MAX_LINES_PER_PAGE) return 'bad';
    if (!Array.isArray(page.blocks) || page.blocks.length > LAYOUT_MAX_BLOCKS_PER_PAGE)
      return 'bad';
    if (!Array.isArray(page.crops)) return 'bad';

    const lines: LayoutLine[] = [];
    for (const item of page.lines) {
      const line = verifyLine(item);
      if (!line) return 'bad';
      lines.push(line);
    }
    const blocks: LayoutBlock[] = [];
    for (const item of page.blocks) {
      const block = verifyBlock(item);
      if (!block) return 'bad';
      blocks.push(block);
    }
    const crops: PdfPrepCrop[] = [];
    for (const item of page.crops as Array<Record<string, unknown>>) {
      if (item.kind !== 'icon' && item.kind !== 'photo') return 'bad';
      if (!isCoord(item.x) || !isCoord(item.y) || !isSize(item.w) || !isSize(item.h)) return 'bad';
      if (!IMAGE_MIMES.has(item.mime as string) || !owned.has(item.fileId as string)) return 'bad';
      crops.push({
        fileId: item.fileId as string,
        h: item.h,
        kind: item.kind,
        mime: item.mime as string,
        w: item.w,
        x: item.x,
        y: item.y,
      });
    }
    totalLines += lines.length;
    totalCrops += crops.length;
    if (totalLines > LAYOUT_MAX_LINES || totalCrops > LAYOUT_MAX_CROPS) return 'bad';

    pages.push({
      background: page.background,
      blocks,
      crops,
      ...(fontNames ? { fontNames } : {}),
      ...(page.fontRatio === undefined ? {} : { fontRatio: page.fontRatio as number }),
      height: page.height,
      lines,
      ...(page.omittedLines === undefined ? {} : { omittedLines: page.omittedLines as number }),
      page: page.page,
      ...(page.textColor ? { textColor: page.textColor as string } : {}),
      width: page.width,
    });
  }
  return { pages };
};

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
        owned: async (fileIds) => {
          const rows = fileIds.length > 0 ? await fileModel.findByIds(fileIds) : [];
          return new Map(rows.map((file) => [file.id, file.url]));
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
    return { pending: true, record: await this.verify(partial) };
  }

  /** Записи подготовки уже известных файлов (для истории); ничего не запускает. */
  async peek(fileIds: string[]): Promise<Map<string, PdfPrepRecord>> {
    const records = new Map<string, PdfPrepRecord>();
    try {
      for (const [fileId, raw] of await this.store.loadMany(fileIds)) {
        const record = await this.verify(raw);
        if (record) records.set(fileId, record);
      }
    } catch (error) {
      log('peek failed: %s', errorText(error));
    }
    return records;
  }

  /**
   * Проверка записи подготовки, прочитанной из базы (см. шапку файла). Возвращает очищенную копию: только
   * известные поля нужных типов, а ключ каждой страницы взят из записи файла этого человека. Любая неправильность
   * (чужой или неизвестный fileId, не тот формат, не та версия) — `undefined`, запись не используется целиком.
   */
  private async verify(raw: unknown): Promise<PdfPrepRecord | undefined> {
    try {
      if (!isRecord(raw) || raw.version !== PDF_PREP_VERSION) return undefined;
      if (raw.status !== 'done' && raw.status !== 'failed' && raw.status !== 'processing') {
        return undefined;
      }
      const rawPages = raw.pages === undefined ? undefined : raw.pages;
      const rawImages = raw.images === undefined ? undefined : raw.images;
      if (rawPages !== undefined && !Array.isArray(rawPages)) return undefined;
      if (rawImages !== undefined && !Array.isArray(rawImages)) return undefined;

      const ids = [...(rawPages ?? []), ...(rawImages ?? [])].map((item) =>
        isRecord(item) ? item.fileId : undefined,
      );
      if (ids.some((id) => typeof id !== 'string' || id === '')) return undefined;
      const cropIds = layoutFileIds(raw.layout);
      if (!cropIds) return undefined;
      const allIds = [...(ids as string[]), ...cropIds];
      const owned = allIds.length > 0 ? await this.store.owned(allIds) : new Map<string, string>();

      const size = (item: Record<string, unknown>) =>
        isCount(item.width) && isCount(item.height) && isCount(item.page) && isCount(item.index)
          ? { height: item.height, index: item.index, page: item.page, width: item.width }
          : undefined;

      let pages: PdfPrepPage[] | undefined;
      if (rawPages) {
        pages = [];
        for (const item of rawPages as Record<string, unknown>[]) {
          const key = owned.get(item.fileId as string);
          const dims = size(item);
          if (!key || !dims || !isCount(item.total) || !IMAGE_MIMES.has(item.mime as string)) {
            return undefined;
          }
          if (!isOptional(item.fromPt, isCoord) || !isOptional(item.toPt, isCoord))
            return undefined;
          pages.push({
            ...dims,
            fileId: item.fileId as string,
            ...(item.fromPt === undefined ? {} : { fromPt: item.fromPt }),
            key,
            mime: item.mime as string,
            ...(item.toPt === undefined ? {} : { toPt: item.toPt }),
            total: item.total,
          });
        }
      }

      let images: PdfPrepImage[] | undefined;
      if (rawImages) {
        images = [];
        for (const item of rawImages as Record<string, unknown>[]) {
          const dims = size(item);
          if (!owned.has(item.fileId as string) || !dims || !IMAGE_MIMES.has(item.mime as string)) {
            return undefined;
          }
          const place = verifyPlace(item.place);
          if (place === 'bad') return undefined;
          images.push({
            ...dims,
            fileId: item.fileId as string,
            mime: item.mime as string,
            ...(place ? { place } : {}),
          });
        }
      }

      const layout = verifyLayout(raw.layout, owned);
      if (layout === 'bad') return undefined;

      return {
        error: typeof raw.error === 'string' ? raw.error.slice(0, 300) : undefined,
        finishedAt: isCount(raw.finishedAt) ? raw.finishedAt : undefined,
        images,
        layout,
        pageCount: isCount(raw.pageCount) ? raw.pageCount : undefined,
        pages,
        renderedPages: isCount(raw.renderedPages) ? raw.renderedPages : undefined,
        startedAt: isCount(raw.startedAt) ? raw.startedAt : 0,
        status: raw.status,
        version: PDF_PREP_VERSION,
      };
    } catch (error) {
      log('verify failed: %s', errorText(error));
      return undefined;
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

      // запись из базы — недоверенная: подделанная или битая считается отсутствующей, и файл готовится заново
      const prep = await this.verify(file.prep);
      if (prep) {
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

  /** Описание макета → запись: вырезки сохраняются файлами человека, места вшитых картинок дописываются. */
  private async prepareLayout(
    record: PdfPrepRecord,
    pdf: Buffer,
    rasters: NonNullable<Awaited<ReturnType<typeof renderPdfPages>>['rasters']>,
    folder: string,
    name: string,
  ) {
    const draft = await analysePdfLayout(pdf, rasters);
    if (!draft) return;

    const pages: PdfPrepLayoutPage[] = [];
    let counter = 0;
    for (const page of draft.pages) {
      const crops: PdfPrepCrop[] = [];
      for (const crop of page.crops) {
        const ext = crop.mime === 'image/jpeg' ? 'jpg' : 'png';
        const uploaded = await this.storage.upload(
          crop.buffer,
          crop.mime,
          `${folder}/${name}.crop-${pad(++counter)}.p${page.page}.${ext}`,
        );
        crops.push({
          fileId: uploaded.fileId,
          h: crop.h,
          kind: crop.kind,
          mime: crop.mime,
          w: crop.w,
          x: crop.x,
          y: crop.y,
        });
      }
      pages.push({ ...page, crops }); // crops перекрывает черновые вырезки с буферами
    }
    record.layout = { pages };

    // место вшитых картинок на странице — в список вложений («картинка 3 … стр. 1, x305 y1370 295×348»)
    if (record.images && record.images.length > 0) {
      const places = matchImagePlaces(record.images, draft.places);
      for (const image of record.images) {
        const place = places.get(image.index);
        if (place) image.place = place;
      }
    }
    log('layout → %d page(s), %d crop(s)', pages.length, counter);
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
      let rasters: Awaited<ReturnType<typeof renderPdfPages>>['rasters'];
      if (options.pageImages) {
        record.pages = [];
        try {
          // целые страницы нужны описанию макета (шаг 3): отдельно рисовать их второй раз не надо
          const rendered = await renderPdfPages(pdf, { keepRasters: options.layout });
          rasters = rendered.rasters;
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
              ...(image.fromPt === undefined ? {} : { fromPt: image.fromPt }),
              height: image.height,
              index: image.index,
              key: uploaded.key,
              mime: image.mimeType,
              page: image.page,
              ...(image.toPt === undefined ? {} : { toPt: image.toPt }),
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
          rasters = undefined;
        }
        // страницы — в базу сразу: описание макета ещё считается, а ждущий в execAgent берёт то, что записано
        await this.persist(fileId, record);
      }

      // 3. Описание макета: строки, блоки, вырезки (pdfLayout.ts); любая ошибка — описания нет
      if (options.layout && rasters && rasters.size > 0) {
        try {
          await this.prepareLayout(record, pdf, rasters, folder, name);
        } catch (error) {
          log('layout of %s failed: %s', fileId, errorText(error));
          record.layout = undefined;
        }
      }
      rasters = undefined;

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
