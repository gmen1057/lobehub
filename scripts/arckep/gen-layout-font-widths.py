#!/usr/bin/env python3
"""arckep (19.10.2026): таблица ширин символов Arial (Liberation Sans Regular и Bold) для подсказки шрифта в
описании макета PDF (src/server/services/aiAgent/pdfLayout.ts). Запускается один раз вручную:

  python3 scripts/arckep/gen-layout-font-widths.py > src/server/services/aiAgent/layoutFontWidths.json

Ширины в тысячных долях em (целые). Состав: латиница, кириллица, цифры, знаки препинания и частые символы.
"""
import json
from fontTools.ttLib import TTFont

DIR = '/usr/share/fonts/truetype/liberation/'
CHARS = (
    [chr(c) for c in range(0x20, 0x7F)]
    + [chr(c) for c in range(0x410, 0x450)]
    + ['Ё', 'ё', 'І', 'і', 'Ї', 'ї', 'Є', 'є']
    + list('—–‑‒«»“”„‘’‚№…•·₽€£¥°±×÷≈≤≥¼½¾©®™§¶†‡‰′″¿¡ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÑÒÓÔÕÖØÙÚÛÜÝßàáâãäåæçèéêëìíîïñòóôõöøùúûüýÿ')
    + [' ', ' ', ' ']
)


def table(path):
    font = TTFont(path)
    cmap = font.getBestCmap()
    hmtx = font['hmtx']
    units = font['head'].unitsPerEm
    out = {}
    for ch in CHARS:
        glyph = cmap.get(ord(ch))
        if glyph is None:
            continue
        out[ch] = round(hmtx[glyph][0] * 1000 / units)
    return out


print(json.dumps({
    'bold': table(DIR + 'LiberationSans-Bold.ttf'),
    'fallback': 560,
    'regular': table(DIR + 'LiberationSans-Regular.ttf'),
}, ensure_ascii=False, indent=0, sort_keys=True))
