import type {
  CheckLayoutParams,
  CheckLayoutResult,
  CheckSnapshot,
  EditArtifactParams,
  EditArtifactResult,
  RenderArtifactParams,
  RenderArtifactResult,
  RenderArtifactScreenshot,
  TechniqueSummary,
  WriteArtifactParams,
  WriteArtifactResult,
} from '@lobechat/builtin-tool-arckep-layout';
import debug from 'debug';

import type { PdfPrepRecord } from '../aiAgent/pdfPrepare';
import { artifactTag, type ArtifactVersion, collectHtmlVersions } from './artifacts';
import { type CheckDeps, type CheckOutcome, runLayoutCheck } from './check';
import { issueSeverity, issueText, issueY } from './compare';
import type { EditorPart } from './editor';
import { applyEdits, describeEdits } from './edits';
import {
  computeHtmlSha256,
  formatHtmlSyntaxDiagnostics,
  validateHtmlArtifactSyntax,
} from './htmlSyntax';
import { buildMockup, loadMockPicture, type ReadFile } from './mockup';
import { preparePreviewScreenshot } from './pictures';
import { LayoutRenderError, type RenderParams } from './render';
import { detectTechniques, isTechniqueCheckEnabled, type TechniqueFinding } from './techniques';
import type { Measure, RenderResult } from './types';

const log = debug('lobe-server:arckep-layout');

/**
 * arckep (19.10.2026): инструменты `checkLayout` и `editArtifact` — логика без привязки к базе и сети (всё внешнее
 * приходит через `LayoutServiceDeps`, рабочая сборка — deps.ts). Подробности устройства — CLAUDE-arckep.md,
 * раздел «Сверка письма с макетом».
 */

/** Ожидаемая неудача с понятным текстом для модели (нет такого артефакта, нет макета…) — не сбой движка. */
export class LayoutToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LayoutToolError';
  }
}

export interface TopicPdf {
  id: string;
  name: string;
}

export interface LayoutServiceDeps {
  /** Адрес файла человека для тега и вырезок: `https://arckep.ru/chat/f/<id>/` */
  address: (fileId: string) => string;
  /** Сообщения темы с тегами артефактов (ответы ассистента и результаты инструмента сверки), от старых к новым */
  artifactMessages: (topicId: string) => Promise<Array<{ content: string | null; id: string }>>;
  /** Правщик: тот же поставщик и модель, что в ходе; ответ — текст */
  askEditor: (params: {
    model: string;
    parentMessageId?: string;
    parts: EditorPart[];
    provider: string;
    system: string;
    topicId: string;
  }) => Promise<string>;
  /** Строгая проверка зрения для renderArtifact: true только если abilities.vision === true (защита текстовых/legacy моделей от 400). */
  modelHasStrictVision?: (model: string, provider: string) => Promise<boolean>;
  modelHasVision: (model: string, provider: string) => Promise<boolean>;
  /** Запись подготовки PDF с описанием макета (ждёт, если файл ещё готовится); нет записи — `undefined` */
  prepRecord: (fileId: string) => Promise<PdfPrepRecord | undefined>;
  readChatFileText: (fileId: string) => Promise<string | undefined>;
  readStorage: ReadFile;
  /** Сколько вызовов renderArtifact уже было в текущем ходе (после последнего сообщения пользователя) */
  recentRenderCount?: (topicId: string) => Promise<number>;
  render: (params: RenderParams) => Promise<RenderResult>;
  /** Сохранить HTML файлом чата человека; адрес — `address(fileId)` */
  saveHtml: (html: string, name: string) => Promise<{ address: string; fileId: string }>;
  /** Сохранить сжатый JPEG-снимок рендера файлом чата для vision-модели */
  savePreviewImage?: (buffer: Buffer, name: string) => Promise<{ address: string; fileId: string }>;
  /** Номер человека в студии */
  studioUserId: () => Promise<number>;
  /** PDF темы, от новых к старым */
  topicPdfs: (topicId: string) => Promise<TopicPdf[]>;
  /** Модель и поставщик хода (из записи сообщения ассистента) */
  turnModel: (parentMessageId?: string) => Promise<{ model: string; provider: string } | undefined>;
}

