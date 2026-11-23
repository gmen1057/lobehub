/* eslint-disable unicorn/text-encoding-identifier-case */
// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  decodeSourceText,
  detectLineEnding,
  encodeSourceText,
  TextEncodingError,
} from './textEncoding';

// Helper to encode a Russian CP1251 string into raw bytes without external dependencies.
const encodeCp1251 = (text: string): Uint8Array => {
  const bytes: number[] = [];
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code < 0x80) {
      bytes.push(code);
    } else if (code >= 0x0410 && code <= 0x042f) {
      // А..Я -> 0xC0..0xDF
      bytes.push(code - 0x0410 + 0xc0);
    } else if (code >= 0x0430 && code <= 0x044f) {
      // а..я -> 0xE0..0xFF
      bytes.push(code - 0x0430 + 0xe0);
    } else if (code === 0x0401) {
      bytes.push(0xa8); // Ё
    } else if (code === 0x0451) {
      bytes.push(0xb8); // ё
    } else if (code === 0x2116) {
      bytes.push(0xb9); // №
    } else if (code === 0x00ab) {
      bytes.push(0xab); // «
    } else if (code === 0x00bb) {
      bytes.push(0xbb); // »
    } else if (code === 0x2014) {
      bytes.push(0x97); // —
    } else if (code === 0x2026) {
      bytes.push(0x85); // …
    } else {
      throw new Error(`Unsupported char in test helper: ${ch} (U+${code.toString(16)})`);
    }
  }
  return Uint8Array.from(bytes);
};

