import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import {
  BAND_HEIGHT,
  bandSimilarity,
  buildEditorPictures,
  decodePicture,
  MAX_STRIPS,
  type RawPicture,
  regionSimilarity,
  stitchMockup,
  toDataUri,
} from '../pictures';
import type { Issue, LineIssue } from '../types';

// arckep (19.10.2026): склейка макета, похожесть по полосам и картинки «макет | письмо» для правщика — на
// синтетических картинках (настоящие страницы в репозиторий не кладём).

const solid = (width: number, height: number, [r, g, b]: [number, number, number]): RawPicture => ({
  data: Buffer.from(Array.from({ length: width * height }, () => [r, g, b]).flat()),
  height,
  width,
});

/** Картинка из горизонтальных полос: [высота, цвет]. */
const stripes = (width: number, rows: Array<[number, [number, number, number]]>): RawPicture => {
  const parts = rows.map(([height, color]) => solid(width, height, color));
  return {
    data: Buffer.concat(parts.map((part) => part.data)),
    height: parts.reduce((sum, part) => sum + part.height, 0),
    width,
  };
};

const png = (picture: RawPicture) =>
  sharp(picture.data, { raw: { channels: 3, height: picture.height, width: picture.width } })
    .png()
    .toBuffer();

const pixel = (picture: RawPicture, x: number, y: number) => {
  const i = (y * picture.width + x) * 3;
  return [picture.data[i], picture.data[i + 1], picture.data[i + 2]];
};

const count = (picture: RawPicture, test: (r: number, g: number, b: number) => boolean) => {
  let total = 0;
  for (let i = 0; i < picture.data.length; i += 3) {
    if (test(picture.data[i], picture.data[i + 1], picture.data[i + 2])) total++;
  }
  return total;
};

describe('склейка макета из кусков страницы', () => {
  it('куски шириной 2 px на пт ставятся по fromPt; страница 100×200 пт становится 100×200 px', async () => {
    const top = await png(solid(200, 200, [255, 0, 0])); // 0…100 пт
    const bottom = await png(solid(200, 200, [0, 0, 255])); // 100…200 пт
    const mock = await stitchMockup(
      [
        { buffer: top, fromPt: 0, height: 200, page: 1, width: 200 },
        { buffer: bottom, fromPt: 100, height: 200, page: 1, width: 200 },
      ],
      [{ height: 200, page: 1, width: 100 }],
      100,
    );
    expect(mock).toMatchObject({ height: 200, width: 100 });
    expect(pixel(mock!, 50, 10)).toEqual([255, 0, 0]);
    expect(pixel(mock!, 50, 99)).toEqual([255, 0, 0]);
    expect(pixel(mock!, 50, 101)).toEqual([0, 0, 255]);
    expect(pixel(mock!, 50, 199)).toEqual([0, 0, 255]);
  });

  it('окно уже страницы (колонка 600 при странице 603) — картинка обрезана справа', async () => {
    const page = await png(solid(603, 50, [10, 200, 10]));
    const mock = await stitchMockup(
      [{ buffer: page, height: 50, page: 1, width: 603 }],
      [{ height: 50, page: 1, width: 603 }],
      600,
    );
    expect(mock).toMatchObject({ height: 50, width: 600 });
  });

  it('несколько страниц ставятся друг под другом', async () => {
    const one = await png(solid(100, 100, [255, 0, 0]));
    const two = await png(solid(100, 50, [0, 255, 0]));
    const mock = await stitchMockup(
      [
        { buffer: two, height: 50, page: 2, width: 100 },
        { buffer: one, height: 100, page: 1, width: 100 },
      ],
      [
        { height: 100, page: 1, width: 100 },
        { height: 50, page: 2, width: 100 },
      ],
      100,
    );
    expect(mock).toMatchObject({ height: 150, width: 100 });
    expect(pixel(mock!, 5, 99)).toEqual([255, 0, 0]);
    expect(pixel(mock!, 5, 100)).toEqual([0, 255, 0]);
  });

  it('нет кусков или страниц — склейки нет', async () => {
    expect(await stitchMockup([], [{ height: 10, page: 1, width: 10 }], 10)).toBeUndefined();
    expect(
      await stitchMockup([{ buffer: Buffer.alloc(0), height: 1, page: 1, width: 1 }], [], 10),
    ).toBeUndefined();
  });

  it('снимок письма приводится к ширине окна', async () => {
    const shot = await sharp(solid(300, 40, [0, 0, 0]).data, {
      raw: { channels: 3, height: 40, width: 300 },
    })
      .jpeg()
      .toBuffer();
    const picture = await decodePicture(shot, 150);
    expect(picture.width).toBe(150);
  });
});

