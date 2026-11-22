// eslint-disable-next-line unicorn/text-encoding-identifier-case
export type SourceTextEncoding = 'utf-8' | 'utf-8-bom' | 'windows-1251';
export type SourceLineEnding = 'CRLF' | 'LF';
export type TextEncodingErrorCode = 'binary_content' | 'unsupported_encoding';

export interface DecodedSourceText {
  encoding: SourceTextEncoding;
  lineEnding: SourceLineEnding;
  text: string;
}

export class TextEncodingError extends Error {
  readonly code: TextEncodingErrorCode;

  constructor(code: TextEncodingErrorCode, message?: string) {
    super(
      message ??
        (code === 'binary_content'
          ? 'Binary or disallowed control bytes detected in source content.'
          : 'Unsupported text encoding; expected UTF-8 or Windows-1251.'),
    );
    this.name = 'TextEncodingError';
    this.code = code;
  }
}

const MIN_CP1251_HIGH_BYTES = 2;
const MIN_CP1251_VALID_RATIO = 0.75;

const isBinaryControlByte = (byte: number): boolean =>
  byte === 0x00 || (byte >= 0x01 && byte <= 0x08) || (byte >= 0x0e && byte <= 0x1f);

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
      // eslint-disable-next-line unicorn/text-encoding-identifier-case
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
