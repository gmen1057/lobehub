import { normalizeWorkspacePath, WorkspaceError } from './paths';

export const SOFT_WARN_PINNED_TOKENS = 4000;
export const HARD_MAX_PINNED_CHARS = 60_000;
export const HARD_MAX_PINNED_TOKENS = 24_000;
export const MAX_WORKSPACE_TEXT_BYTES = 2_097_152;
export const MAX_WORKSPACE_DOCUMENT_BYTES = 20_971_520;
export const MAX_WORKSPACE_ACTIVE_FILES = 200;
export const MAX_WORKSPACE_ACTIVE_BYTES = 262_144_000;
export const MAX_REVISIONS_KEEP = 30;
export const MAX_PROJECT_HISTORY_BYTES = 524_288_000;
export const MAX_USER_WORKSPACE_BYTES = 2_147_483_648;
export const MAX_AGENT_WRITES_PER_RUN = 20;

export function isWorkspaceEnabled(): boolean {
  const flag = process.env.ARCKEP_WORKSPACE_ENABLED;
  return flag === '1' || flag === 'true';
}

/**
 * Deterministic token estimator shared byte-for-byte across Engine, Studio, Web, and Mobile (`R2-3`).
 */
export function estimateWorkspaceTokens(text: string): number {
  if (!text) return 0;
  let total = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp <= 0x00_7f) {
      total += 0.25;
    } else if (
      (cp >= 0x00_80 && cp <= 0x07_ff) ||
      (cp >= 0x20_00 && cp <= 0x20_6f) ||
      cp === 0x21_16
    ) {
      total += 0.45;
    } else {
      total += 1;
    }
  }
  return Math.ceil(total);
}

export const CODE_EXTENSIONS = [
  'bas',
  'cls',
  'py',
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'sql',
  'json',
  'yaml',
  'yml',
  'xml',
  'toml',
  'ini',
  'cfg',
  'css',
  'scss',
  'sh',
  'ps1',
  'bsl',
  'go',
  'rs',
  'java',
  'kt',
  'c',
  'cpp',
  'h',
  'hpp',
  'cs',
  'php',
  'rb',
  'swift',
  'lua',
  'log',
] as const;

export const BASE_TEXT_EXTENSIONS = ['txt', 'md', 'csv'] as const;

export const PROJECT_TEXT_EXTENSIONS = [
  'mdx',
  'tsv',
  'jsonl',
  'ndjson',
  'prisma',
  'graphql',
  'gql',
  'proto',
] as const;

export const EXTENSIONLESS_TEXT_NAMES = ['dockerfile', 'makefile'] as const;

export const DOCUMENT_EXTENSIONS = ['pdf', 'docx', 'xlsx', 'pptx'] as const;

export const ALLOWED_WORKSPACE_TEXT_EXTENSIONS: ReadonlySet<string> = new Set<string>([
  ...CODE_EXTENSIONS,
  ...BASE_TEXT_EXTENSIONS,
  ...PROJECT_TEXT_EXTENSIONS,
]);

export const ALLOWED_EXTENSIONLESS_TEXT_NAMES: ReadonlySet<string> = new Set<string>(
  EXTENSIONLESS_TEXT_NAMES,
);

export const ALLOWED_WORKSPACE_DOCUMENT_EXTENSIONS: ReadonlySet<string> = new Set<string>(
  DOCUMENT_EXTENSIONS,
);

export const extractWorkspaceBasenameAndExt = (
  normalizedPath: string,
): { basename: string; ext: string | null } => {
  const slashIdx = normalizedPath.lastIndexOf('/');
  const basename = slashIdx >= 0 ? normalizedPath.slice(slashIdx + 1) : normalizedPath;
  const lowerBase = basename.toLowerCase();
  const dotIdx = lowerBase.lastIndexOf('.');
  if (dotIdx <= 0 || dotIdx === lowerBase.length - 1) {
    return { basename, ext: null };
  }
  return { basename, ext: lowerBase.slice(dotIdx + 1) };
};

export function isAllowedWorkspaceTextPath(normalizedPath: string): boolean {
  const { basename, ext } = extractWorkspaceBasenameAndExt(normalizedPath);
  if (ext !== null) {
    return ALLOWED_WORKSPACE_TEXT_EXTENSIONS.has(ext);
  }
  if (basename.includes('.')) {
    return false;
  }
  return ALLOWED_EXTENSIONLESS_TEXT_NAMES.has(basename.toLowerCase());
}

