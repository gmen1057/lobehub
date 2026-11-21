import { createHash, randomUUID } from 'node:crypto';

import remarkParse from 'remark-parse';
import { unified } from 'unified';

import { escapeAttr } from '@/server/services/arckepLayout/artifacts';
import type { FileService } from '@/server/services/file';

const MAX_CODE_ARTIFACT_BYTES = 2 * 1024 * 1024;
const MIME_TYPE = 'text/plain; charset=utf-8';

const extensions: Record<string, string> = {
  bash: 'sh',
  c: 'c',
  cpp: 'cpp',
  csharp: 'cs',
  css: 'css',
  go: 'go',
  java: 'java',
  javascript: 'js',
  kotlin: 'kt',
  lua: 'lua',
  perl: 'pl',
  php: 'php',
  powershell: 'ps1',
  python: 'py',
  r: 'r',
  ruby: 'rb',
  rust: 'rs',
  scala: 'scala',
  sql: 'sql',
  swift: 'swift',
  typescript: 'ts',
  vb: 'bas',
  vbnet: 'vb',
};

const aliases: Record<string, string> = {
  'c#': 'csharp',
  'c++': 'cpp',
  'js': 'javascript',
  'jsx': 'javascript',
  'ps1': 'powershell',
  'py': 'python',
  'sh': 'bash',
  'ts': 'typescript',
  'tsx': 'typescript',
  'vba': 'vb',
  'visual-basic': 'vb',
  'visualbasic': 'vb',
};

const exampleLabel =
  /\b(?:examples?|samples?|snippets?|demo)\b|(?:^|[^\p{L}])(?:пример\p{L}*|фрагмент\p{L}*|демонстрац\p{L}*|образец)(?=$|[^\p{L}])/iu;
const vbaModule = /^Attribute[ \t]+VB_Name[ \t]*=[ \t]*"([\w.-]{1,80})"/im;
const explicitFilename =
  /(?:^|[ \t])(?:file|filename)=(?:"([\w.-]{1,100})"|'([\w.-]{1,100})'|([\w.-]{1,100})(?=$|[ \t]))/i;
const bareFilename = /^([\w-][\w.-]{0,99})$/;
const alternativeExtensions: Record<string, readonly string[]> = {
  cpp: ['cc', 'cxx', 'h', 'hpp'],
  javascript: ['cjs', 'jsx', 'mjs'],
  typescript: ['cts', 'mts', 'tsx'],
  vb: ['cls', 'frm'],
};
const markdown = unified().use(remarkParse);

export interface CodeArtifactMetadata {
  identifier: string;
  language: string;
  messageId: string;
  title: string;
  topicId: string;
}

type CodeArtifactFileService = Pick<FileService, 'uploadFromBuffer'>;

interface SaveCodeArtifactsOptions {
  contentPartIndex?: number;
  fileService: () => CodeArtifactFileService;
  messageId: string;
  signal?: AbortSignal;
  topicId: string;
  userId: string;
}

