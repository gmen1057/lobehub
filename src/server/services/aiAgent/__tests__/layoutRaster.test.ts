// @vitest-environment node
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import {
  cornerRadii,
  findBlocks,
  findInkRects,
  findRegions,
  fromHex,
  makeGrid,
  pageBackground,
  radiusFromOffset,
  type RawImage,
  type Rect,
  textColor,
  toHex,
  visibleRect,
} from '../layoutRaster';

// arckep (19.10.2026): пиксельная часть описания макета PDF. Страницы рисуются из SVG (sharp, как poppler: со
// сглаживанием краёв — на нём и держатся отсев каймы и радиусы), масштаб 2,5 px на пт — как у настоящей страницы.

const SCALE = 2.5;
const PAGE = { height: 320, width: 400 };

const renderSvg = async (body: string, size = PAGE): Promise<RawImage> => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}"><rect width="${size.width}" height="${size.height}" fill="#FFFFFF"/>${body}</svg>`;
  const { data, info } = await sharp(Buffer.from(svg), { density: 72 * SCALE })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, height: info.height, width: info.width };
};

const analyse = async (img: RawImage, size = PAGE, photos: Rect[] = [], texts: Rect[] = []) => {
  const grid = makeGrid(img, size.width, size.height)!;
  const background = pageBackground(grid);
  const regionMap = await findRegions(grid);
  const blockResult = findBlocks(grid, regionMap, { background, photos, texts });
  return { background, blockResult, grid, regionMap };
};

const near = (value: number, expected: number, tol = 2) => Math.abs(value - expected) <= tol;

const CARD = '<rect x="0" y="20" width="400" height="120" rx="24" fill="#F6F7FA"/>';
const WHITE_BUTTON = '<rect x="25" y="85" width="237" height="40" rx="20" fill="#FFFFFF"/>';
const PILL = '<rect x="20" y="160" width="187" height="45" rx="23" fill="#FFBB73"/>';
const THIN_RING =
  '<rect x="20.5" y="226.5" width="148" height="43" rx="5" fill="none" stroke="#CFD6E9" stroke-width="1"/>';
const THICK_RING =
  '<rect x="231" y="161" width="160" height="108" rx="24" fill="none" stroke="#FFEED9" stroke-width="2"/>';
const RULE = '<rect x="20" y="290" width="360" height="1" fill="#2D3C82"/>';

describe('сетка и фон', () => {
  it('фон страницы — самый частый цвет по кромке; цвета туда и обратно', async () => {
    const img = await renderSvg(CARD);
    const grid = makeGrid(img, PAGE.width, PAGE.height)!;
    expect(grid.width).toBe(400);
    expect(grid.height).toBe(320);
    expect(toHex(pageBackground(grid))).toBe('#FFFFFF');
    expect(toHex(fromHex('#2D3C82'))).toBe('#2D3C82');
  });

  it('слишком большая страница сеткой не делается (память)', () => {
    const img: RawImage = { data: new Uint8Array(3), height: 1, width: 1 };
    expect(makeGrid(img, 5000, 5000)).toBeUndefined();
  });
});