describe('похожесть по картинке', () => {
  it('одинаковые — 100 %, полностью разные — 0 %', () => {
    const white = solid(50, 800, [255, 255, 255]);
    expect(bandSimilarity(white, white)).toEqual({ average: 100, bands: [100, 100] });
    expect(bandSimilarity(white, solid(50, 800, [0, 0, 0])).average).toBe(0);
  });

  it('полосы по 400 пт: разница в нижней половине второй полосы даёт 50 % только ей', () => {
    const a = solid(50, 800, [255, 255, 255]);
    const b = stripes(50, [
      [600, [255, 255, 255]],
      [200, [0, 0, 0]],
    ]);
    const result = bandSimilarity(a, b);
    expect(result.bands).toEqual([100, 50]);
    expect(result.average).toBe(75);
  });

  it('разница яркости до 40 включительно — одинаковые точки, 41 — разные', () => {
    const base = solid(10, 10, [100, 100, 100]);
    expect(regionSimilarity(base, solid(10, 10, [140, 140, 140]), 0, 10)).toBe(100);
    expect(regionSimilarity(base, solid(10, 10, [141, 141, 141]), 0, 10)).toBe(0);
  });

  it('письмо длиннее или короче макета: лишние строки считаются разными', () => {
    const mock = solid(20, 400, [255, 255, 255]);
    const longer = solid(20, 600, [255, 255, 255]);
    const result = bandSimilarity(mock, longer);
    expect(result.bands).toEqual([100, 0]);
  });
});

describe('картинки для правщика', () => {
  const lineIssue = (y: number, renderY: number): LineIssue => ({
    dy: renderY - y,
    index: 1,
    key: 'line:1',
    kind: 'line',
    mock: { size: 20, text: 'строка', w: 200, x: 40, y },
    render: { h: 24, size: 20, x: 40, y: renderY },
  });

  const isRed = (r: number, g: number, b: number) => r > 190 && g < 90 && b < 90;
  const isYellow = (r: number, g: number, b: number) => r > 220 && g > 150 && g < 215 && b < 70;

  it('обзор и пара по полосе с расхождением: красная рамка вокруг строки, JPEG', async () => {
    const mock = solid(300, 1200, [255, 255, 255]);
    const render = solid(300, 1200, [255, 255, 255]);
    const issues: Issue[] = [lineIssue(500, 540)];
    const pictures = await buildEditorPictures(mock, render, issues, [100, 100, 100]);

    expect(pictures.overview.subarray(0, 2).toString('hex')).toBe('ffd8');
    expect(pictures.strips).toHaveLength(1);
    const [strip] = pictures.strips;
    expect([strip.from, strip.to]).toEqual([360, 840]);
    expect(strip.caption).toContain('красным обведено 1');
    expect(strip.jpeg.subarray(0, 2).toString('hex')).toBe('ffd8');

    const decoded = await decodePicture(strip.jpeg);
    // пара: макет и письмо рядом (300 + 20 + 300), высота окна 480
    expect(decoded).toMatchObject({ height: 480, width: 620 });
    expect(count(decoded, isRed)).toBeGreaterThan(40);
  });

  it('разница по картинке без замеренной причины подсвечивается жёлтым', async () => {
    const mock = solid(300, 1200, [255, 255, 255]);
    const render = stripes(300, [
      [500, [255, 255, 255]],
      [100, [0, 0, 0]],
      [600, [255, 255, 255]],
    ]);
    const bands = bandSimilarity(mock, render).bands;
    const pictures = await buildEditorPictures(mock, render, [], bands);
    expect(pictures.strips.length).toBeGreaterThan(0);
    expect(pictures.strips[0].caption).toContain('жёлтым');
    const decoded = await decodePicture(pictures.strips[0].jpeg);
    expect(count(decoded, isYellow)).toBeGreaterThan(40);
  });

  it(`крупных пар не больше ${MAX_STRIPS}, выбраны полосы с наибольшим числом расхождений, идут сверху вниз`, async () => {
    const mock = solid(200, 4000, [255, 255, 255]);
    const render = solid(200, 4000, [255, 255, 255]);
    const issues: Issue[] = [
      lineIssue(100, 140),
      ...Array.from({ length: 5 }, (_, i) => lineIssue(1300 + i * 30, 1340 + i * 30)),
      ...Array.from({ length: 3 }, (_, i) => lineIssue(2500 + i * 30, 2540 + i * 30)),
      ...Array.from({ length: 4 }, (_, i) => lineIssue(3300 + i * 30, 3340 + i * 30)),
      lineIssue(1900, 1940),
    ];
    const pictures = await buildEditorPictures(
      mock,
      render,
      issues,
      Array.from({ length: 10 }, () => 100),
    );
    expect(pictures.strips).toHaveLength(MAX_STRIPS);
    const starts = pictures.strips.map((strip) => strip.from);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    // полоса с одним расхождением (y100) не вошла: есть три полосы богаче
    expect(starts[0]).toBeGreaterThan(BAND_HEIGHT);
  });

  it('нет расхождений и провалов — только обзор', async () => {
    const white = solid(100, 800, [255, 255, 255]);
    const pictures = await buildEditorPictures(white, white, [], [100, 100]);
    expect(pictures.strips).toEqual([]);
  });

  it('data:-адрес для сообщения', () => {
    expect(toDataUri(Buffer.from([1, 2, 3]))).toBe('data:image/jpeg;base64,AQID');
  });
});
