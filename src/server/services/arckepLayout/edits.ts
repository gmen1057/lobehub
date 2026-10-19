/**
 * arckep (19.10.2026): правки куском «найти → заменить» — для круга правки и для инструмента `editArtifact`.
 *
 * Правка применяется к текущему тексту (следующая видит результат предыдущей) только если `find` встречается в нём
 * ровно один раз: иначе неясно, какое из мест имел в виду автор, и молча править «первое попавшееся» нельзя.
 * Пустая замена — удаление куска (её пишут явно: `replace: ""`; без поля `replace` правка не применяется).
 * Не применённая правка не прерывает остальные, а попадает в `rejected` с причиной, которую увидит модель
 * (или правщик на следующем круге).
 */

/** Правок за раз. */
export const MAX_EDITS = 30;
/** Предел размера HTML после правок (знаков): столько принимает отрисовка бэкенда. */
export const MAX_HTML_CHARS = 500_000;

export interface AppliedEdit {
  /** Насколько изменилась длина текста, знаков */
  delta: number;
  /** Начало найденного куска (до 60 знаков, пробелы схлопнуты) */
  find: string;
  /** Номер правки в списке с 1 */
  index: number;
}

export interface RejectedEdit {
  find: string;
  index: number;
  reason: string;
}

export interface EditResult {
  applied: AppliedEdit[];
  html: string;
  rejected: RejectedEdit[];
}

const preview = (value: unknown) => {
  const chars = [...(typeof value === 'string' ? value : '').replaceAll(/\s+/g, ' ')];
  return chars.length > 60 ? `${chars.slice(0, 60).join('')}…` : chars.join('');
};

/** Сколько раз `part` встречается в `text` (без пересечений), не больше 2: дальше считать незачем. */
const countUpTo2 = (text: string, part: string) => {
  const first = text.indexOf(part);
  if (first < 0) return 0;
  return !text.includes(part, first + part.length) ? 1 : 2;
};

/**
 * Применить правки к тексту. Элементы — как пришли от модели (`unknown`): каждый проверяется здесь, битый
 * не применяется и не мешает остальным.
 */
export const applyEdits = (html: string, edits: unknown[]): EditResult => {
  const applied: AppliedEdit[] = [];
  const rejected: RejectedEdit[] = [];
  let text = html;

  edits.slice(0, MAX_EDITS).forEach((raw, position) => {
    const index = position + 1;
    const edit = (raw && typeof raw === 'object' ? raw : {}) as {
      find?: unknown;
      replace?: unknown;
    };
    const reject = (reason: string) => rejected.push({ find: preview(edit.find), index, reason });

    if (typeof edit.find !== 'string' || edit.find === '') return reject('find пустой');
    if (typeof edit.replace !== 'string') {
      return reject('нет replace (чтобы удалить кусок, дай replace: "")');
    }
    const { find, replace } = edit;
    const count = countUpTo2(text, find);
    if (count === 0) return reject('не найдено в тексте');
    if (count > 1) return reject('встречается больше одного раза — возьми кусок подлиннее');
    const next = text.replace(find, () => replace);
    if (next.length > MAX_HTML_CHARS) {
      return reject(`после правки текст длиннее ${MAX_HTML_CHARS} знаков`);
    }
    applied.push({ delta: next.length - text.length, find: preview(find), index });
    text = next;
  });

  for (let position = MAX_EDITS; position < edits.length; position++) {
    const raw = edits[position] as { find?: unknown } | null;
    rejected.push({
      find: preview(raw?.find),
      index: position + 1,
      reason: `больше ${MAX_EDITS} правок за раз`,
    });
  }

  return { applied, html: text, rejected };
};

/** Правки одной строкой для ответа: что применено и что нет (с причиной). */
export const describeEdits = (result: EditResult): string => {
  const lines = [
    ...result.applied.map((item) => `• применена №${item.index}: «${item.find}»`),
    ...result.rejected.map(
      (item) => `• не применена №${item.index} («${item.find}»): ${item.reason}`,
    ),
  ];
  return lines.join('\n');
};
