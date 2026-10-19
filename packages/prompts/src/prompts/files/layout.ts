/**
 * arckep (19.10.2026): описание макета PDF для модели — блок `<layout>` в `<files_info>` после `<attachments>`.
 *
 * Люди присылают макет письма или страницы в PDF и просят сверстать HTML «точно по макету». Текстового слоя и
 * картинок страницы для этого мало: модель верстала на глаз (не те картинки не на своих местах, значки заменяла
 * текстом, шрифты выходили мельче). Описание снимает с файла программа (движок: pdfLayout.ts): строки текста с
 * координатами и размерами, блоки с цветами и скруглениями, адреса вырезок картинок и значков с их местами.
 * Ручная проба с таким описанием подняла похожесть результата с макетом с 63,5 % до 89,3 %.
 *
 * Данные приходят готовыми (из записи подготовки файла), здесь только текст. Сам текст описания нигде не
 * сохраняется: он собирается заново при каждом ходе, в metadata сообщения лежит только список вложений.
 */

export interface LayoutLine {
  bold?: boolean;
  center?: boolean;
  /** Цвет текста, если он не основной на странице */
  color?: string;
  link?: string;
  size: number;
  text: string;
  w: number;
  x: number;
  y: number;
}

export interface LayoutBlock {
  color: string;
  h: number;
  kind: 'fill' | 'frame' | 'line';
  /** Скругления ↖ ↗ ↘ ↙, пт; -1 — угол закрыт чем-то другим */
  radii?: [number, number, number, number];
  thickness?: number;
  w: number;
  x: number;
  y: number;
}

export interface LayoutCrop {
  h: number;
  kind: 'icon' | 'photo';
  /** Устойчивый адрес вырезки (файл человека) */
  url: string;
  w: number;
  x: number;
  y: number;
}

export interface LayoutPage {
  background: string;
  blocks: LayoutBlock[];
  crops: LayoutCrop[];
  /** Названия шрифтов из файла (если сохранились) */
  fontNames?: string[];
  /** Ширина строк в PDF / ширина тех же строк в Arial, медиана */
  fontRatio?: number;
  height: number;
  lines: LayoutLine[];
  /** Строк было больше предела, в записи не сохранены */
  omittedLines?: number;
  page: number;
  /** Основной цвет текста */
  textColor?: string;
  width: number;
}

export interface LayoutInfo {
  file: string;
  /** Сколько страниц в файле */
  pageCount?: number;
  /**
   * У модели есть картинки страниц (модель со зрением, страницы нарисованы). По умолчанию да. Нет — описание для неё
   * единственный способ «увидеть» макет, и в нём так и сказано.
   */
  pageImages?: boolean;
  pages: LayoutPage[];
}

/** Предел одного описания, знаков. */
export const LAYOUT_MAX_CHARS = 24_000;

const DOCSTRING_HEAD =
  'точное описание макета, снятое с PDF программой (не на глаз). Все числа — в точках страницы (px макета), начало координат — левый верхний угол страницы. Верстай по этим числам: размеры шрифта, отступы, цвета, переносы строк; картинки и значки бери только из списка вырезок (в 2× разрешении; свои адреса от человека — вместо них), значок не заменяй текстом и эмодзи; ';
const DOCSTRING_WITH_PAGES = `${DOCSTRING_HEAD}картинки страницы смотри для вида и начертания`;
const DOCSTRING_NO_PAGES = `${DOCSTRING_HEAD}картинок страницы у тебя нет: верстай только по этому описанию`;

const docstring = (info: LayoutInfo) =>
  info.pageImages === false ? DOCSTRING_NO_PAGES : DOCSTRING_WITH_PAGES;

/** Последняя строка блока: свои адреса картинок у человека важнее вырезок. */
const OWN_ADDRESSES =
  'Если человек дал свои адреса картинок — ставь их вместо вырезок на те же места.';

const num = (value: number) => {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
};