describe('decodeSourceText', () => {
  it('decodes UTF-8 without BOM and detects LF line endings', () => {
    const source = "Sub Calc()\n  ' Привет, мир! 🚀\nEnd Sub\n";
    const result = decodeSourceText(new TextEncoder().encode(source));

    expect(result).toEqual({
      encoding: 'utf-8',
      lineEnding: 'LF',
      text: source,
    });
  });

  it('decodes UTF-8 with BOM, preserving BOM in text and detecting CRLF', () => {
    const source = '\uFEFFAttribute VB_Name = "Module1"\r\nSub Run()\r\nEnd Sub\r\n';
    const bytes = new TextEncoder().encode(source);
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);

    const result = decodeSourceText(bytes);
    expect(result).toEqual({
      encoding: 'utf-8-bom',
      lineEnding: 'CRLF',
      text: source,
    });
  });

  it('decodes Windows-1251 Russian text from Excel/VBA/1C exports with CRLF', () => {
    const source =
      'Attribute VB_Name = "Начисления"\r\n' +
      "' Счёт № 12 — «Итоговый расчёт» ёлок…\r\n" +
      'Sub ПосчитатьСкидку()\r\n' +
      'End Sub\r\n';
    const bytes = encodeCp1251(source);

    const result = decodeSourceText(bytes);
    expect(result).toEqual({
      encoding: 'windows-1251',
      lineEnding: 'CRLF',
      text: source,
    });
    expect(result.text).not.toContain('\uFFFD');
  });

  it('handles empty buffer and allowed whitespace control characters (\\t, \\v, \\f, \\r, \\n)', () => {
    expect(decodeSourceText(new Uint8Array())).toEqual({
      encoding: 'utf-8',
      lineEnding: 'LF',
      text: '',
    });

    const whitespaceText = 'col1\tcol2\vcol3\f\r\nval1\tval2\r\n';
    const result = decodeSourceText(new TextEncoder().encode(whitespaceText));
    expect(result.text).toBe(whitespaceText);
    expect(result.lineEnding).toBe('CRLF');
  });

  it('rejects binary files with NUL or disallowed control bytes', () => {
    const withNul = Uint8Array.from([0x41, 0x42, 0x00, 0x43]);
    expect(() => decodeSourceText(withNul)).toThrowError(TextEncodingError);
    try {
      decodeSourceText(withNul);
    } catch (e) {
      expect((e as TextEncodingError).code).toBe('binary_content');
    }

    // Control bytes 0x01..0x08, 0x0E..0x1F, and 0x7F (DEL)
    for (const ctrl of [0x01, 0x07, 0x08, 0x0e, 0x1b, 0x1f, 0x7f]) {
      const buf = Uint8Array.from([0x61, ctrl, 0x62]);
      expect(() => decodeSourceText(buf)).toThrowError(TextEncodingError);
      try {
        decodeSourceText(buf);
      } catch (e) {
        expect((e as TextEncodingError).code).toBe('binary_content');
      }
    }
  });

  it('rejects buffers containing invalid CP1251 byte 0x98', () => {
    // Cyrillic bytes mixed with undefined 0x98 byte
    const bytes = Uint8Array.from([...encodeCp1251('Привет'), 0x98, ...encodeCp1251('мир')]);
    expect(() => decodeSourceText(bytes)).toThrowError(TextEncodingError);
    try {
      decodeSourceText(bytes);
    } catch (e) {
      expect((e as TextEncodingError).code).toBe('unsupported_encoding');
    }
  });

  it('rejects mixed high-byte garbage below 75% CP1251 Cyrillic/typography threshold', () => {
    // Only 2 of 8 high bytes are Cyrillic (25% < 75%)
    const garbage = Uint8Array.from([0x41, 0x80, 0x81, 0x82, 0x83, 0xa1, 0xa2, 0xc0, 0xc1, 0x42]);
    expect(() => decodeSourceText(garbage)).toThrowError(TextEncodingError);
    try {
      decodeSourceText(garbage);
    } catch (e) {
      expect((e as TextEncodingError).code).toBe('unsupported_encoding');
    }
  });

  it('decodes single CP1251 Cyrillic or typography byte (synced with studio upload check) and rejects non-Cyrillic high byte', () => {
    const singleCyrillic = encodeCp1251('Const RUB = "р"\r\n');
    expect(decodeSourceText(singleCyrillic)).toEqual({
      encoding: 'windows-1251',
      lineEnding: 'CRLF',
      text: 'Const RUB = "р"\r\n',
    });

    const singleNumero = encodeCp1251('Order №1\n');
    expect(decodeSourceText(singleNumero)).toEqual({
      encoding: 'windows-1251',
      lineEnding: 'LF',
      text: 'Order №1\n',
    });

    const singleNonCyrillic = Uint8Array.from([0x63, 0x61, 0x66, 0xa0]);
    expect(() => decodeSourceText(singleNonCyrillic)).toThrowError(TextEncodingError);
    try {
      decodeSourceText(singleNonCyrillic);
    } catch (e) {
      expect((e as TextEncodingError).code).toBe('unsupported_encoding');
    }
  });

  it('detects mixed line endings according to majority CRLF vs lone LF rule', () => {
    expect(detectLineEnding('a\r\nb\nc')).toBe('CRLF'); // 1 CRLF >= 1 lone LF
    expect(detectLineEnding('a\r\nb\nc\nd')).toBe('LF'); // 1 CRLF < 2 lone LF
    expect(detectLineEnding('single line')).toBe('LF');
  });
});