export interface LayoutToolContext {
  parentMessageId?: string;
  topicId?: string;
  userId?: string;
}

/** Файл версии больше этого экран студии по ссылке не покажет (SOURCE_MAX_BYTES в студии). */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** Предел длины HTML для POST /api/chat/layout-render (MAX_HTML_CHARS в backend/app/schemas/layout_render.py). */
export const MAX_RENDER_HTML_CHARS = 500_000;
export const DEFAULT_RENDER_WIDTH = 1280;
export const MIN_RENDER_WIDTH = 320;
export const MAX_RENDER_WIDTH = 1600;
export const MAX_RENDER_LINES = 50;
export const MAX_RENDER_LINE_CHARS = 60;
export const DEFAULT_MAX_RENDERS_PER_TURN = 3;

export const maxRendersPerTurn = (): number => {
  const value = Number(process.env.ARCKEP_LAYOUT_MAX_RENDERS_PER_TURN);
  return Number.isFinite(value) && value >= 1
    ? Math.min(Math.floor(value), 5)
    : DEFAULT_MAX_RENDERS_PER_TURN;
};

/**
 * In-process защита от обхода лимита в параллельной пачке `call_tools_batch` (где `Promise.all`
 * запускает несколько `renderArtifact` до записи `message_plugins` в PostgreSQL).
 */
interface BatchSlotState {
  at: number;
  baselineDbPrior: number;
  completed: number;
}

interface ActiveRenderSlot {
  /** Завершённые в рамках одной пачки (`parentMessageId`) рендеры, пока DB-строка ещё не записана */
  batches: Map<string, BatchSlotState>;
  inFlight: number;
  tail: Promise<void>;
}

const BATCH_SLOT_TTL_MS = 60_000;
const activeRenderSlots = new Map<string, ActiveRenderSlot>();

/** Сброс in-process слотов (только для тестов). */
export const resetRenderSlotsForTests = () => {
  activeRenderSlots.clear();
};

const pruneBatches = (slot: ActiveRenderSlot, now: number) => {
  for (const [parentId, entry] of slot.batches) {
    if (now - entry.at > BATCH_SLOT_TTL_MS) slot.batches.delete(parentId);
  }
};

const tryReserveRenderSlot = async (
  key: string,
  parentMessageId: string | undefined,
  readDbPrior: () => Promise<number>,
  limit: number,
): Promise<{ allowed: boolean; attempt: number }> => {
  let slot = activeRenderSlots.get(key);
  if (!slot) {
    slot = { batches: new Map(), inFlight: 0, tail: Promise.resolve() };
    activeRenderSlots.set(key, slot);
  }

  let releaseMutex!: () => void;
  const prev = slot.tail;
  const next = new Promise<void>((resolve) => {
    releaseMutex = resolve;
  });
  slot.tail = prev.then(() => next);
  await prev;

  try {
    const now = Date.now();
    pruneBatches(slot, now);
    const dbPrior = await readDbPrior();
    let batchEntry = parentMessageId ? slot.batches.get(parentMessageId) : undefined;
    if (parentMessageId && !batchEntry) {
      batchEntry = { at: now, baselineDbPrior: dbPrior, completed: 0 };
      slot.batches.set(parentMessageId, batchEntry);
    }
    const batchTotal = batchEntry ? batchEntry.baselineDbPrior + batchEntry.completed : 0;
    const effectivePrior = Math.max(dbPrior, batchTotal) + slot.inFlight;
    if (effectivePrior >= limit) {
      return { allowed: false, attempt: limit };
    }
    slot.inFlight += 1;
    return { allowed: true, attempt: effectivePrior + 1 };
  } finally {
    releaseMutex();
    if (slot.inFlight === 0 && slot.batches.size === 0) {
      activeRenderSlots.delete(key);
    }
  }
};