/**
 * Всё, что пришло из PDF (строки, ссылки, названия шрифтов, имя файла), — чужой текст: угловые скобки заменяем, а
 * переводы строк и управляющие знаки — пробелом, чтобы строка не могла закрыть блок описания или подделать
 * следующую строку описания.
 */
const safe = (text: string) =>
  text
    // eslint-disable-next-line no-control-regex
    .replaceAll(/[\u0000-\u001F\u007F\u0085\u2028\u2029]/g, ' ')
    .replaceAll('<', '‹')
    .replaceAll('>', '›');

const rect = (item: { h: number; w: number; x: number; y: number }) =>
  `x${num(item.x)} y${num(item.y)} ${num(item.w)}×${num(item.h)}`;

/** Самая частая из величин; при равенстве — меньшая. */
const mode = (values: number[]) => {
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best: number | undefined;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount || (count === bestCount && best !== undefined && value < best)) {
      best = value;
      bestCount = count;
    }
  }
  return best;
};

/** Размеры шрифта: сколько строк и шаг строк (самая частая разница top у соседних строк одного размера и left). */
export const fontSizes = (lines: LayoutLine[]) => {
  const bySize = new Map<number, LayoutLine[]>();
  for (const line of lines) bySize.set(line.size, [...(bySize.get(line.size) ?? []), line]);

  return [...bySize.entries()]
    .map(([size, items]) => {
      const columns = new Map<number, number[]>();
      for (const line of items) columns.set(line.x, [...(columns.get(line.x) ?? []), line.y]);
      const steps: number[] = [];
      for (const ys of columns.values()) {
        const sorted = [...ys].sort((a, b) => a - b);
        for (let i = 1; i < sorted.length; i++) {
          const step = sorted[i] - sorted[i - 1];
          if (step > 0 && step <= size * 2.2) steps.push(step);
        }
      }
      return { count: items.length, size, step: mode(steps) };
    })
    .sort((a, b) => b.count - a.count || b.size - a.size);
};

const percent = (value: number) => `${Math.round(value * 100)}`;

const fontHint = (page: LayoutPage) => {
  const ratio = page.fontRatio;
  const known = page.fontNames?.length
    ? page.fontNames
        .slice(0, 5)
        .map((name) => safe(name).replaceAll('"', "'").slice(0, 60))
        .join(', ')
    : undefined;
  const named = known ? `в файле назван ${known}. ` : 'название шрифта в файле не сохранилось. ';
  if (ratio === undefined) return known ? `в файле назван ${known}` : undefined;
  const share = ratio.toFixed(2).replace('.', ',');
  if (ratio >= 0.93 && ratio <= 1.07) {
    return `${named}По ширине строк ближе всего Arial (ширина в файле / ширина в Arial = ${share}): font-family Arial, Helvetica, sans-serif`;
  }
  const how =
    ratio > 1 ? `шире Arial на ${percent(ratio - 1)} %` : `уже Arial на ${percent(1 - ratio)} %`;
  return `${named}Строки в файле ${how} (${share}), подбирай шрифт по картинке`;
};

/** Скругления: одно число, когда все известные углы одинаковы (с точностью до 2 пт — шум измерения). */
const radiiText = (radii: LayoutBlock['radii']) => {
  if (!radii) return '';
  const known = radii.filter((value) => value >= 0);
  if (known.every((value) => value === 0)) return '';
  if (known.every((value) => value > 0) && Math.max(...known) - Math.min(...known) <= 2) {
    return `скругление ${Math.round(known.reduce((sum, value) => sum + value, 0) / known.length)}`;
  }
  const names = ['↖', '↗', '↘', '↙'];
  return `скругление ${radii
    .map((value, index) => (value > 0 ? `${names[index]}${value}` : ''))
    .filter(Boolean)
    .join(' ')}`;
};