describe('блоки: заливки, рамки, линии', () => {
  it('карточка у края, белая кнопка на ней, оранжевая таблетка, рамки и линия находятся с верными местами и цветами', async () => {
    const img = await renderSvg(CARD + WHITE_BUTTON + PILL + THIN_RING + THICK_RING + RULE);
    const { blockResult } = await analyse(img);
    const blocks = blockResult.blocks;

    const card = blocks.find((b) => b.kind === 'fill' && toHex(b.color) === '#F6F7FA')!;
    expect([card.x, card.y, card.w, card.h].every((v, i) => near(v, [0, 20, 400, 120][i], 1))).toBe(
      true,
    );

    // белая кнопка внутри цветной карточки — тоже заливка (фон страницы, замкнутый внутри заливки)
    const button = blocks.find((b) => b.kind === 'fill' && toHex(b.color) === '#FFFFFF')!;
    expect(
      [button.x, button.y, button.w, button.h].every((v, i) => near(v, [25, 85, 237, 40][i], 1)),
    ).toBe(true);

    const pill = blocks.find((b) => b.kind === 'fill' && toHex(b.color) === '#FFBB73')!;
    expect(
      [pill.x, pill.y, pill.w, pill.h].every((v, i) => near(v, [20, 160, 187, 45][i], 1)),
    ).toBe(true);

    // толстая рамка — один связный контур
    const thick = blocks.find((b) => b.kind === 'frame' && toHex(b.color) === '#FFEED9')!;
    expect(
      [thick.x, thick.y, thick.w, thick.h].every((v, i) => near(v, [230, 160, 162, 110][i], 2)),
    ).toBe(true);
    expect(thick.thickness).toBe(2);

    // тонкая рамка 1 пт со скруглением собирается из верхней и нижней линий и боковых стенок
    const thin = blocks.find((b) => b.kind === 'frame' && toHex(b.color) === '#CFD6E9')!;
    expect(
      [thin.x, thin.y, thin.w, thin.h].every((v, i) => near(v, [20, 226, 149, 44][i], 2)),
    ).toBe(true);
    expect(thin.thickness).toBe(1);

    const line = blocks.find((b) => b.kind === 'line')!;
    expect(toHex(line.color)).toBe('#2D3C82');
    expect([line.x, line.w, line.h].every((v, i) => near(v, [20, 360, 1][i], 1))).toBe(true);
    expect(near(line.y, 290, 1)).toBe(true);
  });

  it('белая внутренность рамки блоком не считается; кайма края заливки — не линия', async () => {
    // край заливки не по сетке пт (y = 160.4): строка сглаживания между фоном и заливкой — не разделитель
    const img = await renderSvg(
      '<rect x="20" y="160.4" width="300" height="60" rx="10" fill="#FFBB73"/>' +
        '<rect x="21" y="241" width="358" height="58" rx="10" fill="none" stroke="#FFEED9" stroke-width="2"/>',
    );
    const { blockResult } = await analyse(img);
    expect(blockResult.blocks.filter((b) => b.kind === 'line')).toHaveLength(0);
    expect(
      blockResult.blocks.filter((b) => b.kind === 'fill' && toHex(b.color) === '#FFFFFF'),
    ).toHaveLength(0);
    expect(blockResult.blocks.filter((b) => b.kind === 'frame')).toHaveLength(1);
  });

  it('линия у строки текста — подчёркивание ссылки, а не разделитель; одинокая — разделитель', async () => {
    const underline = '<rect x="40" y="101" width="130" height="1" fill="#2D3C82"/>';
    const img = await renderSvg(
      underline + '<rect x="20" y="200" width="360" height="1" fill="#2D3C82"/>',
    );
    const text: Rect = { h: 26, w: 130, x: 40, y: 78 };

    const withText = await analyse(img, PAGE, [], [text]);
    expect(withText.blockResult.blocks.filter((b) => b.kind === 'line').map((b) => b.y)).toEqual([
      200,
    ]);

    // без подсказки текстом подчёркивание шире 100 пт неотличимо от разделителя
    const without = await analyse(img);
    expect(without.blockResult.blocks.filter((b) => b.kind === 'line')).toHaveLength(2);
    // короче 100 пт линией не считается в любом случае
    const short = await renderSvg('<rect x="40" y="101" width="90" height="1" fill="#2D3C82"/>');
    expect((await analyse(short)).blockResult.blocks).toHaveLength(0);
  });

  it('области внутри видимого фото блоками не считаются', async () => {
    const img = await renderSvg('<rect x="100" y="100" width="150" height="100" fill="#FFBB73"/>');
    const photo: Rect = { h: 120, w: 170, x: 90, y: 90 };
    const { blockResult } = await analyse(img, PAGE, [photo]);
    expect(blockResult.blocks).toHaveLength(0);
  });

  it('мелкая тёмная фигура (значок) заливкой не считается', async () => {
    const img = await renderSvg(
      '<circle cx="100" cy="100" r="24" fill="#2D3C82"/><rect x="95" y="94" width="10" height="12" fill="#FFFFFF"/>',
    );
    const { blockResult } = await analyse(img);
    expect(blockResult.blocks).toHaveLength(0);
  });
});

