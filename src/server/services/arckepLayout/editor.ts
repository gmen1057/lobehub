import { issueText, issueY } from './compare';
import type { EditorPictures } from './pictures';
import { toDataUri } from './pictures';
import { type TechniqueFinding, techniqueTotal } from './techniques';
import type { Issue, LineIssue, MockupBlock } from './types';

/**
 * arckep (19.10.2026): круг правки вне переписки — «правщик».
 *
 * Тот же поставщик и та же модель, что в ходе чата, но отдельный короткий вызов: только текущий HTML, список
 * расхождений и картинки «макет | письмо» — без переписки (в обычном чате каждый круг дороже предыдущего: модель
 * получает всю историю и печатает письмо целиком, круг 2 стоил 41 ₽ против 22 ₽ за первый). Ответ — не письмо
 * целиком, а правки «найти → заменить».
 */

/** Расхождений в сообщении правщику. */
export const MAX_LISTED_ISSUES = 30;
/** Сколько подряд одинаковых смещений считается «каскадом» одной причины. */
const CASCADE_MIN = 4;
/** Смещения, которые считаются одинаковыми, px. */
const CASCADE_STEP = 2;
const MAX_OBSERVATIONS_CHARS = 1500;

export const EDITOR_SYSTEM = `Ты правишь HTML письма или страницы, чтобы он совпал с макетом из PDF. Тебя вызывает программа сверки, с человеком ты не говоришь.

Ты получаешь: текущий HTML, список расхождений, которые измерила программа (числа в px; в макете и в письме 1 точка = 1 px), и картинки: обзор «макет | письмо» (слева макет, справа письмо) и крупные пары по полосам. Красная рамка — строка или картинка стоит не там, где в макете; жёлтая — заметная разница по картинке, причину которой программа не измерила.

Ответ строго в таком порядке:
1. Коротко (не больше 8 строк): что ты видишь отличающимся. Включи то, чего линейка не меряет: цвет, жирность и начертание, лишние или пропавшие линии и рамки, скругления, обрезку картинок, фон.
2. Один JSON-массив правок в блоке \`\`\`json: [{"find": "...", "replace": "..."}, ...].

Правила правок:
- find — точный кусок ТЕКУЩЕГО HTML (с теми же пробелами и переводами строк), который встречается в нём ровно один раз; бери с запасом окружающего текста, чтобы кусок был уникальным. Не нашлось или нашлось дважды — правка пропадёт.
- replace — на что заменить; пустая строка удаляет кусок.
- Не больше 30 правок. Письмо целиком не переписывай и не присылай.
- Если много строк сдвинуты на одну величину, причина одна: найди первый элемент выше, который стал выше или ниже, чем в макете (высота строки, отступ, размер картинки, лишний перенос), и правь его, а не каждую строку.
- Ничего не ломай там, где расхождений нет: сначала подумай, что ещё сдвинется от правки.
- Адреса картинок не меняй, значки не заменяй текстом.
- Нечего править уверенно — верни пустой массив [].

Письмо должно жить в почте (Gmail, Outlook): обычный поток, вложенные таблицы, стили в style. Почта выбрасывает position:absolute/fixed, display:flex/grid, float, внешние стили (<link rel=stylesheet>, @import) и любые <script>. Если в сообщении есть раздел «Приёмы, которые выбросит почта», это расхождения первого ряда, они важнее похожести: правка, которая оставляет приёмы или добавляет новые, будет отклонена. Убирай их, заменяя расстановку по координатам таблицей с шириной, отступами и выравниванием, посчитанными по положению элементов в макете; одной правкой можно заменить целый блок.`;

/** Центр расхождения (точка для выбора блока). */
const center = (issue: LineIssue | (Issue & { kind: 'image' })) =>
  issue.kind === 'line'
    ? { x: issue.mock.x + issue.mock.w / 2, y: issue.mock.y + issue.mock.size * 0.65 }
    : { x: issue.mock.x + issue.mock.w / 2, y: issue.mock.y + issue.mock.h / 2 };

const blockWord = (block: MockupBlock) => {
  if (block.h <= 70) return 'кнопка';
  return block.kind === 'frame' ? 'рамка' : 'блок';
};

