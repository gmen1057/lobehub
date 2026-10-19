import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';

import { PDF_PREP_VERSION, type PdfPrepRecord } from '../../aiAgent/pdfPrepare';
import { buildMockup, loadMockPicture } from '../mockup';

// arckep (19.10.2026): макет для сверки из записи подготовки PDF (files.metadata.pdfPrep).

type Layout = NonNullable<PdfPrepRecord['layout']>;
type LayoutPage = Layout['pages'][number];

const address = (fileId: string) => `https://arckep.ru/chat/f/${fileId}/`;

const layoutPage = (extra: Partial<LayoutPage> = {}): LayoutPage => ({
  background: '#FFFFFF',
  blocks: [
    { color: '#DDEEF8', h: 300, kind: 'fill', w: 600, x: 0, y: 100 },
    { color: '#2D3C82', h: 1, kind: 'line', w: 600, x: 0, y: 450 },
  ],
  crops: [
    { fileId: 'file_P1', h: 200, kind: 'photo', mime: 'image/jpeg', w: 600, x: 0, y: 100 },
    { fileId: 'file_I1', h: 40, kind: 'icon', mime: 'image/png', w: 40, x: 20, y: 20 },
    { fileId: 'file_P2', h: 150, kind: 'photo', mime: 'image/jpeg', w: 150, x: 20, y: 320 },
  ],
  height: 1200,
  lines: [
    { bold: true, size: 20, text: 'Заголовок', w: 100, x: 20, y: 60 },
    { center: true, size: 16, text: 'По центру', w: 120, x: 240, y: 500 },
  ],
  page: 1,
  width: 603,
  ...extra,
});

const record = (pages: LayoutPage[], extra: Partial<PdfPrepRecord> = {}): PdfPrepRecord => ({
  layout: { pages },
  startedAt: 0,
  status: 'done',
  version: PDF_PREP_VERSION,
  ...extra,
});

describe('макет для сверки', () => {
  it('строки, блоки и вырезки с адресами и подписями «фото N» / «значок N» как в блоке <layout>', () => {
    const mockup = buildMockup(record([layoutPage()]), address)!;
    expect(mockup.height).toBe(1200);
    expect(mockup.lines).toEqual([
      { bold: true, center: undefined, size: 20, text: 'Заголовок', w: 100, x: 20, y: 60 },
      { bold: undefined, center: true, size: 16, text: 'По центру', w: 120, x: 240, y: 500 },
    ]);
    expect(mockup.blocks).toHaveLength(2);
    expect(mockup.crops.map((crop) => [crop.label, crop.url])).toEqual([
      ['фото 1', 'https://arckep.ru/chat/f/file_P1/'],
      ['значок 1', 'https://arckep.ru/chat/f/file_I1/'],
      ['фото 2', 'https://arckep.ru/chat/f/file_P2/'],
    ]);
  });

  it('окно письма: колонка содержимого x0–600 при странице 603 → 600 px', () => {
    expect(buildMockup(record([layoutPage()]), address)!.width).toBe(600);
  });

  it('колонка по центру (содержимое не прижато к левому краю) → окно в ширину страницы', () => {
    const centered = layoutPage({
      blocks: [{ color: '#EEE', h: 100, kind: 'fill', w: 560, x: 20, y: 10 }],
      crops: [],
    });
    expect(buildMockup(record([centered]), address)!.width).toBe(603);
  });

  it('окно не уже 320 и не шире 1600', () => {
    expect(
      buildMockup(record([layoutPage({ blocks: [], crops: [], width: 200 })]), address)!.width,
    ).toBe(320);
    expect(
      buildMockup(record([layoutPage({ blocks: [], crops: [], width: 2400 })]), address)!.width,
    ).toBe(1600);
  });

  it('несколько страниц ставятся друг под другом: сдвиг по y и подпись с номером страницы', () => {
    const second = layoutPage({
      crops: [
        { fileId: 'file_P3', h: 100, kind: 'photo', mime: 'image/jpeg', w: 100, x: 0, y: 10 },
      ],
      height: 800,
      lines: [{ size: 16, text: 'Вторая', w: 50, x: 20, y: 30 }],
      page: 2,
    });
    const mockup = buildMockup(record([second, layoutPage()]), address)!;
    expect(mockup.height).toBe(2000);
    const line = mockup.lines.find((item) => item.text === 'Вторая')!;
    expect(line.y).toBe(1230);
    const crop = mockup.crops.find((item) => item.url.endsWith('file_P3/'))!;
    expect(crop.y).toBe(1210);
    expect(crop.label).toBe('фото 1 (стр. 2)');
  });

  it('нет описания или в нём пусто — макета нет', () => {
    expect(buildMockup({ ...record([]), layout: undefined }, address)).toBeUndefined();
    expect(buildMockup(record([]), address)).toBeUndefined();
    expect(buildMockup(record([layoutPage({ crops: [], lines: [] })]), address)).toBeUndefined();
  });
});

describe('картинка макета из кусков страниц', () => {
  const piece = async (width: number, height: number, color: [number, number, number]) =>
    sharp({
      create: { background: { b: color[2], g: color[1], r: color[0] }, channels: 3, height, width },
    })
      .png()
      .toBuffer();

  it('куски читаются из хранилища по ключу и склеиваются в ширину окна', async () => {
    const page = layoutPage({ blocks: [], crops: [], height: 100, width: 100 });
    const files: Record<string, Buffer> = {
      'k/top.png': await piece(100, 60, [255, 0, 0]),
      'k/bottom.png': await piece(100, 60, [0, 0, 255]),
    };
    const read = vi.fn(async (key: string) => files[key]);
    const picture = await loadMockPicture(
      record([page], {
        pages: [
          {
            fileId: 'a',
            fromPt: 0,
            height: 60,
            index: 1,
            key: 'k/top.png',
            mime: 'image/png',
            page: 1,
            toPt: 60,
            total: 2,
            width: 100,
          },
          {
            fileId: 'b',
            fromPt: 40,
            height: 60,
            index: 2,
            key: 'k/bottom.png',
            mime: 'image/png',
            page: 1,
            toPt: 100,
            total: 2,
            width: 100,
          },
        ],
      }),
      read,
      100,
    );
    expect(read).toHaveBeenCalledTimes(2);
    expect(picture).toMatchObject({ height: 100, width: 100 });
    // верх красный, низ синий (нижний кусок перекрывает верхний с y=40)
    expect(Array.from(picture!.data.subarray(10 * 100 * 3, 10 * 100 * 3 + 3))).toEqual([255, 0, 0]);
    expect(Array.from(picture!.data.subarray(90 * 100 * 3, 90 * 100 * 3 + 3))).toEqual([0, 0, 255]);
  });

  it('страниц-картинок нет — картинки макета нет (похожесть не считается)', async () => {
    const read = vi.fn();
    expect(await loadMockPicture(record([layoutPage()]), read, 600)).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });

  it('ошибка чтения куска не глотается: исключение уходит вызывающему', async () => {
    const read = vi.fn(async () => {
      throw new Error('нет файла');
    });
    await expect(
      loadMockPicture(
        record([layoutPage()], {
          pages: [
            {
              fileId: 'a',
              height: 10,
              index: 1,
              key: 'k',
              mime: 'image/png',
              page: 1,
              total: 1,
              width: 10,
            },
          ],
        }),
        read,
        600,
      ),
    ).rejects.toThrow('нет файла');
  });
});