const releaseRenderSlot = (
  key: string,
  parentMessageId: string | undefined,
  countCompleted: boolean,
) => {
  const slot = activeRenderSlots.get(key);
  if (!slot) return;
  slot.inFlight = Math.max(0, slot.inFlight - 1);
  const now = Date.now();
  pruneBatches(slot, now);
  if (countCompleted && parentMessageId) {
    const existing = slot.batches.get(parentMessageId);
    if (existing) {
      existing.at = now;
      existing.completed += 1;
    } else {
      slot.batches.set(parentMessageId, { at: now, baselineDbPrior: 0, completed: 1 });
    }
  }
  if (slot.inFlight === 0 && slot.batches.size === 0) {
    activeRenderSlots.delete(key);
  }
};

interface LatestArtifact {
  html: string;
  identifier: string;
  title: string;
  /** Сколько версий этого артефакта уже было в теме */
  versions: number;
}

const fileName = (
  identifier: string,
  kind: 'check' | 'edit' | 'preview' | 'write',
  n: number,
  ext: 'html' | 'jpg' = 'html',
) => {
  const safe = identifier
    .replaceAll(/[^\w-]/g, '-')
    .slice(0, 60)
    .replaceAll(/^-+|-+$/g, '');
  return `${safe || 'artifact'}-${kind}-${n}.${ext}`;
};

const techniqueSummary = (findings: TechniqueFinding[] | undefined): TechniqueSummary[] =>
  (findings ?? []).map((item) => ({
    count: item.count,
    example: item.examples[0],
    kind: item.kind,
    label: item.label,
  }));

const snapshot = (value: Measure): CheckSnapshot => ({
  issues: value.comparison.issues.length,
  linesFound: value.comparison.linesFound,
  linesTotal: value.comparison.linesTotal,
  similarity: value.similarity,
});

/** Главные расхождения для ответа модели: самые большие, показаны сверху вниз. */
const topRemaining = (value: Measure, limit = 12): string[] =>
  value.comparison.issues
    .filter((issue) => issue.kind !== 'technique')
    .sort((a, b) => issueSeverity(b) - issueSeverity(a))
    .slice(0, limit)
    .sort((a, b) => (issueY(a) ?? Infinity) - (issueY(b) ?? Infinity))
    .map(issueText);

export class ArckepLayoutService {
  constructor(
    private readonly deps: LayoutServiceDeps,
    private readonly ctx: LayoutToolContext,
    private readonly options: { budgetMs?: number; rounds?: number } = {},
  ) {}

  private requireTopic(): string {
    if (!this.ctx.topicId) throw new LayoutToolError('нет темы чата: сверка работает внутри темы');
    return this.ctx.topicId;
  }

  /** Последняя версия HTML-артефакта темы (тело или файл по `src`). */
  private async latest(identifier: string): Promise<LatestArtifact> {
    const topicId = this.requireTopic();
    const messages = await this.deps.artifactMessages(topicId);
    const all = collectHtmlVersions(messages);
    const usable = (version: ArtifactVersion) =>
      version.body !== undefined || version.srcFileId !== undefined;
    const same = all.filter((version) => version.identifier === identifier && usable(version));
    if (same.length === 0) {
      const known = [...new Set(all.filter(usable).map((version) => version.identifier))];
      throw new LayoutToolError(
        known.length > 0
          ? `в теме нет HTML-артефакта «${identifier}». Есть: ${known.map((id) => `«${id}»`).join(', ')}.`
          : `в теме нет HTML-артефакта «${identifier}» (тег <lobeArtifact type="text/html" …>).`,
      );
    }
    const last = same.at(-1)!;
    let html = last.body;
    if (html === undefined) {
      html = await this.deps.readChatFileText(last.srcFileId!);
      if (html === undefined) {
        throw new LayoutToolError(
          `не удалось прочитать файл последней версии «${identifier}» (/chat/f/${last.srcFileId}/): файл не найден, не ваш или больше 2 МБ.`,
        );
      }
    }
    const title = [...same].reverse().find((version) => version.title)?.title ?? identifier;
    return { html, identifier, title, versions: same.length };
  }