describe('радиусы скруглений', () => {
  it('формула по смещению во втором ряду точек: от 0 до больших радиусов', () => {
    expect(radiusFromOffset(0)).toBe(0);
    // r = 63,75 px (25 пт при 2,55): смещение o = r − √(3r − 2,25) ≈ 50 px
    expect(near(radiusFromOffset(50), 63.8, 1)).toBe(true);
    // монотонно растёт
    expect(radiusFromOffset(20)).toBeLessThan(radiusFromOffset(30));
  });

  it('карточка 24, белая кнопка 20 (почти не отличается от карточки), таблетка 23, тонкая рамка 5 — в пределах ±2 пт', async () => {
    const img = await renderSvg(CARD + WHITE_BUTTON + PILL + THIN_RING);
    const { blockResult } = await analyse(img);
    const sx = img.width / PAGE.width;
    const sy = img.height / PAGE.height;
    const radiiOf = (kind: string, color: string) => {
      const block = blockResult.blocks.find((b) => b.kind === kind && toHex(b.color) === color)!;
      return cornerRadii(
        img,
        sx,
        sy,
        { h: block.h, w: block.w, x: block.x, y: block.y },
        block.color,
      );
    };

    // карточка прижата к левому краю страницы: левые углы 24, правые тоже (x = 400 — край)
    const card = radiiOf('fill', '#F6F7FA');
    expect(card.every((value) => near(value, 24))).toBe(true);
    // белая кнопка на светло-серой карточке: допуск цвета по контрасту, иначе угол «слипся» бы с карточкой (радиус 0)
    const button = radiiOf('fill', '#FFFFFF');
    expect(button.every((value) => near(value, 20))).toBe(true);
    const pill = radiiOf('fill', '#FFBB73');
    expect(pill.every((value) => near(value, 23))).toBe(true);
    const ring = radiiOf('frame', '#CFD6E9');
    expect(ring.every((value) => near(value, 5))).toBe(true);
  });

  it('прямой угол — 0; угол, закрытый чем-то другим, — -1', async () => {
    const img = await renderSvg(
      '<rect x="20" y="20" width="100" height="60" fill="#DDEEF8"/>' +
        '<rect x="150" y="20" width="100" height="60" rx="20" fill="#DDEEF8"/>' +
        '<rect x="220" y="20" width="40" height="60" fill="#2D3C82"/>', // перекрывает правые углы второй
    );
    const sx = img.width / PAGE.width;
    const sy = img.height / PAGE.height;
    const color = fromHex('#DDEEF8');
    expect(cornerRadii(img, sx, sy, { h: 60, w: 100, x: 20, y: 20 }, color)).toEqual([0, 0, 0, 0]);
    const covered = cornerRadii(img, sx, sy, { h: 60, w: 100, x: 150, y: 20 }, color);
    expect(near(covered[0], 20)).toBe(true);
    expect(near(covered[3], 20)).toBe(true);
    expect(covered[1]).toBe(-1);
    expect(covered[2]).toBe(-1);
  });
});

describe('цвет текста', () => {
  const solid = (width: number, height: number, bg: [number, number, number]): RawImage => {
    const data = new Uint8Array(width * height * 3);
    for (let i = 0; i < width * height; i++) data.set(bg, i * 3);
    return { data, height, width };
  };
  const stripe = (img: RawImage, color: [number, number, number], x0: number, x1: number) => {
    for (let y = 8; y < img.height - 8; y++) {
      for (let x = x0; x < x1; x++) img.data.set(color, (y * img.width + x) * 3);
    }
  };

  it('тёмный текст на светлом, светлый на тёмном и на цветной заливке; самый частый цвет, а не кайма', () => {
    const dark = solid(200, 40, [255, 255, 255]);
    stripe(dark, [45, 60, 130], 20, 120);
    stripe(dark, [200, 205, 225], 120, 124); // сглаженная кайма: реже и слабее
    expect(toHex(textColor(dark, 1, 1, { h: 40, w: 200, x: 0, y: 0 })!)).toBe('#2D3C82');

    const light = solid(200, 40, [45, 60, 130]);
    stripe(light, [255, 255, 255], 20, 120);
    expect(toHex(textColor(light, 1, 1, { h: 40, w: 200, x: 0, y: 0 })!)).toBe('#FFFFFF');

    const onOrange = solid(200, 40, [255, 187, 115]);
    stripe(onOrange, [45, 60, 130], 20, 120);
    expect(toHex(textColor(onOrange, 1, 1, { h: 40, w: 200, x: 0, y: 0 })!)).toBe('#2D3C82');
  });

  it('пусто (нет заметных отличий от фона) — нет цвета', () => {
    expect(
      textColor(solid(100, 30, [250, 250, 250]), 1, 1, { h: 30, w: 100, x: 0, y: 0 }),
    ).toBeUndefined();
  });

  it('цвет берётся по масштабу картинки: рамка в пунктах страницы, пиксели — в 2,5×', () => {
    const img = solid(500, 100, [255, 255, 255]);
    stripe(img, [10, 20, 30], 100, 130);
    // рамка строки: x 40–80 пт = 100–200 px
    expect(toHex(textColor(img, 2.5, 2.5, { h: 40, w: 40, x: 40, y: 0 })!)).toBe('#0A141E');
  });
});