const blockLine = (block: LayoutBlock) => {
  if (block.kind === 'line') return `- линия ${block.color} ${rect(block)}`;
  if (block.kind === 'frame') {
    const thickness = block.thickness ? ` ${block.thickness} px` : '';
    return `- рамка ${block.color}${thickness} ${rect(block)}${radiiText(block.radii) ? `, ${radiiText(block.radii)}` : ''}`;
  }
  return `- заливка ${block.color} ${rect(block)}${radiiText(block.radii) ? `, ${radiiText(block.radii)}` : ''}`;
};

const lineText = (line: LayoutLine) => {
  const flags = [
    line.center ? 'по центру' : '',
    line.bold ? 'жирный' : '',
    line.color ?? '',
  ].filter(Boolean);
  return `y${num(line.y)} x${num(line.x)} ${line.size}px${flags.length > 0 ? ` ${flags.join(' ')}` : ''} | ${safe(line.text)}${line.link ? `  [ссылка ${safe(line.link)}]` : ''}`;
};

const general = (page: LayoutPage, withPage: boolean) => {
  const out: string[] = [`ОБЩЕЕ${withPage ? ` (стр. ${page.page})` : ''}`];
  const edges = [...page.blocks.filter((block) => block.kind !== 'line'), ...page.crops];
  const left = edges.length > 0 ? Math.min(...edges.map((item) => item.x)) : undefined;
  const right = edges.length > 0 ? Math.max(...edges.map((item) => item.x + item.w)) : undefined;
  const column =
    left !== undefined && right !== undefined && right - left < page.width - 1
      ? `, содержимое — колонка x${num(Math.max(0, left))}–${num(right)} (${num(right - Math.max(0, left))})`
      : '';
  out.push(`- Страница ${page.width}×${page.height}${column}, фон ${page.background}.`);

  const hint = fontHint(page);
  if (hint) out.push(`- Шрифт: ${hint}.`);

  const sizes = fontSizes(page.lines);
  if (sizes.length > 0) {
    out.push(
      `- Размеры шрифта: ${sizes
        .map(
          (item) =>
            `${item.size} px (строк ${item.count}${item.step ? `, шаг ${num(item.step)}` : ''})`,
        )
        .join('; ')}.`,
    );
  }

  const colors: string[] = [];
  if (page.textColor) colors.push(`текст ${page.textColor}`);
  const other = new Map<string, number>();
  for (const line of page.lines)
    if (line.color) other.set(line.color, (other.get(line.color) ?? 0) + 1);
  if (other.size > 0) {
    colors.push(
      `другой цвет строк (помечен в строке): ${[...other.keys()].slice(0, 8).join(', ')}`,
    );
  }
  const fills = [...new Set(page.blocks.filter((b) => b.kind === 'fill').map((b) => b.color))];
  if (fills.length > 0) colors.push(`заливки ${fills.slice(0, 12).join(', ')}`);
  const frames = [
    ...new Set(
      page.blocks
        .filter((b) => b.kind === 'frame')
        .map((b) => `${b.color}${b.thickness ? ` (${b.thickness} px)` : ''}`),
    ),
  ];
  if (frames.length > 0) colors.push(`рамки ${frames.slice(0, 8).join(', ')}`);
  const rules = [...new Set(page.blocks.filter((b) => b.kind === 'line').map((b) => b.color))];
  if (rules.length > 0) colors.push(`линии ${rules.slice(0, 6).join(', ')}`);
  if (colors.length > 0) out.push(`- Цвета: ${colors.join('; ')}.`);

  out.push(
    '- Строки: каждая строка списка ниже — отдельная строка в письме (переносы ровно там же, через <br>).',
  );
  return out.join('\n');
};

// ---- Подписи вырезок: где стоит ----

const HINT_MAX = 40;
/** Высота строки текста: у строки в записи её нет, у обычного текста она ≈ 1,3 размера шрифта. */
const lineHeight = (line: LayoutLine) => line.size * 1.3;

