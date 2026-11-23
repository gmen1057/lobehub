/* eslint-disable unicorn/text-encoding-identifier-case */
export type SourceTextEncoding = 'utf-8' | 'utf-8-bom' | 'windows-1251';
export type SourceLineEnding = 'CRLF' | 'LF';
export type TextEncodingErrorCode =
  'binary_content' | 'UNREPRESENTABLE_CHAR_IN_CP1251' | 'unsupported_encoding';

export interface DecodedSourceText {
  encoding: SourceTextEncoding;
  lineEnding: SourceLineEnding;
  text: string;
}

const getDefaultEncodingErrorMessage = (code: TextEncodingErrorCode): string => {
  switch (code) {
    case 'binary_content': {
      return 'Binary or disallowed control bytes detected in source content.';
    }
    case 'UNREPRESENTABLE_CHAR_IN_CP1251': {
      return 'Source text contains characters that cannot be encoded in windows-1251.';
    }
    default: {
      return 'Unsupported text encoding; expected UTF-8 or Windows-1251.';
    }
  }
};

export class TextEncodingError extends Error {
  readonly code: TextEncodingErrorCode;

  constructor(code: TextEncodingErrorCode, message?: string) {
    super(message ?? getDefaultEncodingErrorMessage(code));
    this.name = 'TextEncodingError';
    this.code = code;
  }
}

const MIN_CP1251_HIGH_BYTES = 1;
const MIN_CP1251_VALID_RATIO = 0.75;
const UTF8_BOM_BYTES = [0xef, 0xbb, 0xbf] as const;

let cp1251ReverseMap: Map<number, number> | null = null;

const getCp1251ReverseMap = (): Map<number, number> => {
  if (cp1251ReverseMap) return cp1251ReverseMap;

  const decoder = new TextDecoder('windows-1251', { fatal: true });
  const map = new Map<number, number>();
  const singleByte = new Uint8Array(1);

  for (let byte = 0x80; byte <= 0xff; byte++) {
    if (byte === 0x98) continue;
    singleByte[0] = byte;
    const decoded = decoder.decode(singleByte);
    const codePoint = decoded.codePointAt(0);
    if (codePoint !== undefined) {
      map.set(codePoint, byte);
    }
  }

  cp1251ReverseMap = map;
  return map;
};

const hasUnpairedSurrogate = (text: string): boolean => {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (i + 1 >= text.length) return true;
      const next = text.charCodeAt(i + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
};

const isBinaryControlByte = (byte: number): boolean =>
  byte === 0x00 ||
  (byte >= 0x01 && byte <= 0x08) ||
  (byte >= 0x0e && byte <= 0x1f) ||
  byte === 0x7f;

const isCp1251CyrillicOrTypography = (byte: number): boolean =>
  (byte >= 0xc0 && byte <= 0xff) ||
  byte === 0xa8 || // Ё
  byte === 0xb8 || // ё
  byte === 0x85 || // …
  (byte >= 0x91 && byte <= 0x97) || // ‘ ’ “ ” • – —
  byte === 0x99 || // ™
  byte === 0xab || // «
  byte === 0xbb || // »
  byte === 0xb9; // №

export const detectLineEnding = (text: string): SourceLineEnding => {
  let crlfCount = 0;
  let loneLfCount = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      if (i > 0 && text.charCodeAt(i - 1) === 13) {
        crlfCount++;
      } else {
        loneLfCount++;
      }
    }
  }
  return crlfCount > 0 && crlfCount >= loneLfCount ? 'CRLF' : 'LF';
};

/**
 * Strictly decodes source text bytes as UTF-8 (with optional BOM) or Windows-1251.
 * Rejects binary/control bytes and non-Cyrillic arbitrary single-byte encodings.
 */
export function decodeSourceText(bytes: Uint8Array): DecodedSourceText {
  for (let i = 0; i < bytes.length; i++) {
    if (isBinaryControlByte(bytes[i])) {
      throw new TextEncodingError('binary_content');
    }
  }

  const hasUtf8Bom =
    bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;

  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    return {
      encoding: hasUtf8Bom ? 'utf-8-bom' : 'utf-8',
      lineEnding: detectLineEnding(text),
      text,
    };
  } catch {
    // Fall through to strict Windows-1251 check.
  }

  let highByteCount = 0;
  let validCp1251Count = 0;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    if (byte === 0x98) {
      throw new TextEncodingError('unsupported_encoding');
    }
    if (byte >= 0x80) {
      highByteCount++;
      if (isCp1251CyrillicOrTypography(byte)) {
        validCp1251Count++;
      }
    }
  }

  if (
    highByteCount < MIN_CP1251_HIGH_BYTES ||
    validCp1251Count / highByteCount < MIN_CP1251_VALID_RATIO
  ) {
    throw new TextEncodingError('unsupported_encoding');
  }

  try {
    const text = new TextDecoder('windows-1251', { fatal: true }).decode(bytes);
    return {
      encoding: 'windows-1251',
      lineEnding: detectLineEnding(text),
      text,
    };
  } catch {
    throw new TextEncodingError('unsupported_encoding');
  }
}

/**
 * Strictly encodes text into UTF-8, UTF-8 with BOM, or Windows-1251 with normalized line endings.
 */
export function encodeSourceText(
  text: string,
  encoding: SourceTextEncoding = 'utf-8',
  lineEnding: SourceLineEnding = 'LF',
): Uint8Array {
  const lfNormalized = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const normalized = lineEnding === 'CRLF' ? lfNormalized.replaceAll('\n', '\r\n') : lfNormalized;

  if (hasUnpairedSurrogate(normalized)) {
    throw new TextEncodingError(
      'unsupported_encoding',
      'Source text contains unpaired UTF-16 surrogate code units.',
    );
  }

  if (encoding === 'utf-8') {
    return new TextEncoder().encode(normalized);
  }

  if (encoding === 'utf-8-bom') {
    const body = normalized.startsWith('\uFEFF') ? normalized.slice(1) : normalized;
    const utf8Bytes = new TextEncoder().encode(body);
    const result = new Uint8Array(UTF8_BOM_BYTES.length + utf8Bytes.length);
    result.set(UTF8_BOM_BYTES, 0);
    result.set(utf8Bytes, UTF8_BOM_BYTES.length);
    return result;
  }

  if (encoding === 'windows-1251') {
    const reverseMap = getCp1251ReverseMap();
    const out = new Uint8Array(normalized.length);
    let idx = 0;

    for (const ch of normalized) {
      const cp = ch.codePointAt(0)!;
      if (cp <= 0x7f) {
        out[idx++] = cp;
        continue;
      }

      const mapped = reverseMap.get(cp);
      if (mapped === undefined) {
        throw new TextEncodingError(
          'UNREPRESENTABLE_CHAR_IN_CP1251',
          `Character "${ch}" (U+${cp.toString(16).toUpperCase().padStart(4, '0')}) cannot be encoded in windows-1251`,
        );
      }
      out[idx++] = mapped;
    }

    return idx === out.length ? out : out.subarray(0, idx);
  }

  throw new TextEncodingError('unsupported_encoding');
}