/** Use Markdown positions so quoted, indented and unfinished examples do not become files. */
const codeBlocks = (content: string) => {
  const nodes = markdown.parse(content).children;
  return nodes.flatMap((node, ordinal) => {
    if (node.type !== 'code' || !node.lang || !node.position) return [];
    const label = node.lang.toLowerCase();
    const language = Object.hasOwn(aliases, label) ? aliases[label] : label;
    const extension = Object.hasOwn(extensions, language) ? extensions[language] : undefined;
    if (!extension || exampleLabel.test(node.meta ?? '')) return [];
    const start = node.position.start.offset!;
    const end = node.position.end.offset!;
    const raw = content.slice(start, end);
    const opening = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(raw);
    const openingEnd = /\r\n?|\n/.exec(raw);
    const closingStart = Math.max(raw.lastIndexOf('\n'), raw.lastIndexOf('\r')) + 1;
    const closing = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/.exec(raw.slice(closingStart));
    if (
      !opening ||
      !openingEnd ||
      !closing ||
      opening[1][0] !== closing[1][0] ||
      closing[1].length < opening[1].length
    )
      return [];
    const sourceStart = openingEnd.index + openingEnd[0].length;
    if (closingStart <= sourceStart) return [];
    const previous = nodes[ordinal - 1];
    const lead = previous?.position
      ? content.slice(previous.position.start.offset, previous.position.end.offset).trim()
      : '';
    if (
      lead.length <= 200 &&
      exampleLabel.test(lead) &&
      (previous?.type === 'heading' || lead.endsWith(':'))
    ) {
      return [];
    }

    const source = raw.slice(sourceStart, closingStart);
    const trimmedSource = source.trim();
    if (
      trimmedSource.length < 1600 &&
      trimmedSource.split(/\r\n?|\n/).filter((line) => /\S/.test(line)).length < 24
    ) {
      return [];
    }
    const filenameMatch = explicitFilename.exec(node.meta ?? '');
    const filename =
      filenameMatch?.[1] ??
      filenameMatch?.[2] ??
      filenameMatch?.[3] ??
      bareFilename.exec(node.meta?.trim() ?? '')?.[1];
    const filenameExtension = /\.([a-z0-9]+)$/i.exec(filename ?? '')?.[1].toLowerCase();
    const namedFile =
      filename &&
      !filename.startsWith('.') &&
      filenameExtension &&
      (filenameExtension === extension ||
        alternativeExtensions[language]?.includes(filenameExtension))
        ? filename
        : undefined;
    const module = language === 'vb' ? vbaModule.exec(source)?.[1] : undefined;
    const vbaName = module ?? namedFile?.replace(/\.[^.]+$/, '');
    const title = namedFile ?? (module ? `${module}.bas` : `code.${extension}`);
    const fileIdentity =
      language === 'vb' && vbaName
        ? `vba:${vbaName.toLowerCase()}`
        : namedFile
          ? `file:${namedFile}`
          : undefined;
    return [{ end, fileIdentity, language, ordinal, source, start, title }];
  });
};

/** Persist source before substituting the file reference. Failed uploads keep their original Markdown. */
export const saveLongCodeArtifacts = async (content: string, options: SaveCodeArtifactsOptions) => {
  if (options.signal?.aborted || (!content.includes('```') && !content.includes('~~~')))
    return content;
  const { contentPartIndex, messageId, topicId, userId } = options;
  if (!/^[\w-]{1,100}$/.test(userId) || !/^[\w-]{1,100}$/.test(topicId)) return content;

  let cursor = 0;
  let output = '';
  let blocks: ReturnType<typeof codeBlocks>;
  try {
    blocks = codeBlocks(content);
  } catch {
    return content;
  }
  for (const block of blocks) {
    if (options.signal?.aborted) return content;
    const { end, fileIdentity, language, ordinal, source, start, title } = block;
    const bytes = Buffer.from(source, 'utf8');
    if (bytes.length > MAX_CODE_ARTIFACT_BYTES || source.includes('\u0000')) continue;

    // Unnamed sources keep independent message identities. Matching a language or common
    // function name alone could silently group unrelated files as revisions.
    const anchor = contentPartIndex === undefined ? messageId : `${messageId}:${contentPartIndex}`;
    const identity = fileIdentity ?? `${anchor}:${ordinal}`;
    const digest = createHash('sha256')
      .update(`${language}:${identity}`)
      .digest('hex')
      .slice(0, 24);
    const identifier = `code-${language}-${digest}`;
    const codeArtifact: CodeArtifactMetadata = { identifier, language, messageId, title, topicId };
    try {
      const { fileId } = await options
        .fileService()
        .uploadFromBuffer(
          bytes,
          MIME_TYPE,
          `files/${userId}/code-artifacts/${topicId}/${randomUUID()}/${title}`,
          { metadata: { codeArtifact }, privateFile: true, skipGlobalDedup: true },
        );
      if (options.signal?.aborted) return content;

      const tag = `<lobeArtifact type="application/lobe.artifacts.code" identifier="${identifier}" title="${escapeAttr(title)}" language="${language}" src="/chat/code-artifact/${fileId}/"></lobeArtifact>`;
      output += content.slice(cursor, start) + tag;
      cursor = end;
    } catch (error) {
      console.warn(
        '[codeArtifacts] Failed to save source, keeping original reply',
        error instanceof Error ? error.name : typeof error,
      );
    }
  }

  return output + content.slice(cursor);
};
