import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  detectTechniques,
  isTechniqueCheckEnabled,
  techniquesText,
  techniqueTotal,
} from '../techniques';

// arckep (19.10.2026): приёмы вёрстки, которые выбросит почта. Живое письмо пробы 19.10 (Gemini 4 Argon, макет
// клиники): модель расставила всё через position:absolute — 77 мест, ни одной таблицы.

const live = readFileSync(path.join(__dirname, 'fixtures/live-absolute.html'), 'utf8');

const count = (html: string, kind: string) =>
  detectTechniques(html).find((item) => item.kind === kind)?.count ?? 0;

describe('приёмы, которые выбросит почта', () => {
  it('живое письмо с position:absolute: 77 мест, больше ничего', () => {
    const found = detectTechniques(live);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      count: 77,
      kind: 'position',
      label: 'position:absolute/fixed',
    });
    expect(found[0].examples).toHaveLength(2);
    expect(found[0].examples[0]).toMatch(/^position: absolute; left: 20px/);
    expect(techniqueTotal(found)).toBe(77);
    expect(techniquesText(found, false)).toBe('position:absolute/fixed ×77');
    expect(techniquesText(found)).toMatch(
      /^position:absolute\/fixed ×77 \(пример: position: absolute/,
    );
  });

  it('обычное письмо вложенными таблицами со стилями в style — чисто', () => {
    const clean = `<!doctype html><html><head><meta charset="utf-8">
      <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Roboto">
      <style>body{margin:0;background:#fff} td{font-family:Arial} .btn{display:block;position:relative}</style></head>
      <body><table role="presentation" width="600" style="width:600px;border-collapse:collapse">
      <tr><td style="padding:20px;background:#DDEEF8"><table><tr><td align="center" style="font-size:20px">Привет</td></tr></table></td></tr>
      </table></body></html>`;
    expect(detectTechniques(clean)).toEqual([]);
  });

  it('position:absolute и fixed в любой записи: пробелы, регистр, !important, блок <style>, @media', () => {
    expect(count('<div style="POSITION : Absolute !important;top:0">', 'position')).toBe(1);
    expect(count("<div style='position:fixed'>", 'position')).toBe(1);
    expect(count('<style>.a{position:absolute}.b{position: fixed}</style>', 'position')).toBe(2);
    expect(
      count('<style>@media (max-width:600px){.a{position:absolute!important}}</style>', 'position'),
    ).toBe(1);
  });

  it('position:relative/static/sticky, background-position и -webkit-position не считаются', () => {
    expect(
      detectTechniques(
        '<div style="position:relative"><td style="background-position:absolute 1px;position:static"><i style="-webkit-position:fixed">',
      ),
    ).toEqual([]);
  });

  it('display:flex / inline-flex / grid / inline-grid и старые приставки', () => {
    expect(count('<div style="display:flex">', 'flex')).toBe(1);
    expect(count('<div style="display: inline-flex">', 'flex')).toBe(1);
    expect(count('<div style="display:-webkit-box">', 'flex')).toBe(1);
    expect(count('<div style="display:-ms-flexbox">', 'flex')).toBe(1);
    expect(count('<style>.a{display:grid}</style>', 'grid')).toBe(1);
    expect(count('<div style="display:inline-grid">', 'grid')).toBe(1);
    // свойства раскладки flex/grid без display и обычные display — не приём
    expect(
      detectTechniques(
        '<div style="align-items:flex-start;flex-direction:column;grid-gap:2px;display:block;display:table-cell">',
      ),
    ).toEqual([]);
  });

  it('float:left/right — приём, float:none — нет', () => {
    expect(count('<img style="float:left">', 'float')).toBe(1);
    expect(count('<div style="FLOAT: right;">', 'float')).toBe(1);
    expect(count('<div style="float:none">', 'float')).toBe(0);
  });

  it('внешние стили: <link rel=stylesheet> в любом порядке атрибутов и @import; шрифты Google — нет', () => {
    expect(
      count('<link href="https://cdn.example.com/a.css" rel="stylesheet">', 'stylesheet'),
    ).toBe(1);
    expect(count("<link rel='stylesheet' type='text/css' href='/a.css'>", 'stylesheet')).toBe(1);
    expect(
      count('<style>@import url("https://cdn.example.com/a.css");</style>', 'stylesheet'),
    ).toBe(1);
    expect(count('<style>@import "https://cdn.example.com/a.css";</style>', 'stylesheet')).toBe(1);
    // шрифты Google разрешены правилами: без них меняется только начертание
    expect(
      count(
        '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Roboto">',
        'stylesheet',
      ),
    ).toBe(0);
    expect(
      count(
        '<style>@import url(https://fonts.googleapis.com/css2?family=Roboto);</style>',
        'stylesheet',
      ),
    ).toBe(0);
    // не стили
    expect(
      count(
        '<link rel="preconnect" href="https://fonts.gstatic.com"><link rel="icon" href="/f.ico">',
        'stylesheet',
      ),
    ).toBe(0);
  });

  it('<script>: любой, с адресом и без, JSON-LD тоже; код скрипта на приёмы не читается', () => {
    const html =
      '<script>el.style.position="absolute"; var s="display:flex; float:left"</script>' +
      '<script src="https://cdn.example.com/a.js"></script><script type="application/ld+json">{"a":1}</script>';
    const found = detectTechniques(html);
    expect(found.map((item) => [item.kind, item.count])).toEqual([['script', 3]]);
  });

  it('комментарии (и условные для Outlook) не читаются', () => {
    const html =
      '<!-- <div style="position:absolute"> --><!--[if mso]><div style="display:flex"><script>x</script><![endif]--><td style="padding:0">';
    expect(detectTechniques(html)).toEqual([]);
  });

  it('упоминание в тексте письма, а не в стилях — не приём', () => {
    expect(
      detectTechniques('<p>Совет: не используйте position:absolute и display:flex в письмах</p>'),
    ).toEqual([]);
  });

  it('несколько видов: порядок «координаты, flex, grid, float, стили, script», счётчики и ≤2 примера', () => {
    const html =
      '<script>1</script><div style="float:left"></div><div style="display:grid"></div><div style="display:flex"></div>' +
      '<div style="position:absolute"></div><i style="position:absolute;left:1px"></i><b style="position:fixed"></b>' +
      '<link rel="stylesheet" href="/a.css">';
    const found = detectTechniques(html);
    expect(found.map((item) => item.kind)).toEqual([
      'position',
      'flex',
      'grid',
      'float',
      'stylesheet',
      'script',
    ]);
    expect(found[0].count).toBe(3);
    expect(found[0].examples).toHaveLength(2);
    expect(techniqueTotal(found)).toBe(8);
  });

  it('пример обрезан до 70 знаков и без переводов строк', () => {
    const [found] = detectTechniques(
      `<div style="position:\n  absolute;\n left:20px;${'x'.repeat(200)}">`,
    );
    expect(found.examples[0].length).toBeLessThanOrEqual(70);
    expect(found.examples[0]).not.toContain('\n');
  });
});

describe('выключатель', () => {
  afterEach(() => {
    delete process.env.ARCKEP_LAYOUT_TECHNIQUES;
  });

  it('ARCKEP_LAYOUT_TECHNIQUES=0 отключает проверку приёмов', () => {
    expect(isTechniqueCheckEnabled()).toBe(true);
    process.env.ARCKEP_LAYOUT_TECHNIQUES = '0';
    expect(isTechniqueCheckEnabled()).toBe(false);
  });
});
