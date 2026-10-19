/**
 * arckep (19.10.2026): приёмы вёрстки, которые выбрасывает почта.
 *
 * Проба 19.10 (Gemini 4 Argon, макет письма клиники): по точным координатам `<layout>` модель расставила всё через
 * `position:absolute` — 77 мест, ни одной таблицы. На экране похожесть 93,6 %, а в Gmail и Outlook такое письмо
 * разваливается. Поэтому при сверке с макетом приёмы ниже — расхождение первого ряда: они важнее похожести, и версия
 * с такими приёмами не принимается (см. `judge` в check.ts).
 *
 * Что считается: расстановка по координатам (`position:absolute|fixed`), `display:flex|grid` (и `inline-`/старые
 * приставки), `float:left|right`, внешние таблицы стилей (`<link rel=stylesheet>`, `@import`) и любые `<script>`.
 * Исключение — шрифты Google (`fonts.googleapis.com`): правила разрешают их ссылкой, а без шрифта письмо только
 * меняет начертание, раскладка не рушится. Смотрятся только значения `style="…"` и блоки `<style>` (текст письма
 * с упоминанием `position:absolute` не в счёт), комментарии HTML не читаются.
 */

export type TechniqueKind = 'float' | 'flex' | 'grid' | 'position' | 'script' | 'stylesheet';

export interface TechniqueFinding {
  count: number;
  /** Первые находки: кусок кода как есть (до 70 знаков) */
  examples: string[];
  kind: TechniqueKind;
  /** Название для отчёта */
  label: string;
}

export const TECHNIQUE_LABELS: Record<TechniqueKind, string> = {
  float: 'float (обтекание)',
  flex: 'display:flex',
  grid: 'display:grid',
  position: 'position:absolute/fixed',
  script: '<script>',
  stylesheet: 'внешние стили (<link rel=stylesheet>, @import)',
};

/** Выключатель: `ARCKEP_LAYOUT_TECHNIQUES=0` — проверка приёмов отключена (письмо принимается только по похожести). */
export const isTechniqueCheckEnabled = () => process.env.ARCKEP_LAYOUT_TECHNIQUES !== '0';

const EXAMPLES = 2;
const EXAMPLE_CHARS = 70;

const CSS_RULES: Array<{ kind: TechniqueKind; pattern: RegExp }> = [
  { kind: 'position', pattern: /(?<![\w-])position\s*:\s*(?:absolute|fixed)\b/gi },
  {
    kind: 'flex',
    pattern:
      /(?<![\w-])display\s*:\s*(?:(?:inline-)?flex|-webkit-(?:inline-)?(?:flex|box)|-ms-(?:inline-)?flexbox)\b/gi,
  },
  { kind: 'grid', pattern: /(?<![\w-])display\s*:\s*(?:-ms-)?(?:inline-)?grid\b/gi },
  { kind: 'float', pattern: /(?<![\w-])float\s*:\s*(?:left|right|inline-start|inline-end)\b/gi },
];

const isGoogleFonts = (address: string) =>
  /(?:^|\/\/)fonts\.(?:googleapis|gstatic)\.com\b/i.test(address);

const snippet = (text: string, at: number) =>
  text
    .slice(at, at + EXAMPLE_CHARS)
    .replaceAll(/\s+/g, ' ')
    .trim();

/** Значения style="…" / style='…' и тела блоков <style>: только там читается CSS. */
const cssFragments = (html: string): string[] => {
  const fragments: string[] = [];
  for (const block of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi))
    fragments.push(block[1]);
  for (const attr of html.matchAll(/\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    fragments.push(attr[1] ?? attr[2] ?? '');
  }
  return fragments;
};

/** Найти приёмы, которые выбросит почта. Пусто — письмо в обычном потоке. */
export const detectTechniques = (source: string): TechniqueFinding[] => {
  const found = new Map<TechniqueKind, { count: number; examples: string[] }>();
  const add = (kind: TechniqueKind, example: string) => {
    const entry = found.get(kind) ?? { count: 0, examples: [] };
    entry.count++;
    if (entry.examples.length < EXAMPLES && !entry.examples.includes(example)) {
      entry.examples.push(example);
    }
    found.set(kind, entry);
  };

  // комментарии (в том числе условные для Outlook) не читаем; <script> считаем и выкидываем вместе с кодом
  const html = source.replaceAll(/<!--[\s\S]*?-->/g, '');
  for (const script of html.matchAll(/<script\b[^>]*>/gi))
    add('script', snippet(html, script.index));
  const markup = html.replaceAll(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');

  for (const fragment of cssFragments(markup)) {
    for (const { kind, pattern } of CSS_RULES) {
      for (const match of fragment.matchAll(pattern)) add(kind, snippet(fragment, match.index));
    }
    for (const rule of fragment.matchAll(/@import\s+(?:url\(\s*)?["']?([^"')\s;]+)/gi)) {
      if (!isGoogleFonts(rule[1])) add('stylesheet', snippet(fragment, rule.index));
    }
  }
  for (const link of markup.matchAll(/<link\b[^>]*>/gi)) {
    const tag = link[0];
    if (!/\brel\s*=(?:\s*["'])?[^"'>]*\bstylesheet\b/i.test(tag)) continue;
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    if (!isGoogleFonts(href?.[1] ?? href?.[2] ?? href?.[3] ?? ''))
      add('stylesheet', snippet(tag, 0));
  }

  const order: TechniqueKind[] = ['position', 'flex', 'grid', 'float', 'stylesheet', 'script'];
  return order.flatMap((kind) => {
    const entry = found.get(kind);
    return entry
      ? [{ count: entry.count, examples: entry.examples, kind, label: TECHNIQUE_LABELS[kind] }]
      : [];
  });
};

export const techniqueTotal = (findings: TechniqueFinding[] | undefined): number =>
  (findings ?? []).reduce((sum, item) => sum + item.count, 0);

/** Находки одной строкой: «position:absolute/fixed ×77 (пример: position: absolute; left: 20px); display:flex ×2». */
export const techniquesText = (findings: TechniqueFinding[], withExamples = true): string =>
  findings
    .map(
      (item) =>
        `${item.label} ×${item.count}${withExamples && item.examples[0] ? ` (пример: ${item.examples[0]})` : ''}`,
    )
    .join('; ');