describe('видимая часть вшитой картинки', () => {
  // картинка-образец с рисунком, не повторяющим фон: диагональные полосы разных цветов
  const pattern = (width: number, height: number): RawImage => {
    const data = new Uint8Array(width * height * 3);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const band = Math.floor((x + y) / 7) % 4;
        const color = [
          [200, 60, 40],
          [40, 120, 200],
          [60, 160, 70],
          [230, 200, 50],
        ][band];
        data.set(color, (y * width + x) * 3);
      }
    }
    return { data, height, width };
  };

  const SX = 2;
  const place: Rect = { h: 200, w: 200, x: 100, y: 50 };
  // на странице фото обрезано рамкой карточки со скруглением 20 пт: видна только часть
  const visible: Rect = { h: 160, w: 150, x: 150, y: 70 };

  const pageWithMaskedPhoto = (
    photo: RawImage,
    { transparentOutside = false }: { transparentOutside?: boolean } = {},
  ) => {
    const width = 400 * SX;
    const height = 300 * SX;
    const data = new Uint8Array(width * height * 3).fill(255);
    const radius = 20 * SX;
    const x0 = visible.x * SX;
    const y0 = visible.y * SX;
    const x1 = (visible.x + visible.w) * SX;
    const y1 = (visible.y + visible.h) * SX;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        // скруглённые углы маски
        const cx = Math.min(Math.max(x, x0 + radius), x1 - radius);
        const cy = Math.min(Math.max(y, y0 + radius), y1 - radius);
        if ((x - cx) ** 2 + (y - cy) ** 2 > radius ** 2) continue;
        const from = ((y - place.y * SX) * photo.width + (x - place.x * SX)) * 3;
        data.set(photo.data.subarray(from, from + 3), (y * width + x) * 3);
      }
    }
    if (transparentOutside) {
      // у картинки с маской прозрачные места в файле чёрные (pdftohtml отдаёт её без маски)
      for (let y = 0; y < photo.height; y++) {
        for (let x = 0; x < photo.width; x++) {
          const px = x / SX + place.x;
          const py = y / SX + place.y;
          const inside =
            px >= visible.x &&
            px < visible.x + visible.w &&
            py >= visible.y &&
            py < visible.y + visible.h;
          if (!inside) photo.data.set([0, 0, 0], (y * photo.width + x) * 3);
        }
      }
    }
    return { data, height, width } as RawImage;
  };

  it('рамка карточки обрезает фото: видимая часть найдена по совпадению с нарисованной страницей (скругления — в пределах)', () => {
    const photo = pattern(place.w * SX, place.h * SX);
    const page = pageWithMaskedPhoto(photo);

    const result = visibleRect(page, SX, SX, place, photo);

    expect(result.ratio).toBeGreaterThan(0.3);
    expect(result.transparent).toBeLessThan(0.5);
    const rect = result.rect!;
    expect(near(rect.x, visible.x)).toBe(true);
    expect(near(rect.y, visible.y)).toBe(true);
    expect(near(rect.w, visible.w)).toBe(true);
    expect(near(rect.h, visible.h)).toBe(true);
  });

  it('место картинки выходит за край страницы: сравнивается только то, что на странице', () => {
    const photo = pattern(200 * SX, 200 * SX);
    // страница 400×300 пт; картинка выступает влево на 30 пт и целиком видна
    const offPlace: Rect = { h: 200, w: 200, x: -30, y: 40 };
    const width = 400 * SX;
    const height = 300 * SX;
    const data = new Uint8Array(width * height * 3).fill(255);
    for (let y = 0; y < photo.height; y++) {
      for (let x = 0; x < photo.width; x++) {
        const px = x + offPlace.x * SX;
        if (px < 0) continue;
        data.set(
          photo.data.subarray((y * photo.width + x) * 3, (y * photo.width + x) * 3 + 3),
          ((y + offPlace.y * SX) * width + px) * 3,
        );
      }
    }
    const result = visibleRect({ data, height, width }, SX, SX, offPlace, photo);
    expect(near(result.rect!.x, 0)).toBe(true);
    expect(near(result.rect!.w, 170)).toBe(true);
    expect(near(result.rect!.y, 40)).toBe(true);
    expect(near(result.rect!.h, 200)).toBe(true);
  });

  it('картинка с маской прозрачности (у неё чёрное вне видимого): признак «прозрачная» высокий — по совпадению её не искать', () => {
    const photo = pattern(place.w * SX, place.h * SX);
    const page = pageWithMaskedPhoto(photo, { transparentOutside: true });
    const result = visibleRect(page, SX, SX, place, photo);
    expect(result.transparent).toBeGreaterThan(0.9);
  });

  it('картинки на странице нет (ничего не совпало) — видимой части нет', () => {
    const photo = pattern(100 * SX, 100 * SX);
    const blank: RawImage = {
      data: new Uint8Array(400 * SX * 300 * SX * 3).fill(255),
      height: 300 * SX,
      width: 400 * SX,
    };
    const result = visibleRect(blank, SX, SX, { h: 100, w: 100, x: 10, y: 10 }, photo);
    expect(result.rect).toBeUndefined();
    expect(result.ratio).toBeLessThan(0.1);
  });
});