export function isAllowedWorkspaceDocumentPath(normalizedPath: string): boolean {
  const { ext } = extractWorkspaceBasenameAndExt(normalizedPath);
  return ext !== null && ALLOWED_WORKSPACE_DOCUMENT_EXTENSIONS.has(ext);
}

export function resolveCanonicalTextMimeType(normalizedPath: string): string {
  const { ext } = extractWorkspaceBasenameAndExt(normalizedPath);
  if (ext === 'md' || ext === 'mdx') return 'text/markdown';
  if (ext === 'csv') return 'text/csv';
  if (ext === 'tsv') return 'text/tab-separated-values';
  if (ext === 'json' || ext === 'jsonl' || ext === 'ndjson') return 'application/json';
  return 'text/plain';
}

export function resolveCanonicalDocumentMimeType(normalizedPath: string): string {
  const { ext } = extractWorkspaceBasenameAndExt(normalizedPath);
  switch (ext) {
    case 'pdf': {
      return 'application/pdf';
    }
    case 'docx': {
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    }
    case 'xlsx': {
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    }
    case 'pptx': {
      return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    }
    default: {
      return 'application/octet-stream';
    }
  }
}

const BINARY_MAGIC_SIGNATURES: ReadonlyArray<readonly number[]> = [
  [0x7f, 0x45, 0x4c, 0x46], // \x7fELF
  [0xfe, 0xed, 0xfa, 0xce], // Mach-O 32 BE
  [0xfe, 0xed, 0xfa, 0xcf], // Mach-O 64 BE
  [0xce, 0xfa, 0xed, 0xfe], // Mach-O 32 LE
  [0xcf, 0xfa, 0xed, 0xfe], // Mach-O 64 LE
  [0xca, 0xfe, 0xba, 0xbe], // Java class / Mach-O fat BE
  [0xbe, 0xba, 0xfe, 0xca], // Mach-O fat LE
  [0x50, 0x4b, 0x03, 0x04], // PK\x03\x04
  [0x50, 0x4b, 0x05, 0x06], // PK\x05\x06
  [0x50, 0x4b, 0x07, 0x08], // PK\x07\x08
  [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], // OLE2 Compound
  [0x25, 0x50, 0x44, 0x46, 0x2d], // %PDF-
  [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], // PNG
  [0xff, 0xd8, 0xff], // JPEG
  [0x47, 0x49, 0x46, 0x38, 0x37, 0x61], // GIF87a
  [0x47, 0x49, 0x46, 0x38, 0x39, 0x61], // GIF89a
  [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07], // Rar!\x1a\x07
  [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], // 7z
  [0x1f, 0x8b], // GZIP
  [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00], // XZ
  [0x42, 0x5a, 0x68], // BZh
  [0x00, 0x61, 0x73, 0x6d], // \x00asm
];

const RIFF_SUBTYPES = new Set<string>(['AVI ', 'WAVE', 'WEBP']);
const DOS_STUB_MARKER = 'This program cannot be run in DOS mode';
const EICAR_PART_A = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$';
const EICAR_PART_B = 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
const EICAR_BYTES = Buffer.from(EICAR_PART_A + EICAR_PART_B, 'ascii');

const isDisallowedControlByte = (byte: number): boolean =>
  byte <= 0x08 || (byte >= 0x0e && byte <= 0x1f) || byte === 0x7f;

const startsWithBytes = (probe: Uint8Array, sig: readonly number[]): boolean => {
  if (probe.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (probe[i] !== sig[i]) return false;
  }
  return true;
};

const readAsciiSlice = (probe: Uint8Array, start: number, end: number): string => {
  let out = '';
  const limit = Math.min(probe.length, end);
  for (let i = start; i < limit; i++) {
    out += String.fromCharCode(probe[i]);
  }
  return out;
};

const isRiffContainer = (probe: Uint8Array): boolean => {
  if (probe.length < 12) return false;
  if (probe[0] !== 0x52 || probe[1] !== 0x49 || probe[2] !== 0x46 || probe[3] !== 0x46) {
    return false;
  }
  const subtype = readAsciiSlice(probe, 8, 12);
  return RIFF_SUBTYPES.has(subtype);
};