/** Самый внутренний (по площади) блок макета, в который попадает точка. */
const innermostBlock = (blocks: MockupBlock[], point: { x: number; y: number }) =>
  blocks
    .filter(
      (block) =>
        block.kind !== 'line' &&
        point.x >= block.x &&
        point.x <= block.x + block.w &&
        point.y >= block.y &&
        point.y <= block.y + block.h,
    )
    .sort((a, b) => a.w * a.h - b.w * b.h)[0];

const signed = (value: number) => `${value > 0 ? '+' : ''}${Math.round(value)}`;

/**
 * Расхождения для правщика: сгруппированы по блокам макета (≤ `limit` пунктов). Одинаковые смещения по высоте у
 * многих строк подряд сворачиваются в один пункт — это следствие одной причины выше по странице.
 */
export const summarizeIssues = (
  issues: Issue[],
  blocks: MockupBlock[],
  limit = MAX_LISTED_ISSUES,
): string[] => {
  // приёмы вёрстки — отдельный раздел сообщения (buildEditorMessage), в списке положения их нет
  issues = issues.filter((issue) => issue.kind !== 'technique');
  // каскады: строки, у которых есть только сдвиг по высоте, объединяются по близкой величине
  const shifted = issues
    .filter(
      (issue): issue is LineIssue =>
        issue.kind === 'line' &&
        !issue.missing &&
        issue.dy !== undefined &&
        issue.dx === undefined &&
        issue.size === undefined,
    )
    .sort((a, b) => (a.dy ?? 0) - (b.dy ?? 0));
  const clusters: LineIssue[][] = [];
  for (const issue of shifted) {
    const last = clusters.at(-1);
    if (last && Math.abs((issue.dy ?? 0) - (last.at(-1)?.dy ?? 0)) <= CASCADE_STEP)
      last.push(issue);
    else clusters.push([issue]);
  }
  const cascades = clusters.filter((cluster) => cluster.length >= CASCADE_MIN);
  const folded = new Set(cascades.flat());

  const items: Array<{ block?: MockupBlock; text: string; y: number }> = [];
  for (const cluster of cascades) {
    const ys = cluster.map((issue) => issue.mock.y);
    const dy = cluster.reduce((sum, issue) => sum + (issue.dy ?? 0), 0) / cluster.length;
    const from = Math.min(...ys);
    items.push({
      text: `строки с y${Math.round(from)} до y${Math.round(Math.max(...ys))} (${cluster.length} шт.) смещены по высоте на ${signed(dy)} одинаково: причина выше y${Math.round(from)} — найди первый элемент перед ними, который стал выше или ниже, чем в макете`,
      y: from,
    });
  }
  for (const issue of issues) {
    if (folded.has(issue as LineIssue)) continue;
    const y = issueY(issue);
    const block =
      issue.kind === 'line' || issue.kind === 'image'
        ? innermostBlock(blocks, center(issue))
        : undefined;
    items.push({ block, text: issueText(issue), y: y ?? Infinity });
  }

  const shown = items.sort((a, b) => a.y - b.y).slice(0, limit);
  const lines: string[] = [];
  const groups = new Map<MockupBlock | undefined, typeof shown>();
  for (const item of shown) groups.set(item.block, [...(groups.get(item.block) ?? []), item]);
  const ordered = [...groups.entries()].sort(
    (a, b) => Math.min(...a[1].map((i) => i.y)) - Math.min(...b[1].map((i) => i.y)),
  );
  for (const [block, group] of ordered) {
    if (block) {
      lines.push(
        `${blockWord(block)} x${Math.round(block.x)} y${Math.round(block.y)} ${Math.round(block.w)}×${Math.round(block.h)} (${block.color}):`,
      );
    } else {
      lines.push('вне блоков / общее:');
    }
    for (const item of group) lines.push(`  - ${item.text}`);
  }
  if (items.length > shown.length)
    lines.push(`… и ещё ${items.length - shown.length} расхождений ниже`);
  return lines;
};

export interface EditorInput {
  blocks: MockupBlock[];
  /** Что не вышло у прошлых правок (не применились) */
  failedAttempt?: string;
  /** Имя PDF с макетом */
  file: string;
  html: string;
  issues: Issue[];
  pictures?: EditorPictures;
  similarity?: number;
  /** Приёмы вёрстки, которые выбросит почта (position:absolute, flex…) в текущем HTML */
  techniques?: TechniqueFinding[];
  /** Ширина окна, px */
  width: number;
}

export type EditorPart =
  { text: string; type: 'text' } | { image_url: { url: string }; type: 'image_url' };