describe('encodeSourceText', () => {
  it('round-trips UTF-8 with LF and CRLF normalization', () => {
    const source = 'Процедура Тест()\r\n  Сообщить("Привет 🚀");\rКонецПроцедуры\n';

    const lfBytes = encodeSourceText(source, 'utf-8', 'LF');
    expect(decodeSourceText(lfBytes)).toEqual({
      encoding: 'utf-8',
      lineEnding: 'LF',
      text: 'Процедура Тест()\n  Сообщить("Привет 🚀");\nКонецПроцедуры\n',
    });

    const crlfBytes = encodeSourceText(source, 'utf-8', 'CRLF');
    expect(decodeSourceText(crlfBytes)).toEqual({
      encoding: 'utf-8',
      lineEnding: 'CRLF',
      text: 'Процедура Тест()\r\n  Сообщить("Привет 🚀");\r\nКонецПроцедуры\r\n',
    });
  });

  it('round-trips UTF-8 with BOM (1C .bsl style) without duplicating leading BOM', () => {
    const bslSource =
      '&НаСервере\nПроцедура ПриСозданииНаСервере(Отказ)\n\tЗапрос = Новый Запрос;\nКонецПроцедуры\n';
    const encoded = encodeSourceText(bslSource, 'utf-8-bom', 'CRLF');

    expect(Array.from(encoded.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    const decoded = decodeSourceText(encoded);
    expect(decoded.encoding).toBe('utf-8-bom');
    expect(decoded.lineEnding).toBe('CRLF');
    expect(decoded.text).toBe(
      '\uFEFF&НаСервере\r\nПроцедура ПриСозданииНаСервере(Отказ)\r\n\tЗапрос = Новый Запрос;\r\nКонецПроцедуры\r\n',
    );

    // Re-encoding decoded.text must preserve exactly a single 3-byte BOM
    const reencoded = encodeSourceText(decoded.text, decoded.encoding, decoded.lineEnding);
    expect(reencoded).toEqual(encoded);
  });

  it('round-trips Windows-1251 Russian text, 1C .bsl, Ё/ё, №, «», and — cleanly', () => {
    const cp1251Text =
      '&НаКлиенте\r\n' +
      '// Документ № 42 — «Расчёт Ёлки и ёжика»…\r\n' +
      'Процедура ВыгрузитьОтчёт()\r\n' +
      '\tСообщить("Итого по счёту № 42 — выполнено");\r\n' +
      'КонецПроцедуры\r\n';

    const bytes = encodeSourceText(cp1251Text, 'windows-1251', 'CRLF');
    expect(bytes).toEqual(encodeCp1251(cp1251Text));

    const decoded = decodeSourceText(bytes);
    expect(decoded).toEqual({
      encoding: 'windows-1251',
      lineEnding: 'CRLF',
      text: cp1251Text,
    });

    // Convert CRLF -> LF in Windows-1251
    const lfBytes = encodeSourceText(decoded.text, 'windows-1251', 'LF');
    expect(decodeSourceText(lfBytes)).toEqual({
      encoding: 'windows-1251',
      lineEnding: 'LF',
      text: cp1251Text.replaceAll('\r\n', '\n'),
    });
  });

  it('throws UNREPRESENTABLE_CHAR_IN_CP1251 with character and code point details for emojis, CJK, and symbols outside CP1251', () => {
    for (const [sample, expectedHex] of [
      ['Привет 🚀', 'U+1F680'],
      ['Сумма: 中', 'U+4E2D'],
      ['Статус: ✓', 'U+2713'],
      ['Цена £10', 'U+00A3'],
    ] as const) {
      expect(() => encodeSourceText(sample, 'windows-1251', 'LF')).toThrowError(TextEncodingError);
      try {
        encodeSourceText(sample, 'windows-1251', 'LF');
      } catch (err) {
        const encodingErr = err as TextEncodingError;
        expect(encodingErr.code).toBe('UNREPRESENTABLE_CHAR_IN_CP1251');
        expect(encodingErr.message).toContain(expectedHex);
        expect(encodingErr.message).toContain('cannot be encoded in windows-1251');
      }
    }

    // Default error message check when constructed without custom message
    const defaultErr = new TextEncodingError('UNREPRESENTABLE_CHAR_IN_CP1251');
    expect(defaultErr.code).toBe('UNREPRESENTABLE_CHAR_IN_CP1251');
    expect(defaultErr.message).toContain('windows-1251');
  });

  it('rejects unpaired UTF-16 surrogates with unsupported_encoding', () => {
    for (const malformed of ['abc\uD800def', 'abc\uDC00def', 'end\uD83D']) {
      expect(() => encodeSourceText(malformed, 'utf-8', 'LF')).toThrowError(TextEncodingError);
      try {
        encodeSourceText(malformed, 'utf-8', 'LF');
      } catch (err) {
        expect((err as TextEncodingError).code).toBe('unsupported_encoding');
      }
    }
  });
});