const isPeExecutable = (probe: Uint8Array): boolean => {
  if (probe.length < 2 || probe[0] !== 0x4d || probe[1] !== 0x5a) {
    return false;
  }

  const headerEnd = Math.min(probe.length, 512);
  for (let i = 0; i < headerEnd; i++) {
    if (probe[i] === 0x00 || isDisallowedControlByte(probe[i])) {
      return true;
    }
  }

  if (probe.length >= 64) {
    const peOffset = (probe[60] | (probe[61] << 8) | (probe[62] << 16) | (probe[63] << 24)) >>> 0;
    if (
      peOffset + 4 <= probe.length &&
      probe[peOffset] === 0x50 &&
      probe[peOffset + 1] === 0x45 &&
      probe[peOffset + 2] === 0x00 &&
      probe[peOffset + 3] === 0x00
    ) {
      return true;
    }
  }

  const asciiHead = readAsciiSlice(probe, 0, headerEnd);
  return asciiHead.includes(DOS_STUB_MARKER);
};

const checkBinaryProbe = (probe: Uint8Array): void => {
  for (const sig of BINARY_MAGIC_SIGNATURES) {
    if (startsWithBytes(probe, sig)) {
      throw new WorkspaceError(
        'BINARY_CONTENT',
        'Binary file signature detected in workspace text content',
        415,
      );
    }
  }

  if (isRiffContainer(probe) || isPeExecutable(probe)) {
    throw new WorkspaceError(
      'BINARY_CONTENT',
      'Binary container or executable header detected in workspace text content',
      415,
    );
  }
};

/**
 * Validates path, extension whitelist, size ceiling, control bytes, 22 binary signatures,
 * RIFF/PE headers (at offset 0 and after UTF-8 BOM), and EICAR test signature (`R2-5`, Master Contract §2).
 */
export function validateWorkspaceTextBuffer(bytes: Uint8Array, rawPath: string): string {
  const normalizedPath = normalizeWorkspacePath(rawPath);

  if (!isAllowedWorkspaceTextPath(normalizedPath)) {
    throw new WorkspaceError(
      'UNSUPPORTED_TEXT_EXTENSION',
      `Unsupported text file extension for "${normalizedPath}"`,
      415,
    );
  }

  if (bytes.byteLength > MAX_WORKSPACE_TEXT_BYTES) {
    throw new WorkspaceError(
      'FILE_TOO_LARGE',
      `Text file size (${bytes.byteLength} bytes) exceeds ${MAX_WORKSPACE_TEXT_BYTES} bytes limit`,
      413,
      { byteLength: bytes.byteLength, maxBytes: MAX_WORKSPACE_TEXT_BYTES },
    );
  }

  for (let i = 0; i < bytes.byteLength; i++) {
    if (isDisallowedControlByte(bytes[i])) {
      throw new WorkspaceError(
        'BINARY_CONTENT',
        'Binary or disallowed control bytes detected in workspace text content',
        415,
      );
    }
  }

  checkBinaryProbe(bytes);

  if (bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    checkBinaryProbe(bytes.subarray(3));
  }

  const haystack = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (haystack.includes(EICAR_BYTES)) {
    throw new WorkspaceError(
      'MALWARE_SIGNATURE',
      'Antivirus test signature (EICAR) is not allowed',
      415,
    );
  }

  return normalizedPath;
}

export function validateWorkspaceDocumentPathAndSize(rawPath: string, byteSize: number): string {
  const normalizedPath = normalizeWorkspacePath(rawPath);

  if (!isAllowedWorkspaceDocumentPath(normalizedPath)) {
    throw new WorkspaceError(
      'UNSUPPORTED_DOCUMENT_EXTENSION',
      `Unsupported document extension for "${normalizedPath}"; expected pdf, docx, xlsx, or pptx`,
      415,
    );
  }

  if (byteSize > MAX_WORKSPACE_DOCUMENT_BYTES) {
    throw new WorkspaceError(
      'FILE_TOO_LARGE',
      `Document size (${byteSize} bytes) exceeds ${MAX_WORKSPACE_DOCUMENT_BYTES} bytes limit`,
      413,
      { byteLength: byteSize, maxBytes: MAX_WORKSPACE_DOCUMENT_BYTES },
    );
  }

  return normalizedPath;
}