/** Фрагмент строки макета для подсказки: до 40 знаков, без угловых скобок, переводов строк и кавычек-ёлочек. */
const quote = (text: string) => {
  const clean = safe(text).replaceAll(/\s+/g, ' ').replaceAll(/[«»]/g, '"').trim();
  const chars = [...clean];
  return `«${chars.length > HINT_MAX ? `${chars.slice(0, HINT_MAX).join('').trimEnd()}…` : clean}»`;
};

/** Слово для блока: маленький — кнопка, рамка — рамка, скруглённая заливка — карточка, остальное — блок. */
const blockWord = (block: LayoutBlock) => {
  if (block.h <= 70) return 'кнопке';
  if (block.kind === 'frame') return 'рамке';
  return block.radii?.some((value) => value > 0) ? 'карточке' : 'блоке';
};

/**
 * Где вырезка стоит: «в кнопке «Профиль»» — самый внутренний блок, в который она попадает, и первая строка текста
 * этого блока; нет блока (или в нём нет текста) — ближайшая строка рядом: «под …», «над …», «слева от …»,
 * «справа от …» (описывается положение вырезки относительно строки). Дальше 150 пт строки не ищем.
 */
const cropHint = (crop: LayoutCrop, page: LayoutPage): string | undefined => {
  const inside = (outer: { h: number; w: number; x: number; y: number }, slack = 3) =>
    crop.x >= outer.x - slack &&
    crop.y >= outer.y - slack &&
    crop.x + crop.w <= outer.x + outer.w + slack &&
    crop.y + crop.h <= outer.y + outer.h + slack;

  const block = page.blocks
    .filter(
      (item) => item.kind !== 'line' && inside(item) && item.w * item.h > crop.w * crop.h * 1.15,
    )
    .sort((a, b) => a.w * a.h - b.w * b.h)[0];
  if (block) {
    const first = page.lines.find((line) => {
      const cx = line.x + line.w / 2;
      const cy = line.y + lineHeight(line) / 2;
      return cx >= block.x && cx <= block.x + block.w && cy >= block.y && cy <= block.y + block.h;
    });
    if (first) return `в ${blockWord(block)} ${quote(first.text)}`;
  }

  let best: { dx: number; dy: number; line: LayoutLine; dist: number } | undefined;
  for (const line of page.lines) {
    const height = lineHeight(line);
    const dx = Math.max(0, line.x - (crop.x + crop.w), crop.x - (line.x + line.w));
    const dy = Math.max(0, line.y - (crop.y + crop.h), crop.y - (line.y + height));
    const dist = Math.hypot(dx, dy);
    // строка поверх самой вырезки (текст на фото) — не подсказка
    if (dist === 0 || dist > 150) continue;
    if (!best || dist < best.dist) best = { dist, dx, dy, line };
  }
  if (!best) return undefined;
  const { dx, dy, line } = best;
  if (dx === 0 || dy >= dx) {
    return `${line.y >= crop.y + crop.h ? 'над' : 'под'} ${quote(line.text)}`;
  }
  return `${line.x >= crop.x + crop.w ? 'слева от' : 'справа от'} ${quote(line.text)}`;
};

const cropLines = (page: LayoutPage) => {
  const counters = { icon: 0, photo: 0 };
  return page.crops.map((crop) => {
    counters[crop.kind]++;
    const name = crop.kind === 'photo' ? 'фото' : 'значок';
    const hint = cropHint(crop, page);
    return `- ${name} ${counters[crop.kind]}: ${crop.url} — ${rect(crop)}${hint ? ` — ${hint}` : ''}`;
  });
};

