export const ArckepLayoutIdentifier = 'arckep-layout';

export enum ArckepLayoutApiName {
  checkLayout = 'checkLayout',
  editArtifact = 'editArtifact',
}

/** Правка «найти → заменить». */
export interface LayoutEdit {
  find: string;
  replace: string;
}

export interface CheckLayoutParams {
  /** Имя PDF с макетом, если в теме их несколько; по умолчанию — последний PDF темы с описанием макета */
  file?: string;
  /** identifier HTML-артефакта (последняя версия берётся из темы) */
  identifier: string;
}

export interface EditArtifactParams {
  /** Правки последней версии: до 30, `find` встречается в HTML ровно один раз */
  edits: LayoutEdit[];
  identifier: string;
}

/** Одна строка итогов круга сверки. */
export interface CheckRoundSummary {
  applied: number;
  note?: string;
  observations?: string;
  rejected: number;
  round: number;
  similarityAfter?: number;
  similarityBefore?: number;
  status:
    'accepted' | 'editor_failed' | 'no_edits' | 'nothing_applied' | 'render_failed' | 'rolled_back';
}

/** Состояние версии письма после сверки (до и после правок). */
export interface CheckSnapshot {
  issues: number;
  linesFound: number;
  linesTotal: number;
  similarity?: number;
}

/** Приём вёрстки, который выбросит почта (position:absolute, flex, grid, float, внешние стили, script). */
export interface TechniqueSummary {
  count: number;
  /** Кусок кода как есть (первая находка) */
  example?: string;
  kind: 'float' | 'flex' | 'grid' | 'position' | 'script' | 'stylesheet';
  label: string;
}

export interface CheckLayoutResult {
  after?: CheckSnapshot;
  before?: CheckSnapshot;
  /** Версия изменилась правками */
  changed: boolean;
  /** Имя PDF с макетом */
  file: string;
  /** Файл чата с лучшей версией */
  fileId?: string;
  identifier: string;
  /** Что правщик видел отличающимся (последний круг) */
  observations?: string;
  /** Текст ошибки, из-за которой цикл остановился раньше времени */
  problem?: string;
  /** Что осталось (расхождения одной строкой, до 12) */
  remaining: string[];
  rounds: CheckRoundSummary[];
  /** Адрес файла: `https://arckep.ru/chat/f/<id>/` */
  src?: string;
  status: 'checked' | 'unavailable';
  stopped?: 'clean' | 'editor_failed' | 'render_failed' | 'rolled_back' | 'rounds' | 'time';
  /** Готовый тег для показа версии */
  tag?: string;
  /**
   * Приёмы, которые выбросит почта: были в письме до сверки и остались в лучшей версии. Проверка локальная
   * (по тексту HTML), поэтому есть и когда отрисовка недоступна.
   */
  techniques?: { before: TechniqueSummary[]; left: TechniqueSummary[] };
  title: string;
  /** Почему сверка недоступна (`status: 'unavailable'`) */
  unavailableReason?: string;
}

export interface EditArtifactResult {
  applied: Array<{ find: string; index: number }>;
  fileId: string;
  identifier: string;
  rejected: Array<{ find: string; index: number; reason: string }>;
  src: string;
  tag: string;
  title: string;
}