  /** PDF темы с описанием макета: по имени или последний. */
  private async resolveMockup(
    file: string | undefined,
  ): Promise<{ name: string; record: PdfPrepRecord }> {
    const topicId = this.requireTopic();
    const pdfs = await this.deps.topicPdfs(topicId);
    if (pdfs.length === 0) {
      throw new LayoutToolError('в теме нет PDF-макета: сверять не с чем.');
    }
    const wanted = file?.trim().toLowerCase();
    let byName = pdfs;
    if (wanted) {
      const exact = pdfs.filter((pdf) => pdf.name.toLowerCase() === wanted);
      byName =
        exact.length > 0 ? exact : pdfs.filter((pdf) => pdf.name.toLowerCase().includes(wanted));
    }
    if (byName.length === 0) {
      throw new LayoutToolError(
        `в теме нет PDF «${file}». Есть: ${pdfs.map((pdf) => `«${pdf.name}»`).join(', ')}.`,
      );
    }
    for (const pdf of byName.slice(0, 5)) {
      const record = await this.deps.prepRecord(pdf.id);
      if (record?.layout && record.layout.pages.length > 0) return { name: pdf.name, record };
    }
    throw new LayoutToolError(
      `у ${byName.length > 1 ? 'этих PDF' : `PDF «${byName[0].name}»`} нет описания макета: оно делается для макетов — страниц с блоками, значками и картинками (у обычного текстового PDF его нет) или ещё не готово.`,
    );
  }

  /** `editArtifact`: правки последней версии, результат — файл чата и тег. */
  async editArtifact(params: EditArtifactParams): Promise<EditArtifactResult> {
    const latest = await this.latest(params.identifier);
    const edited = applyEdits(latest.html, params.edits);
    if (edited.applied.length === 0) {
      throw new LayoutToolError(
        `ни одна правка не применилась, версия не менялась:\n${describeEdits(edited)}\nВозьми find точно из текущего HTML, кусок должен встречаться ровно один раз.`,
      );
    }
    const syntax = validateHtmlArtifactSyntax(edited.html);
    if (!syntax.valid) {
      throw new LayoutToolError(
        `${formatHtmlSyntaxDiagnostics(syntax, latest.identifier)}\nВерсия «${latest.identifier}» не перезаписана (предыдущая рабочая копия сохранена). Исправь синтаксис в правках и вызови editArtifact повторно.`,
      );
    }
    const saved = await this.save(
      edited.html,
      fileName(latest.identifier, 'edit', latest.versions + 1),
    );
    return {
      applied: edited.applied.map(({ find, index }) => ({ find, index })),
      fileId: saved.fileId,
      identifier: latest.identifier,
      rejected: edited.rejected,
      src: saved.address,
      tag: artifactTag({ identifier: latest.identifier, src: saved.address, title: latest.title }),
      title: latest.title,
    };
  }

