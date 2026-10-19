import type {
  CheckLayoutParams,
  CheckLayoutResult,
  CheckSnapshot,
  EditArtifactParams,
  EditArtifactResult,
  TechniqueSummary,
} from '@lobechat/builtin-tool-arckep-layout';
import debug from 'debug';

import type { PdfPrepRecord } from '../aiAgent/pdfPrepare';
import { artifactTag, type ArtifactVersion, collectHtmlVersions } from './artifacts';
import { type CheckDeps, type CheckOutcome, runLayoutCheck } from './check';
import { issueSeverity, issueText, issueY } from './compare';
import type { EditorPart } from './editor';
import { applyEdits, describeEdits } from './edits';
import { buildMockup, loadMockPicture, type ReadFile } from './mockup';
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
  modelHasVision: (model: string, provider: string) => Promise<boolean>;
  /** Запись подготовки PDF с описанием макета (ждёт, если файл ещё готовится); нет записи — `undefined` */
  prepRecord: (fileId: string) => Promise<PdfPrepRecord | undefined>;
  readChatFileText: (fileId: string) => Promise<string | undefined>;
  readStorage: ReadFile;
  render: (params: RenderParams) => Promise<RenderResult>;
  /** Сохранить HTML файлом чата человека; адрес — `address(fileId)` */
  saveHtml: (html: string, name: string) => Promise<{ address: string; fileId: string }>;
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

interface LatestArtifact {
  html: string;
  identifier: string;
  title: string;
  /** Сколько версий этого артефакта уже было в теме */
  versions: number;
}

const fileName = (identifier: string, kind: 'check' | 'edit', n: number) => {
  const safe = identifier
    .replaceAll(/[^\w-]/g, '-')
    .slice(0, 60)
    .replaceAll(/^-+|-+$/g, '');
  return `${safe || 'artifact'}-${kind}-${n}.html`;
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
}