/** Одна страница: разделы по порядку; когда не лезет в `budget` знаков — режутся строки текста, потом остальное. */
const pageText = (page: LayoutPage, withPage: boolean, budget: number) => {
  const suffix = withPage ? ` (стр. ${page.page})` : '';
  const head = general(page, withPage);
  const blocks = page.blocks.map(blockLine);
  const crops = cropLines(page);
  // порядок строк — как в файле (порядок чтения): куски одной строки (со скидкой 20%, чтобы…) остаются рядом
  const lines = page.lines.map(lineText);

  const section = (title: string, rows: string[]) =>
    rows.length > 0 ? `\n\n${title}${suffix}\n${rows.join('\n')}` : '';
  const fit = (rows: string[], room: number) => {
    const kept: string[] = [];
    let used = 0;
    for (const row of rows) {
      if (used + row.length + 1 > room) break;
      kept.push(row);
      used += row.length + 1;
    }
    return kept;
  };

  const blockTitle = 'БЛОКИ (x y ширина×высота; сверху вниз)';
  const cropTitle =
    'КАРТИНКИ И ЗНАЧКИ (вырезки с макета в 2× разрешении; ставь по x y и размеру — width/height в px макета)';
  const lineTitle = 'СТРОКИ ТЕКСТА (y — верх строки, x — левый край, размер шрифта)';

  // место под заголовок раздела и пометку об обрезке считаем заранее: итог не должен превысить `budget`
  const NOTE_ROOM = 220;
  const used = (rows: string[]) => rows.reduce((sum, row) => sum + row.length + 1, 0);
  const titled = (title: string, rows: string[]) =>
    rows.length > 0 ? title.length + suffix.length + 3 + used(rows) : 0;

  let room = budget - head.length - NOTE_ROOM;
  const keptBlocks = fit(blocks, Math.max(0, (room - blockTitle.length) * 0.3));
  room -= titled(blockTitle, keptBlocks);
  const keptCrops = fit(crops, Math.max(0, (room - cropTitle.length) * 0.5));
  room -= titled(cropTitle, keptCrops);
  const keptLines = fit(lines, Math.max(0, room - lineTitle.length - suffix.length - 3));

  const cut: string[] = [];
  if (keptBlocks.length < blocks.length)
    cut.push(`блоков не показано: ${blocks.length - keptBlocks.length}`);
  if (keptCrops.length < crops.length)
    cut.push(`вырезок не показано: ${crops.length - keptCrops.length}`);
  const missing = lines.length - keptLines.length + (page.omittedLines ?? 0);
  if (missing > 0) cut.push(`строк текста не показано: ${missing}`);

  return `${head}${section(blockTitle, keptBlocks)}${section(cropTitle, keptCrops)}${section(lineTitle, keptLines)}${
    cut.length > 0 ? `\n\n… описание обрезано по размеру (${cut.join('; ')}).` : ''
  }`;
};

/** Блок `<layout file="…">` для одного PDF; пустая строка, если описывать нечего. */
export const layoutPrompt = (info: LayoutInfo, maxChars = LAYOUT_MAX_CHARS): string => {
  const pages = info.pages.filter((page) => page.lines.length > 0 || page.crops.length > 0);
  if (pages.length === 0) return '';

  const withPage = (info.pageCount ?? pages.length) > 1 || pages.length > 1;
  const wrapper = `<layout file="${safe(info.file).replaceAll('"', "'")}">\n<layout_docstring>${docstring(info)}</layout_docstring>\n\n\n${OWN_ADDRESSES}\n</layout>`;
  let room = maxChars - wrapper.length;
  const parts: string[] = [];
  pages.forEach((page, index) => {
    const budget = Math.floor(room / (pages.length - index));
    const text = pageText(page, withPage, Math.max(400, budget));
    parts.push(text);
    room -= text.length + 2;
  });

  return `<layout file="${safe(info.file).replaceAll('"', "'")}">\n<layout_docstring>${docstring(info)}</layout_docstring>\n\n${parts.join('\n\n')}\n\n${OWN_ADDRESSES}\n</layout>`;
};

/** Блоки `<layout>` для всех PDF сообщения. */
export const layoutsPrompts = (layouts: LayoutInfo[] | undefined) =>
  (layouts ?? [])
    .map((info) => layoutPrompt(info))
    .filter(Boolean)
    .join('\n');
