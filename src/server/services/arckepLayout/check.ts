import debug from 'debug';

import { compareLayout, issueText, regression } from './compare';
import { buildEditorMessage, EDITOR_SYSTEM, type EditorPart, parseEditorReply } from './editor';
import { applyEdits, describeEdits } from './edits';
import {
  bandSimilarity,
  buildEditorPictures,
  decodePicture,
  type EditorPictures,
  type RawPicture,
} from './pictures';
import { LayoutRenderError } from './render';
import {
  detectTechniques,
  isTechniqueCheckEnabled,
  type TechniqueFinding,
  techniquesText,
  techniqueTotal,
} from './techniques';
import type { Measure, Mockup, OtherIssue, RenderResult } from './types';

const log = debug('lobe-server:arckep-layout:check');

/**
 * arckep (19.10.2026): цикл сверки письма с макетом — крутится движком вне переписки.
 *
 * Круг: правщик (отдельный короткий вызов той же модели) → правки «найти → заменить» → отрисовка → сравнение.
 * Версия принимается, только если похожесть по картинке выросла И нигде не стало хуже (нет новых расхождений в
 * строках и картинках, которые были на месте, и нет заметного роста прежних): проба 19.10 — один круг «сверить и
 * поправить» исправил названное, но сломал соседнее (+28 px ниже). Иначе откат к лучшей версии и ещё круг, с пометкой
 * правщику, что прошлые правки сделали хуже и что именно. Кругов не больше `ARCKEP_LAYOUT_CHECK_ROUNDS` (3), общий
 * бюджет времени ~240 с (`ARCKEP_LAYOUT_CHECK_BUDGET_MS`), стоп раньше при похожести ≥ 97 % и пустом списке.
 */

export const DEFAULT_ROUNDS = 3;
export const DEFAULT_BUDGET_MS = 240_000;
/** Похожесть, с которой письмо считается совпавшим (при пустом списке расхождений). */
export const CLEAN_SIMILARITY = 97;
/** Сколько ждём один круг, пока не знаем, сколько он длится на самом деле, мс. */
const FIRST_ROUND_ESTIMATE_MS = 60_000;
const MIN_ROUND_ROOM_MS = 30_000;

const intFromEnv = (name: string, fallback: number, min: number, max: number) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= min ? Math.min(Math.floor(value), max) : fallback;
};

export const checkRounds = () => intFromEnv('ARCKEP_LAYOUT_CHECK_ROUNDS', DEFAULT_ROUNDS, 1, 5);
export const checkBudgetMs = () =>
  intFromEnv('ARCKEP_LAYOUT_CHECK_BUDGET_MS', DEFAULT_BUDGET_MS, 10_000, 600_000);

export interface CheckInput {
  /** Имя PDF с макетом */
  file: string;
  /** Начальный HTML (последняя версия письма) */
  html: string;
  /** Макет как картинка 1 пт = 1 px; нет — похожесть не считается */
  mockPicture?: RawPicture;
  mockup: Mockup;
  /** Правщику показываются картинки (модель со зрением) */
  vision: boolean;
}

export interface CheckDeps {
  /** Вызов правщика: текст ответа. Ошибка модели (нет денег, сбой) — исключение. */
  askEditor: (system: string, parts: EditorPart[]) => Promise<string>;
  now?: () => number;
  /** Отрисовка: исключение `LayoutRenderError` */
  render: (html: string) => Promise<RenderResult>;
}

export type RoundStatus =
  /** версия принята */
  | 'accepted'
  /** правки применились, но стало хуже или не лучше — откат */
  | 'rolled_back'
  /** правщик не дал разбираемых правок */
  | 'no_edits'
  /** ни одна правка не применилась */
  | 'nothing_applied'
  /** ошибка отрисовки после правок */
  | 'render_failed'
  /** ошибка вызова правщика */
  | 'editor_failed';

export interface RoundLog {
  applied: number;
  elapsedMs: number;
  /** Почему откат / что не вышло */
  note?: string;
  observations?: string;
  rejected: number;
  round: number;
  similarityAfter?: number;
  similarityBefore?: number;
  status: RoundStatus;
}

export type StopReason =
  /** похожесть ≥ 97 % и список пуст */
  'clean' | 'editor_failed' | 'render_failed' | 'rounds' | 'time';

export interface CheckOutcome {
  best: Measure & { html: string };
  initial: Measure;
  /** Текст ошибки отрисовки / правщика, если цикл остановился из-за неё */
  problem?: string;
  rounds: RoundLog[];
  stopped: StopReason;
}

const percent = (value: number | undefined) =>
  value === undefined ? '—' : `${value.toFixed(1).replace('.', ',')} %`;