  /** `writeArtifact`: синтаксическая проверка HTML + всех встроенных `<script>` до сохранения в файл чата. */
  async writeArtifact(params: WriteArtifactParams): Promise<WriteArtifactResult> {
    const topicId = this.requireTopic();
    const identifier = params.identifier?.trim();
    const title = params.title?.trim();
    const content = params.content;
    if (!identifier || !title || typeof content !== 'string' || !content.trim()) {
      throw new LayoutToolError(
        'writeArtifact: нужны непустые identifier, title и content (HTML-документ).',
      );
    }
    const syntax = validateHtmlArtifactSyntax(content);
    if (!syntax.valid) {
      throw new LayoutToolError(formatHtmlSyntaxDiagnostics(syntax, identifier));
    }
    const messages = await this.deps.artifactMessages(topicId);
    const versions = collectHtmlVersions(messages).filter(
      (version) =>
        version.identifier === identifier &&
        (version.body !== undefined || version.srcFileId !== undefined),
    ).length;
    const saved = await this.save(content, fileName(identifier, 'write', versions + 1));
    return {
      checkedScripts: syntax.checkedScripts,
      fileId: saved.fileId,
      identifier,
      sha256: computeHtmlSha256(content),
      src: saved.address,
      tag: artifactTag({ identifier, src: saved.address, title }),
      title,
      unverifiedParts: syntax.unverifiedParts,
      verifiedParts: syntax.verifiedParts,
    };
  }

  private async save(html: string, name: string) {
    if (Buffer.byteLength(html, 'utf8') > MAX_FILE_BYTES) {
      throw new LayoutToolError(
        'письмо больше 2 МБ — по ссылке его показать нельзя, сократите HTML.',
      );
    }
    return this.deps.saveHtml(html, name);
  }

  /** `checkLayout`: сверка с макетом и круги правки вне переписки. */
  async checkLayout(params: CheckLayoutParams): Promise<CheckLayoutResult> {
    const topicId = this.requireTopic();
    const latest = await this.latest(params.identifier);
    const mock = await this.resolveMockup(params.file);
    const mockup = buildMockup(mock.record, this.deps.address);
    if (!mockup)
      throw new LayoutToolError(`в описании макета «${mock.name}» нет строк и картинок.`);

    const userId = await this.deps.studioUserId();
    const turn = await this.deps.turnModel(this.ctx.parentMessageId);
    const vision = turn ? await this.deps.modelHasVision(turn.model, turn.provider) : false;
    let mockPicture;
    try {
      mockPicture = await loadMockPicture(mock.record, this.deps.readStorage, mockup.width);
    } catch (error) {
      console.warn(
        `[arckep-layout] topic=${topicId} user=${this.ctx.userId}: макет картинкой не собран: ${(error as Error).message}`,
      );
    }

    const checkDeps: CheckDeps = {
      askEditor: async (system, parts) => {
        if (!turn) throw new Error('не известны модель и поставщик этого хода');
        return this.deps.askEditor({
          model: turn.model,
          parentMessageId: this.ctx.parentMessageId,
          parts,
          provider: turn.provider,
          system,
          topicId,
        });
      },
      render: (html) =>
        this.deps.render({
          html,
          lines: mockup.lines.map((line) => line.text),
          messageId: this.ctx.parentMessageId,
          topicId,
          userId,
          width: mockup.width,
        }),
    };

    const base = { file: mock.name, identifier: latest.identifier, title: latest.title };
    let outcome: CheckOutcome;
    try {
      outcome = await runLayoutCheck(
        { file: mock.name, html: latest.html, mockPicture, mockup, vision },
        checkDeps,
        this.options,
      );
    } catch (error) {
      if (error instanceof LayoutRenderError) {
        console.warn(
          `[arckep-layout] topic=${topicId} user=${this.ctx.userId}: сверка недоступна (${error.kind}): ${error.message}`,
        );
        return {
          ...base,
          changed: false,
          remaining: [],
          rounds: [],
          status: 'unavailable',
          // проверка приёмов вёрстки — по тексту HTML, отрисовка ей не нужна
          techniques: {
            before: techniqueSummary(
              isTechniqueCheckEnabled() ? detectTechniques(latest.html) : [],
            ),
            left: techniqueSummary(isTechniqueCheckEnabled() ? detectTechniques(latest.html) : []),
          },
          unavailableReason: error.message,
        };
      }
      throw error;
    }

    if (outcome.problem) {
      console.warn(
        `[arckep-layout] topic=${topicId} user=${this.ctx.userId}: цикл остановлен (${outcome.stopped}): ${outcome.problem}`,
      );
    }
    log(
      'check done topic=%s rounds=%d stopped=%s',
      topicId,
      outcome.rounds.length,
      outcome.stopped,
    );

    const saved = await this.save(
      outcome.best.html,
      fileName(latest.identifier, 'check', latest.versions + 1),
    );
    const observations = [...outcome.rounds]
      .reverse()
      .find((round) => round.observations)?.observations;
    return {
      ...base,
      after: snapshot(outcome.best),
      before: snapshot(outcome.initial),
      changed: outcome.best.html !== latest.html,
      fileId: saved.fileId,
      observations,
      problem: outcome.problem,
      remaining: topRemaining(outcome.best),
      rounds: outcome.rounds.map((round) => ({
        applied: round.applied,
        note: round.note,
        rejected: round.rejected,
        round: round.round,
        similarityAfter: round.similarityAfter,
        similarityBefore: round.similarityBefore,
        status: round.status,
      })),
      src: saved.address,
      status: 'checked',
      stopped: outcome.stopped,
      techniques: {
        before: techniqueSummary(outcome.initial.techniques),
        left: techniqueSummary(outcome.best.techniques),
      },
      tag: artifactTag({ identifier: latest.identifier, src: saved.address, title: latest.title }),
    };
  }