/** Сообщение правщику: текст со списком, затем картинки с подписями. */
export const buildEditorMessage = (input: EditorInput): EditorPart[] => {
  const similarity =
    input.similarity === undefined
      ? ''
      : `Похожесть письма на макет по картинке: ${input.similarity} %.\n`;
  const listed = summarizeIssues(input.issues, input.blocks);
  const measured = input.issues.filter((issue) => issue.kind !== 'technique');
  const techniques = input.techniques ?? [];
  const head = [
    `Макет: ${input.file}, окно письма ${input.width} px.`,
    similarity.trim(),
    input.failedAttempt ? `ВАЖНО: ${input.failedAttempt}` : '',
    '',
    techniques.length > 0
      ? `Приёмы, которые выбросит почта (${techniqueTotal(techniques)}; расхождения первого ряда — важнее похожести, правка без их уборки будет отклонена):\n${techniques
          .map(
            (item) =>
              `- ${item.label} ×${item.count}${item.examples.map((example) => `\n  пример: ${example}`).join('')}`,
          )
          .join('\n')}\n`
      : '',
    measured.length > 0
      ? `Расхождения, которые измерила программа (${measured.length}):\n${listed.join('\n')}`
      : 'Программа расхождений положения не нашла: смотри только картинки.',
    '',
    'Текущий HTML:',
    '```html',
    input.html,
    '```',
  ]
    .filter((line, index, all) => line !== '' || all[index - 1] !== '')
    .join('\n');

  const parts: EditorPart[] = [{ text: head, type: 'text' }];
  if (input.pictures) {
    parts.push(
      { text: 'Обзор: слева макет, справа письмо, во всю длину (уменьшено).', type: 'text' },
      { image_url: { url: toDataUri(input.pictures.overview) }, type: 'image_url' },
    );
    for (const strip of input.pictures.strips) {
      parts.push(
        { text: `Крупно, слева макет, справа письмо; ${strip.caption}.`, type: 'text' },
        { image_url: { url: toDataUri(strip.jpeg) }, type: 'image_url' },
      );
    }
  }
  return parts;
};

export interface EditorReply {
  /** Правки из ответа; `undefined` — JSON не найден или битый */
  edits?: unknown[];
  /** Почему правок нет */
  error?: string;
  /** Что правщик видит отличающимся (его первая часть ответа) */
  observations: string;
}

/** Все куски текста, похожие на JSON-массив: от `[` до парной `]` с учётом строк. */
const arrayCandidates = (text: string): Array<{ end: number; start: number }> => {
  const found: Array<{ end: number; start: number }> = [];
  for (
    let start = text.indexOf('[');
    start >= 0 && found.length < 60;
    start = text.indexOf('[', start + 1)
  ) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (ch === '\\') i++;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === '[') depth++;
      else if (ch === ']' && --depth === 0) {
        found.push({ end: i + 1, start });
        break;
      }
    }
  }
  return found;
};

const isEditList = (value: unknown): value is unknown[] =>
  Array.isArray(value) &&
  value.every((item) => item && typeof item === 'object' && !Array.isArray(item));

/**
 * Ответ правщика → «что вижу» и правки. JSON ищется в последнем блоке ```json, иначе — последний подходящий
 * массив в тексте. Не нашёлся или битый — `edits` нет и причина: круг пропускается.
 */
export const parseEditorReply = (reply: string): EditorReply => {
  const text = reply.slice(0, 400_000);
  const observe = (end: number) =>
    text
      .slice(0, end)
      .replace(/```(?:json)?\s*$/i, '')
      .trim()
      .slice(0, MAX_OBSERVATIONS_CHARS);

  const fences = [...text.matchAll(/```(?:json)?[ \t]*\n([\s\S]*?)```/gi)].reverse();
  for (const fence of fences) {
    try {
      const value = JSON.parse(fence[1].trim());
      if (isEditList(value)) return { edits: value, observations: observe(fence.index ?? 0) };
    } catch {
      // не тот блок — пробуем предыдущий
    }
  }

  for (const candidate of arrayCandidates(text).reverse()) {
    try {
      const value = JSON.parse(text.slice(candidate.start, candidate.end));
      if (isEditList(value)) return { edits: value, observations: observe(candidate.start) };
    } catch {
      // не JSON
    }
  }

  return {
    error: text.trim()
      ? 'в ответе правщика нет разбираемого массива правок'
      : 'правщик ответил пустым текстом',
    observations: observe(text.length),
  };
};