/** Расхождения-приёмы: первыми в списке, у каждого вида свой ключ. */
export const techniqueIssues = (findings: TechniqueFinding[]): OtherIssue[] =>
  findings.map((item) => ({
    key: `technique:${item.kind}`,
    kind: 'technique',
    text: `почта выбросит ${item.label} ×${item.count}${item.examples[0] ? ` (пример: ${item.examples[0]})` : ''}`,
    y: -1,
  }));

/** Строк письма должно остаться не меньше этой доли: уборка приёмов не должна выбросить половину письма. */
const KEEP_LINES = 0.8;

/**
 * Сравнение двух замеров: принять ли новую версию.
 *
 * Приёмы, которые выбросит почта (techniques.ts), важнее похожести: в письме Gmail и Outlook расстановка по
 * координатам разваливается, даже если на экране похоже на макет на 93,6 % (проба 19.10). Поэтому:
 * - в лучшей версии приёмов нет, а в новой появились — не принимается, как бы ни выросла похожесть;
 * - в лучшей версии приёмы есть: новая принимается, только если приёмов в ней стало строго меньше, не появилось
 *   новых видов и строк письма осталось не меньше 80 % (уборка идёт шагами, и похожесть при ней может падать);
 * - приёмы убраны совсем — принимается при тех же 80 % строк, остальное доведут следующие круги.
 * Без приёмов с обеих сторон — обычное правило: похожесть выросла и нигде не стало хуже.
 */
export const judge = (before: Measure, after: Measure): { accept: boolean; reason: string } => {
  const was = techniqueTotal(before.techniques);
  const now = techniqueTotal(after.techniques);
  if (was > 0 || now > 0) {
    const kept = after.comparison.linesFound >= before.comparison.linesFound * KEEP_LINES;
    const kinds = new Set((before.techniques ?? []).map((item) => item.kind));
    const fresh = (after.techniques ?? []).filter((item) => !kinds.has(item.kind));
    const left = techniquesText(after.techniques ?? [], false);
    if (was === 0) {
      return {
        accept: false,
        reason: `правки вернули приёмы, которые выбросит почта (${left}); они важнее похожести`,
      };
    }
    if (now >= was) {
      return {
        accept: false,
        reason: `приёмы, которые выбросит почта, не убрались (было ${was}, стало ${now})`,
      };
    }
    if (fresh.length > 0) {
      return {
        accept: false,
        reason: `появились новые приёмы, которые выбросит почта (${techniquesText(fresh, false)})`,
      };
    }
    if (!kept) {
      return {
        accept: false,
        reason: `после уборки приёмов в письме осталось слишком мало строк макета (${after.comparison.linesFound} из ${before.comparison.linesFound})`,
      };
    }
    return { accept: true, reason: '' };
  }

  const worse = regression(before.comparison, after.comparison);
  const hasSimilarity = before.similarity !== undefined && after.similarity !== undefined;
  const better = hasSimilarity
    ? after.similarity! > before.similarity!
    : after.comparison.issues.length < before.comparison.issues.length;

  const reasons: string[] = [];
  if (!better) {
    reasons.push(
      hasSimilarity
        ? `похожесть по картинке не выросла (${percent(before.similarity)} → ${percent(after.similarity)})`
        : `расхождений не стало меньше (${before.comparison.issues.length} → ${after.comparison.issues.length})`,
    );
  }
  if (worse.newKeys.length > 0) {
    const shown = after.comparison.issues
      .filter((issue) => worse.newKeys.includes(issue.key))
      .slice(0, 3)
      .map(issueText);
    reasons.push(
      `появились новые расхождения там, где было на месте (${worse.newKeys.length}): ${shown.join('; ')}`,
    );
  }
  if (worse.grown.length > 0) {
    reasons.push(`стали заметно больше прежние расхождения (${worse.grown.length})`);
  }
  return { accept: reasons.length === 0, reason: reasons.join('; ') };
};

/** Снять замер версии: отрисовка → сравнение → похожесть по картинке. */
const measure = async (
  html: string,
  input: CheckInput,
  deps: CheckDeps,
): Promise<Measure & { picture?: RawPicture }> => {
  const render = await deps.render(html);
  const techniques = isTechniqueCheckEnabled() ? detectTechniques(html) : [];
  const comparison = compareLayout(input.mockup, render);
  comparison.issues = [...techniqueIssues(techniques), ...comparison.issues];
  let similarity: number | undefined;
  let bands: number[] | undefined;
  let picture: RawPicture | undefined;
  if (render.screenshot_jpeg_base64) {
    try {
      picture = await decodePicture(
        Buffer.from(render.screenshot_jpeg_base64, 'base64'),
        input.mockup.width,
      );
      if (input.mockPicture) {
        const result = bandSimilarity(input.mockPicture, picture);
        similarity = result.average;
        bands = result.bands;
      }
    } catch (error) {
      log('screenshot was not decoded: %s', (error as Error).message);
    }
  }
  return { bands, comparison, picture, render, similarity, techniques };
};

const isClean = (value: Measure) =>
  value.comparison.issues.length === 0 &&
  (value.similarity === undefined || value.similarity >= CLEAN_SIMILARITY);