  /**
   * `renderArtifact`: визуальная проверка HTML-артефакта в headless Chromium (`POST /api/chat/layout-render`)
   * без привязки к PDF-макету. Возвращает геометрию/переполнение/картинки/строки; сжатый превью-снимок
   * прикладывается ТОЛЬКО для моделей с подтверждённой поддержкой vision (текстовые модели получают чистые метрики).
   * Никогда не изменяет и не скрывает уже созданный артефакт.
   */
  async renderArtifact(params: RenderArtifactParams): Promise<RenderArtifactResult> {
    const topicId = this.requireTopic();
    const latest = await this.latest(params.identifier);
    const limit = maxRendersPerTurn();
    const base = { identifier: latest.identifier, title: latest.title };

    if (latest.html.length > MAX_RENDER_HTML_CHARS) {
      return {
        ...base,
        failedImages: [],
        images: [],
        lines: [],
        status: 'unavailable',
        unavailableReason: `HTML длиннее ${MAX_RENDER_HTML_CHARS} знаков — отрисовка не поддерживается`,
      };
    }

    const slotKey = `${this.ctx.userId ?? ''}:${topicId}`;
    const reservation = await tryReserveRenderSlot(
      slotKey,
      this.ctx.parentMessageId,
      () =>
        this.deps.recentRenderCount ? this.deps.recentRenderCount(topicId) : Promise.resolve(0),
      limit,
    );

    if (!reservation.allowed) {
      return {
        ...base,
        attempt: reservation.attempt,
        failedImages: [],
        images: [],
        limit,
        lines: [],
        status: 'limit_reached',
      };
    }

    let countCompleted = false;
    try {
      let width = DEFAULT_RENDER_WIDTH;
      let clampedFromWidth: number | undefined;
      if (typeof params.width === 'number' && Number.isFinite(params.width)) {
        const rounded = Math.round(params.width);
        if (rounded < MIN_RENDER_WIDTH || rounded > MAX_RENDER_WIDTH) {
          clampedFromWidth = rounded;
          width = Math.min(MAX_RENDER_WIDTH, Math.max(MIN_RENDER_WIDTH, rounded));
        } else {
          width = rounded;
        }
      }

      const lines = Array.isArray(params.lines)
        ? params.lines
            .filter((item): item is string => typeof item === 'string')
            .map((item) => item.trim().slice(0, MAX_RENDER_LINE_CHARS))
            .filter(Boolean)
            .slice(0, MAX_RENDER_LINES)
        : [];

      const userId = await this.deps.studioUserId();
      let rendered: RenderResult;
      try {
        rendered = await this.deps.render({
          html: latest.html,
          lines,
          messageId: this.ctx.parentMessageId,
          topicId,
          userId,
          width,
        });
      } catch (error) {
        if (error instanceof LayoutRenderError) {
          countCompleted = true;
          console.warn(
            `[arckep-layout] renderArtifact topic=${topicId} user=${this.ctx.userId}: недоступно (${error.kind}): ${error.message}`,
          );
          return {
            ...base,
            failedImages: [],
            images: [],
            lines: [],
            status: 'unavailable',
            unavailableReason: error.message,
          };
        }
        throw error;
      }

      countCompleted = true;
      const turn = await this.deps.turnModel(this.ctx.parentMessageId);
      const canSee = turn
        ? this.deps.modelHasStrictVision
          ? await this.deps.modelHasStrictVision(turn.model, turn.provider)
          : await this.deps.modelHasVision(turn.model, turn.provider)
        : false;

      let screenshot: RenderArtifactScreenshot | undefined;
      if (canSee && rendered.screenshot_jpeg_base64 && this.deps.savePreviewImage) {
        try {
          const raw = Buffer.from(rendered.screenshot_jpeg_base64, 'base64');
          const prepared = await preparePreviewScreenshot(raw);
          const saved = await this.deps.savePreviewImage(
            prepared.buffer,
            fileName(latest.identifier, 'preview', latest.versions + 1, 'jpg'),
          );
          screenshot = {
            address: saved.address,
            bytes: prepared.buffer.byteLength,
            fileId: saved.fileId,
            height: prepared.height,
            scaled: prepared.scaled,
            width: prepared.width,
          };
        } catch (error) {
          console.warn(
            `[arckep-layout] renderArtifact topic=${topicId} user=${this.ctx.userId}: превью-снимок не сохранён: ${(error as Error).message}`,
          );
        }
      }

      const mappedLines = rendered.lines.map((line) => ({
        fontSize: line.font_size ?? null,
        fontWeight: line.font_weight ?? null,
        found: Boolean(line.found),
        h: line.h ?? null,
        text: line.text,
        x: line.x ?? null,
        y: line.y ?? null,
      }));
      const mappedImages = rendered.images.map((image) => ({
        error: image.error ?? null,
        h: image.h,
        loaded: Boolean(image.loaded),
        origin: image.origin ?? null,
        src: image.src ?? null,
        w: image.w,
        x: image.x,
        y: image.y,
      }));
      const horizontalOverflowPx = Math.max(0, rendered.scroll_width - rendered.width);

      log(
        'renderArtifact done topic=%s id=%s %dx%d scrollW=%d overflow=%d vision=%s screenshot=%s',
        topicId,
        latest.identifier,
        rendered.width,
        rendered.height,
        rendered.scroll_width,
        horizontalOverflowPx,
        canSee,
        Boolean(screenshot),
      );

      return {
        ...base,
        attempt: reservation.attempt,
        ...(clampedFromWidth !== undefined ? { clampedFromWidth } : {}),
        elapsedMs: rendered.elapsed_ms,
        failedImages: rendered.failed_images,
        height: rendered.height,
        horizontalOverflowPx,
        images: mappedImages,
        imagesLoaded: mappedImages.filter((item) => item.loaded).length,
        imagesTotal: mappedImages.length,
        limit,
        lines: mappedLines,
        linesFound: mappedLines.filter((item) => item.found).length,
        linesTotal: mappedLines.length,
        ...(rendered.render_path ? { renderPath: rendered.render_path } : {}),
        ...(rendered.renderer ? { renderer: rendered.renderer } : {}),
        ...(screenshot ? { screenshot } : {}),
        screenshotAttached: Boolean(screenshot),
        scrollWidth: rendered.scroll_width,
        status: 'rendered',
        width: rendered.width,
      };
    } finally {
      releaseRenderSlot(slotKey, this.ctx.parentMessageId, countCompleted);
    }
  }
}
