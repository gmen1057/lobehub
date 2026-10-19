import type { TechniqueFinding } from './techniques';

/**
 * arckep (19.10.2026): сверка письма с макетом (этап C-2) — общие типы.
 *
 * Модель пишет HTML один раз и зовёт `checkLayout`; движок сам крутит круги вне переписки: отрисовка (бэкенд
 * студии, `POST /api/chat/layout-render`) → сравнение с описанием макета → короткий вызов правщика → правки
 * «найти → заменить» → снова отрисовка. Здесь — формы данных между частями.
 */

/** Прямоугольник на странице, пункты макета (= px письма при ширине в одну точку на px). */
export interface Rect {
  h: number;
  w: number;
  x: number;
  y: number;
}

// ---- Ответ бэкенда (backend/app/schemas/layout_render.py) ----

export interface RenderLine {
  font_size?: number | null;
  font_weight?: string | null;
  found: boolean;
  /** Высота рамки первых знаков, px */
  h?: number | null;
  text: string;
  x?: number | null;
  y?: number | null;
}

export interface RenderImage {
  error?: string | null;
  h: number;
  loaded: boolean;
  origin?: 'ours' | 'external' | null;
  src?: string | null;
  w: number;
  x: number;
  y: number;
}

export interface RenderFailedImage {
  origin: 'ours' | 'external';
  reason: string;
  url: string;
}

export interface RenderResult {
  elapsed_ms?: number;
  failed_images: RenderFailedImage[];
  /** Высота документа, px */
  height: number;
  images: RenderImage[];
  lines: RenderLine[];
  /** Полный снимок страницы, JPEG в base64 */
  screenshot_jpeg_base64: string;
  scroll_width: number;
  /** Ширина окна, px */
  width: number;
}

// ---- Макет (из записи подготовки PDF) ----

export interface MockupLine {
  bold?: boolean;
  center?: boolean;
  size: number;
  text: string;
  w: number;
  x: number;
  y: number;
}

export interface MockupCrop extends Rect {
  kind: 'icon' | 'photo';
  /** Как зовут вырезку в блоке `<layout>`: «фото 2», «значок 5» */
  label: string;
  /** Устойчивый адрес (файл человека): `https://arckep.ru/chat/f/<id>/` */
  url: string;
}

export interface MockupBlock extends Rect {
  color: string;
  kind: 'fill' | 'frame' | 'line';
}

/** Макет для сверки: числа в точках страницы, страницы (если их несколько) поставлены друг под другом. */
export interface Mockup {
  blocks: MockupBlock[];
  crops: MockupCrop[];
  /** Высота макета, пт */
  height: number;
  lines: MockupLine[];
  /** Ширина окна, в котором рисуется письмо, px (колонка содержимого, а не вся страница) */
  width: number;
}

// ---- Расхождения ----

export interface LineIssue {
  /** Смещение по x, px (нет — в пределах допуска или строка «по центру») */
  dx?: number;
  /** Смещение по высоте относительно самого частого сдвига, px */
  dy?: number;
  index: number;
  key: string;
  kind: 'line';
  /** Строки нет в письме */
  missing?: boolean;
  mock: { size: number; text: string; w: number; x: number; y: number };
  render?: { h: number; size: number; x: number; y: number };
  /** Размер шрифта в письме, если он отличается */
  size?: number;
}

export interface ImageIssue {
  index: number;
  key: string;
  kind: 'image';
  label: string;
  /** Картинки на этом месте или с этим адресом нет */
  missing?: boolean;
  mock: Rect;
  render?: Rect;
}

export interface OtherIssue {
  key: string;
  /** `technique` — приём вёрстки, который выбросит почта (techniques.ts): расхождение первого ряда */
  kind: 'broken' | 'overflow' | 'technique';
  text: string;
  /** Верх места на странице, если оно известно */
  y?: number;
}

export type Issue = ImageIssue | LineIssue | OtherIssue;

export interface Comparison {
  /** Самый частый сдвиг по высоте «верх строки в письме − верх строки в макете», px */
  dy0: number;
  issues: Issue[];
  /** Сколько строк нашлось и сколько всего */
  linesFound: number;
  linesTotal: number;
  /** Ширина документа вышла за окно */
  overflow: boolean;
  /** Высота письма, px */
  renderHeight: number;
}

/** Замер одной версии письма. */
export interface Measure {
  /** Похожесть каждой полосы по 400 пт, % */
  bands?: number[];
  comparison: Comparison;
  render: RenderResult;
  /** Средняя похожесть по полосам, % (нет картинки макета или снимка — `undefined`) */
  similarity?: number;
  /** Приёмы вёрстки, которые выбросит почта (position:absolute, flex…) */
  techniques?: TechniqueFinding[];
}

/** Правка «найти → заменить». */
export interface Edit {
  find: string;
  replace: string;
}