describe('чернила: векторные значки и логотипы', () => {
  // значок «Профиль»: тёмный человечек в кнопке с тонкой рамкой; низ значка в 4 пт от нижней рамки кнопки
  const BUTTON =
    '<rect x="20.5" y="35.5" width="148" height="43" rx="5" fill="none" stroke="#CFD6E9" stroke-width="1"/>';
  const PERSON =
    '<circle cx="48" cy="52" r="9" fill="#2D3C82"/><path d="M34 74 Q48 56 62 74 Z" fill="#2D3C82"/>';

  const inkRects = async (body: string, masked: Rect[] = []) => {
    const img = await renderSvg(body);
    const { background, blockResult, grid, regionMap } = await analyse(img);
    return {
      blocks: blockResult.blocks,
      rects: findInkRects(grid, {
        background,
        blocks: blockResult.blocks,
        flat: blockResult.flat,
        labels: regionMap.labels,
        masked,
      }),
    };
  };

  it('значок рядом с рамкой кнопки: вырезка — по чернилам значка, рамка кнопки в неё не попадает', async () => {
    const { blocks, rects } = await inkRects(BUTTON + PERSON);

    const ring = blocks.find((b) => b.kind === 'frame')!;
    expect(ring).toBeDefined();
    expect(rects).toHaveLength(1);
    const icon = rects[0];
    // значок целиком внутри кнопки, не касается её рамки (отступ от рамки не меньше 3 пт)
    expect(icon.x).toBeGreaterThanOrEqual(ring.x + 3);
    expect(icon.y).toBeGreaterThanOrEqual(ring.y + 3);
    expect(icon.x + icon.w).toBeLessThanOrEqual(ring.x + ring.w - 3);
    expect(icon.y + icon.h).toBeLessThanOrEqual(ring.y + ring.h - 3);
    // и это сам значок: голова и плечи
    expect(near(icon.x, 34, 2)).toBe(true);
    expect(near(icon.y, 43, 2)).toBe(true);
    expect(near(icon.w, 28, 3)).toBe(true);
    expect(near(icon.h, 31, 3)).toBe(true);
  });

  it('углы скруглений (кайма) и края карточек значками не становятся', async () => {
    const { rects } = await inkRects(CARD + WHITE_BUTTON + PILL + THIN_RING + THICK_RING + RULE);
    expect(rects).toEqual([]);
  });

  it('значок на цветной кнопке: от фона самой кнопки, а не страницы', async () => {
    const { rects } = await inkRects(PILL + '<path d="M150 170 l14 14 l-14 14 z" fill="#2D3C82"/>');
    expect(rects).toHaveLength(1);
    expect(near(rects[0].x, 150, 2)).toBe(true);
    expect(near(rects[0].w, 14, 2)).toBe(true);
  });

  it('строки текста и видимые фото в чернила не входят (маска); части значка за 3 пт склеиваются', async () => {
    const parts =
      '<rect x="100" y="100" width="12" height="12" fill="#2D3C82"/><rect x="116" y="100" width="12" height="12" fill="#2D3C82"/>';
    const withParts = await inkRects(parts);
    expect(withParts.rects).toHaveLength(1);
    expect(near(withParts.rects[0].w, 28, 2)).toBe(true);

    const masked = await inkRects(parts, [{ h: 40, w: 100, x: 90, y: 90 }]);
    expect(masked.rects).toEqual([]);
  });

  it('мельче 6×6 пт отбрасывается', async () => {
    const { rects } = await inkRects('<rect x="100" y="100" width="4" height="4" fill="#2D3C82"/>');
    expect(rects).toEqual([]);
  });
});
