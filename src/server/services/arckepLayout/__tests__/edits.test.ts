import { describe, expect, it } from 'vitest';

import { applyEdits, describeEdits, MAX_EDITS, MAX_HTML_CHARS } from '../edits';

describe('правки «найти → заменить»', () => {
  const html = '<p>Привет</p><a href="x">Кнопка</a><p>Пока</p><p>Пока</p>';

  it('находит один раз и заменяет', () => {
    const result = applyEdits(html, [{ find: 'Кнопка', replace: 'Записаться' }]);
    expect(result.html).toBe('<p>Привет</p><a href="x">Записаться</a><p>Пока</p><p>Пока</p>');
    expect(result.applied).toEqual([{ delta: 4, find: 'Кнопка', index: 1 }]);
    expect(result.rejected).toEqual([]);
  });

  it('не найдено — правка не применяется, причина видна, остальные работают', () => {
    const result = applyEdits(html, [
      { find: 'Нет такого', replace: 'x' },
      { find: 'Привет', replace: 'Здравствуйте' },
    ]);
    expect(result.rejected).toEqual([
      { find: 'Нет такого', index: 1, reason: 'не найдено в тексте' },
    ]);
    expect(result.applied).toHaveLength(1);
    expect(result.html).toContain('Здравствуйте');
  });

  it('найдено дважды — правка не применяется (какое из мест — неясно)', () => {
    const result = applyEdits(html, [{ find: '<p>Пока</p>', replace: '<p>До встречи</p>' }]);
    expect(result.applied).toEqual([]);
    expect(result.rejected[0].reason).toMatch(/больше одного раза/);
    expect(result.html).toBe(html);
  });

  it('пустая замена удаляет кусок; без поля replace правка не применяется', () => {
    const removed = applyEdits(html, [{ find: '<a href="x">Кнопка</a>', replace: '' }]);
    expect(removed.html).toBe('<p>Привет</p><p>Пока</p><p>Пока</p>');
    expect(removed.applied).toHaveLength(1);

    const missing = applyEdits(html, [{ find: 'Привет' } as never]);
    expect(missing.html).toBe(html);
    expect(missing.rejected[0].reason).toMatch(/нет replace/);
  });

  it('пустой find, не объект и не строка в find — отказ', () => {
    const result = applyEdits(html, [
      { find: '', replace: 'x' },
      null,
      'строка',
      { find: 5, replace: 'x' },
    ]);
    expect(result.applied).toEqual([]);
    expect(result.rejected).toHaveLength(4);
    expect(result.rejected.every((item) => item.reason === 'find пустой')).toBe(true);
  });

  it('правки применяются по очереди: следующая видит результат предыдущей', () => {
    const result = applyEdits('<b>один</b>', [
      { find: 'один', replace: 'два' },
      { find: '<b>два</b>', replace: '<i>два</i>' },
    ]);
    expect(result.html).toBe('<i>два</i>');
    expect(result.applied).toHaveLength(2);
  });

  it('знаки $ в замене не трактуются как шаблон', () => {
    const result = applyEdits('цена: X', [{ find: 'X', replace: '$& $1 $$' }]);
    expect(result.html).toBe('цена: $& $1 $$');
  });

  it(`больше ${MAX_EDITS} правок за раз — лишние отклоняются с причиной`, () => {
    const many = Array.from({ length: MAX_EDITS + 2 }, (_, index) => ({
      find: `{{${index}}}`,
      replace: `<${index}>`,
    }));
    const text = many.map((edit) => edit.find).join(' ');
    const result = applyEdits(text, many);
    expect(result.applied).toHaveLength(MAX_EDITS);
    expect(result.rejected).toHaveLength(2);
    expect(result.rejected[0].reason).toMatch(/больше 30 правок/);
  });

  it('текст после правки не длиннее предела отрисовки', () => {
    const result = applyEdits('x', [{ find: 'x', replace: 'y'.repeat(MAX_HTML_CHARS + 1) }]);
    expect(result.applied).toEqual([]);
    expect(result.rejected[0].reason).toMatch(/длиннее 500000/);
  });

  it('описание: что применено и что нет (find обрезан до 60 знаков, пробелы схлопнуты)', () => {
    const long = 'очень   длинный\nкусок '.repeat(10);
    const result = applyEdits(`${long} конец`, [
      { find: long, replace: '' },
      { find: 'нет', replace: 'x' },
    ]);
    const text = describeEdits(result);
    expect(text).toContain('• применена №1');
    expect(text).toContain('• не применена №2 («нет»): не найдено в тексте');
    expect(text.split('\n')[0].length).toBeLessThan(120);
  });
});
