export const ArckepLayoutIdentifier = 'arckep-layout';

export enum ArckepLayoutApiName {
  checkLayout = 'checkLayout',
  editArtifact = 'editArtifact',
  renderArtifact = 'renderArtifact',
  writeArtifact = 'writeArtifact',
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

export interface WriteArtifactParams {
  /** Полный HTML-документ артефакта (содержимое внутри <lobeArtifact>, без самого тега-обёртки) */
  content: string;
  /** kebab-case identifier артефакта */
  identifier: string;
  /** Заголовок артефакта */
  title: string;
}

export interface RenderArtifactParams {
  /** identifier HTML-артефакта (последняя версия берётся из темы) */
  identifier: string;
  /** Необязательные начала ключевых текстовых строк (до 50, каждая до 60 знаков), чтобы проверить видимость и координаты */
  lines?: string[];
  /** Ширина окна просмотра в CSS px (320–1600; по умолчанию 1280; для писем 600, для мобильных 390) */
  width?: number;
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

export interface WriteArtifactResult {
  checkedScripts: number;
  fileId: string;
  identifier: string;
  sha256: string;
  src: string;
  tag: string;
  title: string;
  unverifiedParts: string[];
  verifiedParts: string[];
}

export interface RenderArtifactLine {
  fontSize?: number | null;
  fontWeight?: string | null;
  found: boolean;
  h?: number | null;
  text: string;
  x?: number | null;
  y?: number | null;
}

export interface RenderArtifactImage {
  error?: string | null;
  h: number;
  loaded: boolean;
  origin?: 'ours' | 'external' | null;
  src?: string | null;
  w: number;
  x: number;
  y: number;
}

export interface RenderArtifactFailedImage {
  origin: 'ours' | 'external';
  reason: string;
  url: string;
}

export interface RenderArtifactScreenshot {
  /** Адрес файла чата (`https://arckep.ru/chat/f/<id>/`) */
  address: string;
  bytes: number;
  fileId: string;
  height: number;
  /** Был ли снимок уменьшен относительно исходной отрисованной страницы */
  scaled: boolean;
  width: number;
}

export interface RenderArtifactResult {
  /** Номер проверки в текущем ходе (1..limit) */
  attempt?: number;
  /** Запрошенная ширина, если она вышла за 320–1600 и была ограничена */
  clampedFromWidth?: number;
  elapsedMs?: number;
  failedImages: RenderArtifactFailedImage[];
  /** Высота документа scrollHeight, px */
  height?: number;
  /** Горизонтальное переполнение в px (`Math.max(0, scrollWidth - width)`) */
  horizontalOverflowPx?: number;
  identifier: string;
  images: RenderArtifactImage[];
  imagesLoaded?: number;
  imagesTotal?: number;
  /** Потолок проверок за один ход */
  limit?: number;
  lines: RenderArtifactLine[];
  linesFound?: number;
  linesTotal?: number;
  renderer?: 'arckep_render' | 'playwright';
  renderPath?: { browser: string; sanitizer: string };
  /** Сохранённый сжатый превью-снимок (только для vision-моделей; у текстовых моделей undefined) */
  screenshot?: RenderArtifactScreenshot;
  /** Приложен ли превью-снимок для визуального осмотра моделью */
  screenshotAttached?: boolean;
  scrollWidth?: number;
  status: 'limit_reached' | 'rendered' | 'unavailable';
  title: string;
  unavailableReason?: string;
  /** Фактическая ширина окна просмотра, px */
  width?: number;
}