const errorText = (error: unknown) =>
  error instanceof LayoutRenderError ? error.message : (error as Error)?.message || String(error);

/**
 * Цикл сверки. Ошибка первой отрисовки — исключение (вызывающий скажет «сверка недоступна»); ошибки позже
 * останавливают цикл и оставляют лучшую версию.
 */
export const runLayoutCheck = async (
  input: CheckInput,
  deps: CheckDeps,
  options: { budgetMs?: number; rounds?: number } = {},
): Promise<CheckOutcome> => {
  const now = deps.now ?? Date.now;
  const started = now();
  const maxRounds = options.rounds ?? checkRounds();
  const budget = options.budgetMs ?? checkBudgetMs();

  const first = await measure(input.html, input, deps);
  const initial: Measure = {
    bands: first.bands,
    comparison: first.comparison,
    render: first.render,
    similarity: first.similarity,
    techniques: first.techniques,
  };
  let best = { ...first, html: input.html };
  const rounds: RoundLog[] = [];
  let failedAttempt: string | undefined;
  let stopped: StopReason = 'rounds';
  let problem: string | undefined;
  let longest = 0;

  for (let round = 1; round <= maxRounds; round++) {
    if (isClean(best)) {
      stopped = 'clean';
      break;
    }
    const left = budget - (now() - started);
    if (left < Math.max(longest || FIRST_ROUND_ESTIMATE_MS, MIN_ROUND_ROOM_MS)) {
      stopped = 'time';
      break;
    }

    const roundStart = now();
    const entry: RoundLog = {
      applied: 0,
      elapsedMs: 0,
      rejected: 0,
      round,
      similarityBefore: best.similarity,
      status: 'no_edits',
    };
    rounds.push(entry);
    const finish = () => {
      entry.elapsedMs = now() - roundStart;
      longest = Math.max(longest, entry.elapsedMs);
    };

    // 1. правщик
    let pictures: EditorPictures | undefined;
    if (input.vision && input.mockPicture && best.picture) {
      try {
        pictures = await buildEditorPictures(
          input.mockPicture,
          best.picture,
          best.comparison.issues,
          best.bands ?? [],
        );
      } catch (error) {
        log('editor pictures were not built: %s', (error as Error).message);
      }
    }
    let reply: string;
    try {
      reply = await deps.askEditor(
        EDITOR_SYSTEM,
        buildEditorMessage({
          blocks: input.mockup.blocks,
          failedAttempt,
          file: input.file,
          html: best.html,
          issues: best.comparison.issues,
          pictures,
          similarity: best.similarity,
          techniques: best.techniques,
          width: input.mockup.width,
        }),
      );
    } catch (error) {
      entry.status = 'editor_failed';
      entry.note = errorText(error);
      problem = `правщик не ответил: ${entry.note}`;
      stopped = 'editor_failed';
      finish();
      break;
    }

    const parsed = parseEditorReply(reply);
    entry.observations = parsed.observations || undefined;
    if (!parsed.edits) {
      entry.status = 'no_edits';
      entry.note = parsed.error;
      failedAttempt = undefined;
      finish();
      continue;
    }

    // 2. правки
    const edited = applyEdits(best.html, parsed.edits);
    entry.applied = edited.applied.length;
    entry.rejected = edited.rejected.length;
    if (edited.applied.length === 0 || edited.html === best.html) {
      entry.status = 'nothing_applied';
      entry.note = edited.rejected.length > 0 ? describeEdits(edited) : 'правок нет';
      failedAttempt =
        edited.rejected.length > 0
          ? `прошлые правки не применились (find не найден или не единственный):\n${describeEdits(edited)}\nБери find точно из текущего HTML ниже.`
          : undefined;
      finish();
      continue;
    }

    // 3. отрисовка и приём
    let candidate: Awaited<ReturnType<typeof measure>>;
    try {
      candidate = await measure(edited.html, input, deps);
    } catch (error) {
      entry.status = 'render_failed';
      entry.note = errorText(error);
      problem = `после правок отрисовка не удалась: ${entry.note}`;
      stopped = 'render_failed';
      finish();
      break;
    }

    entry.similarityAfter = candidate.similarity;
    const verdict = judge(best, candidate);
    if (verdict.accept) {
      entry.status = 'accepted';
      best = { ...candidate, html: edited.html };
      failedAttempt = undefined;
    } else {
      entry.status = 'rolled_back';
      entry.note = verdict.reason;
      failedAttempt = `прошлые правки сделали хуже и откачены (${verdict.reason}). Не повторяй их: найди другую причину.`;
    }
    finish();
  }

  if (stopped === 'rounds' && isClean(best)) stopped = 'clean';

  return {
    best: { ...best, picture: undefined } as CheckOutcome['best'],
    initial,
    problem,
    rounds,
    stopped,
  };
};
