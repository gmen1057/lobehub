import { createHash } from 'node:crypto';
import path from 'node:path';

import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { LobeChatDatabase } from '@lobechat/database';
import debug from 'debug';
import { and, eq, sql } from 'drizzle-orm';

import { files, messages, messagesFiles, topics } from '@/database/schemas';
import { fileEnv } from '@/envs/file';
import { ownedCodeArtifacts } from '@/server/services/topicContext/codeArtifacts';
import { uuid } from '@/utils/uuid';

import { listHydratableProjectFiles } from './projectAdapter';

const log = debug('lobe-server:sandbox-manifest');

export const MAX_HYDRATE_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_ZONE1_FILES = 50;
export const MAX_ZONE1_BYTES = 50 * 1024 * 1024;
export const MAX_ZONE2_FILES = 200;
export const MAX_ZONE2_BYTES = 50 * 1024 * 1024;
export const SANDBOX_UPLOAD_SLOTS_COUNT = 15;
export const SANDBOX_PRESIGN_EXPIRES_SECONDS = 900;
export const SANDBOX_FILE_CLIENT_ID_PREFIX = 'arckep-sandbox-file/v1/';

const DEFAULT_S3_REGION = 'us-east-1';

export interface ArckepSandboxHydrateItem {
  baseRevision?: number;
  getUrl: string;
  readOnly: boolean;
  relPath: string;
  sha256: string;
  size: number;
  workspaceFileId?: string;
  zone: 'topic' | 'project';
}

export interface ArckepSandboxUploadSlot {
  putUrl: string;
  s3Key: string;
  slotIndex: number;
}

export interface ArckepSandboxBridgeEnvelope {
  explicitOutputFile?: string | null;
  hydrate: ArckepSandboxHydrateItem[];
  remotion: boolean;
  uploadSlots: ArckepSandboxUploadSlot[];
  version: 1;
}

export interface SandboxS3Presigner {
  signGetUrl: (s3Key: string, expiresInSeconds: number) => Promise<string>;
  signPutUrl: (s3Key: string, expiresInSeconds: number) => Promise<string>;
}

export interface BuildSandboxManifestParams {
  agentId?: string | null;
  callUuid?: string;
  dataGuardProtected?: boolean;
  explicitOutputFile?: string | null;
  includeUploadSlots?: boolean;
  presigner?: SandboxS3Presigner | null;
  remotion?: boolean;
  serverDB: LobeChatDatabase;
  topicId: string;
  userId: string;
}

export interface BuiltSandboxManifest {
  callUuid: string;
  effectiveAgentId?: string;
  effectiveDataGuard: boolean;
  envelope: ArckepSandboxBridgeEnvelope;
  slotKeyMap: Map<number, string>;
  topicOwned: boolean;
}

interface SandboxFileMeta {
  dataGuard?: boolean;
  deletedInWorkspace?: boolean;
  relPath?: string;
  sha256?: string;
  topicId?: string;
  updatedAt?: string;
}

interface Zone1Event {
  effectiveUpdatedAtMs: number;
  fileHash?: string | null;
  fileId: string;
  isDeletion: boolean;
  metaSha256?: string;
  order: number;
  relPath: string;
  s3Key: string;
  size: number;
}

let cachedS3ClientKey: string | null = null;
let cachedS3Client: { bucket: string; client: S3Client } | null = null;

const getSandboxS3Client = (): { bucket: string; client: S3Client } | null => {
  const accessKeyId = process.env.S3_ACCESS_KEY_ID || fileEnv.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY || fileEnv.S3_SECRET_ACCESS_KEY;
  const endpoint = process.env.S3_ENDPOINT || fileEnv.S3_ENDPOINT;
  const bucket = process.env.S3_BUCKET || fileEnv.S3_BUCKET;
  const region = process.env.S3_REGION || fileEnv.S3_REGION || DEFAULT_S3_REGION;
  const forcePathStyle =
    process.env.S3_ENABLE_PATH_STYLE !== undefined
      ? process.env.S3_ENABLE_PATH_STYLE === '1'
      : fileEnv.S3_ENABLE_PATH_STYLE;

  if (!accessKeyId || !secretAccessKey || !endpoint || !bucket) {
    return null;
  }

  const cacheKey = `${accessKeyId}:${endpoint}:${bucket}:${region}:${String(forcePathStyle)}`;
  if (cachedS3Client && cachedS3ClientKey === cacheKey) {
    return cachedS3Client;
  }

  const client = new S3Client({
    credentials: { accessKeyId, secretAccessKey },
    endpoint,
    forcePathStyle,
    region,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });

  cachedS3ClientKey = cacheKey;
  cachedS3Client = { bucket, client };
  return cachedS3Client;
};

export const createDefaultSandboxPresigner = (): SandboxS3Presigner | null => {
  const s3 = getSandboxS3Client();
  if (!s3) return null;

  return {
    signGetUrl: async (s3Key, expiresInSeconds) => {
      const command = new GetObjectCommand({ Bucket: s3.bucket, Key: s3Key });
      return getSignedUrl(s3.client, command, {
        expiresIn: expiresInSeconds,
        signingDate: new Date(),
      });
    },
    signPutUrl: async (s3Key, expiresInSeconds) => {
      const command = new PutObjectCommand({ Bucket: s3.bucket, Key: s3Key });
      return getSignedUrl(s3.client, command, {
        expiresIn: expiresInSeconds,
        signingDate: new Date(),
      });
    },
  };
};

// eslint-disable-next-line no-control-regex
const UNSAFE_FILENAME_CHARS_RE = /[\u0000-\u001F\u007F<>:"|?*\p{Cf}]/gu;

const capUtf8Filename = (name: string, maxBytes = 180): string => {
  if (Buffer.byteLength(name, 'utf8') <= maxBytes) return name;
  const ext = path.posix.extname(name);
  const safeExt = Buffer.byteLength(ext, 'utf8') <= 32 ? ext : '';
  let stem = safeExt ? name.slice(0, -safeExt.length) : name;
  while (stem.length > 0 && Buffer.byteLength(`${stem}${safeExt}`, 'utf8') > maxBytes) {
    stem = stem.slice(0, -1);
  }
  return `${stem.trim() || 'file'}${safeExt}`;
};

/**
 * Sanitizes a flat attachment / artifact filename for `/workspace/<name>`:
 * strips directory components, `..`, leading dots, control/format characters,
 * and avoids colliding with the reserved `/workspace/project` directory.
 */
export const sanitizeTopicRelPath = (
  rawName: string | null | undefined,
  fallback = 'file',
): string => {
  const normalized = (rawName ?? '').normalize('NFC').replaceAll('\\', '/');
  const lastSegment = normalized.split('/').findLast(Boolean) ?? '';
  let cleaned = lastSegment
    .replaceAll(UNSAFE_FILENAME_CHARS_RE, '_')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '');

  if (!cleaned || cleaned === '.' || cleaned === '..') {
    cleaned = fallback;
  }
  if (cleaned.toLowerCase() === 'project') {
    cleaned = 'project_file';
  }
  return capUtf8Filename(cleaned);
};

/**
 * Validates and normalizes a relative topic path produced inside `/workspace/**`
 * (supports safe subdirectories such as `charts/margin.png`, rejects `project/**`, dotfiles, and `..`).
 */
export const normalizeSandboxTopicRelPath = (
  rawRelPath: string | null | undefined,
): string | null => {
  if (!rawRelPath || typeof rawRelPath !== 'string') return null;
  const normalized = rawRelPath
    .normalize('NFC')
    .replaceAll('\\', '/')
    .replace(/^(?:\.\/)+/, '')
    .replace(/^\/+/, '');
  if (!normalized || normalized.length > 240) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F\p{Cf}]/u.test(normalized)) return null;

  const segments = normalized.split('/');
  if (segments.length === 0 || segments.length > 6) return null;
  if (segments[0]?.toLowerCase() === 'project') return null;

  const cleanedSegments: string[] = [];
  for (const seg of segments) {
    const trimmed = seg.trim();
    if (
      !trimmed ||
      trimmed === '.' ||
      trimmed === '..' ||
      trimmed.startsWith('.') ||
      trimmed.endsWith('.') ||
      trimmed.length > 120
    ) {
      return null;
    }
    cleanedSegments.push(trimmed);
  }

  return cleanedSegments.join('/');
};

const isRasterOrImageMime = (fileType: string | null | undefined): boolean =>
  (fileType ?? '').trim().toLowerCase().startsWith('image/');

const toTimestampMs = (...candidates: Array<Date | string | null | undefined>): number => {
  let best = 0;
  for (const value of candidates) {
    if (!value) continue;
    const ms = value instanceof Date ? value.getTime() : Date.parse(value);
    if (Number.isFinite(ms) && ms > best) {
      best = ms;
    }
  }
  return best;
};

const computeDeterministicSha256 = (row: {
  effectiveUpdatedAtMs: number;
  fileHash?: string | null;
  fileId: string;
  metaSha256?: string;
  s3Key: string;
  size: number;
}): string => {
  const candidate = row.metaSha256 || row.fileHash;
  if (typeof candidate === 'string' && /^[\da-f]{64}$/i.test(candidate.trim())) {
    return candidate.trim().toLowerCase();
  }
  const updatedAtIso = new Date(row.effectiveUpdatedAtMs).toISOString();
  return createHash('sha256')
    .update(`${row.fileId}:${row.s3Key}:${row.size}:${updatedAtIso}`)
    .digest('hex');
};

const normalizeS3Key = (rawUrl: string | null | undefined): string | null => {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.startsWith('internal://')) return null;
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    try {
      const parsed = new URL(trimmed);
      const bucket = process.env.S3_BUCKET || fileEnv.S3_BUCKET;
      const pathname = parsed.pathname.replace(/^\/+/, '');
      if (bucket && pathname.startsWith(`${bucket}/`)) {
        return pathname.slice(bucket.length + 1) || null;
      }
      return pathname || null;
    } catch {
      return null;
    }
  }
  return trimmed.replace(/^\/+/, '') || null;
};

export async function resolveEffectiveTopicGuardAndAgent(params: {
  agentId?: string | null;
  dataGuardProtected?: boolean;
  serverDB?: LobeChatDatabase;
  topicId?: string;
  userId?: string;
}): Promise<{
  effectiveAgentId?: string;
  effectiveDataGuard: boolean;
  topicOwned: boolean;
}> {
  const fallbackGuard = Boolean(params.dataGuardProtected);
  const fallbackAgent = params.agentId || undefined;

  if (
    !params.serverDB ||
    typeof (params.serverDB as unknown as { select?: unknown }).select !== 'function' ||
    !params.userId ||
    !params.topicId
  ) {
    return {
      effectiveAgentId: fallbackAgent,
      effectiveDataGuard: fallbackGuard,
      topicOwned: false,
    };
  }

  try {
    const [topicRow] = await params.serverDB
      .select({
        agentId: topics.agentId,
        id: topics.id,
        metadata: topics.metadata,
      })
      .from(topics)
      .where(and(eq(topics.id, params.topicId), eq(topics.userId, params.userId)))
      .limit(1);

    if (!topicRow) {
      return {
        effectiveAgentId: fallbackAgent,
        effectiveDataGuard: fallbackGuard,
        topicOwned: false,
      };
    }

    const topicMeta = (topicRow.metadata ?? undefined) as Record<string, unknown> | undefined;
    const effectiveDataGuard = Boolean(
      params.dataGuardProtected || topicMeta?.dataGuardProtected === true,
    );
    const effectiveAgentId = params.agentId || topicRow.agentId || undefined;

    return {
      effectiveAgentId,
      effectiveDataGuard,
      topicOwned: true,
    };
  } catch (error) {
    log('resolveEffectiveTopicGuardAndAgent failed: %O', error);
    return {
      effectiveAgentId: fallbackAgent,
      effectiveDataGuard: fallbackGuard,
      topicOwned: false,
    };
  }
}

export async function buildSandboxManifest(
  params: BuildSandboxManifestParams,
): Promise<BuiltSandboxManifest> {
  const {
    serverDB,
    userId,
    topicId,
    remotion = false,
    explicitOutputFile = null,
    includeUploadSlots = false,
  } = params;
  const callUuid = params.callUuid ?? uuid();
  const slotKeyMap = new Map<number, string>();

  const emptyResult = (
    effectiveDataGuard: boolean,
    effectiveAgentId?: string,
    topicOwned = false,
  ) => ({
    callUuid,
    effectiveAgentId,
    effectiveDataGuard,
    envelope: {
      explicitOutputFile,
      hydrate: [],
      remotion: Boolean(remotion),
      uploadSlots: [],
      version: 1 as const,
    },
    slotKeyMap,
    topicOwned,
  });

  if (
    !serverDB ||
    typeof (serverDB as unknown as { select?: unknown }).select !== 'function' ||
    !userId ||
    !topicId
  ) {
    return emptyResult(Boolean(params.dataGuardProtected), params.agentId || undefined, false);
  }

  const { effectiveAgentId, effectiveDataGuard, topicOwned } =
    await resolveEffectiveTopicGuardAndAgent({
      agentId: params.agentId,
      dataGuardProtected: params.dataGuardProtected,
      serverDB,
      topicId,
      userId,
    });

  if (!topicOwned) {
    return emptyResult(effectiveDataGuard, effectiveAgentId, false);
  }

  const presigner =
    params.presigner !== undefined ? params.presigner : createDefaultSandboxPresigner();
  if (!presigner) {
    log('S3 presigner is not configured; returning empty sandbox manifest for topic %s', topicId);
    return emptyResult(effectiveDataGuard, effectiveAgentId, true);
  }

  const sandboxPrefix = `${SANDBOX_FILE_CLIENT_ID_PREFIX}${topicId}/`;

  const [attachmentRows, artifactRows, sandboxRows, projectItems] = await Promise.all([
    serverDB
      .select({
        fileCreatedAt: files.createdAt,
        fileHash: files.fileHash,
        fileId: files.id,
        fileType: files.fileType,
        fileUpdatedAt: files.updatedAt,
        messageCreatedAt: messages.createdAt,
        messageUpdatedAt: messages.updatedAt,
        metadata: files.metadata,
        name: files.name,
        size: files.size,
        url: files.url,
      })
      .from(messagesFiles)
      .innerJoin(messages, eq(messages.id, messagesFiles.messageId))
      .innerJoin(files, eq(files.id, messagesFiles.fileId))
      .where(
        and(eq(messages.topicId, topicId), eq(messages.userId, userId), eq(files.userId, userId)),
      ),
    serverDB
      .select({
        createdAt: files.createdAt,
        fileHash: files.fileHash,
        fileId: files.id,
        fileType: files.fileType,
        metadata: files.metadata,
        name: files.name,
        size: files.size,
        updatedAt: files.updatedAt,
        url: files.url,
      })
      .from(files)
      .where(ownedCodeArtifacts(serverDB, userId, topicId, true)),
    serverDB
      .select({
        createdAt: files.createdAt,
        fileHash: files.fileHash,
        fileId: files.id,
        fileType: files.fileType,
        metadata: files.metadata,
        name: files.name,
        size: files.size,
        updatedAt: files.updatedAt,
        url: files.url,
      })
      .from(files)
      .where(and(eq(files.userId, userId), sql`starts_with(${files.clientId}, ${sandboxPrefix})`)),
    !remotion && effectiveAgentId && effectiveAgentId !== 'inbox'
      ? listHydratableProjectFiles({
          agentId: effectiveAgentId,
          dataGuardProtected: effectiveDataGuard,
          serverDB,
          userId,
        })
      : Promise.resolve([]),
  ]);

  const events: Zone1Event[] = [];
  let orderCounter = 0;

  // 1. Conversation attachments (`messages_files`)
  for (const row of attachmentRows) {
    const meta = (row.metadata ?? undefined) as Record<string, unknown> | undefined;
    if (effectiveDataGuard) {
      if (isRasterOrImageMime(row.fileType)) continue;
      if (meta?.dataGuardScrubbed !== true) continue;
    }
    const s3Key = normalizeS3Key(row.url);
    if (!s3Key || row.size < 0 || row.size > MAX_HYDRATE_FILE_BYTES) continue;

    const relPath = sanitizeTopicRelPath(row.name);
    events.push({
      effectiveUpdatedAtMs: toTimestampMs(
        row.messageCreatedAt,
        row.messageUpdatedAt,
        row.fileUpdatedAt,
        row.fileCreatedAt,
      ),
      fileHash: row.fileHash,
      fileId: row.fileId,
      isDeletion: false,
      order: orderCounter++,
      relPath,
      s3Key,
      size: row.size,
    });
  }

  // 2. Ready text/code artifacts of this topic (`ownedCodeArtifacts`)
  for (const row of artifactRows) {
    const meta = (row.metadata ?? undefined) as
      | {
          codeArtifact?: { title?: string };
          dataGuardScrubbed?: boolean;
          textFile?: {
            fileName?: string;
            filename?: string;
            hash?: string;
            sha256?: string;
            status?: string;
          };
        }
      | undefined;

    if (meta?.textFile && meta.textFile.status !== 'ready') {
      continue;
    }
    if (effectiveDataGuard) {
      if (isRasterOrImageMime(row.fileType)) continue;
      if (meta?.dataGuardScrubbed !== true) continue;
    }
    const s3Key = normalizeS3Key(row.url);
    if (!s3Key || row.size < 0 || row.size > MAX_HYDRATE_FILE_BYTES) continue;

    const rawName =
      meta?.textFile?.filename || meta?.textFile?.fileName || meta?.codeArtifact?.title || row.name;
    const relPath = sanitizeTopicRelPath(rawName);
    events.push({
      effectiveUpdatedAtMs: toTimestampMs(row.updatedAt, row.createdAt),
      fileHash: row.fileHash,
      fileId: row.fileId,
      isDeletion: false,
      metaSha256: meta?.textFile?.sha256 || meta?.textFile?.hash,
      order: orderCounter++,
      relPath,
      s3Key,
      size: row.size,
    });
  }

  // 3. Past sandbox outputs of this topic (`arckep-sandbox-file/v1/<topicId>/...`)
  for (const row of sandboxRows) {
    const meta = (row.metadata ?? undefined) as { sandboxFile?: SandboxFileMeta } | undefined;
    const sb = meta?.sandboxFile;
    if (sb?.topicId && sb.topicId !== topicId) continue;

    const normalizedRel =
      normalizeSandboxTopicRelPath(sb?.relPath) ?? sanitizeTopicRelPath(row.name);
    const effectiveUpdatedAtMs = toTimestampMs(sb?.updatedAt, row.updatedAt, row.createdAt);

    if (sb?.deletedInWorkspace === true) {
      events.push({
        effectiveUpdatedAtMs,
        fileId: row.fileId,
        isDeletion: true,
        order: orderCounter++,
        relPath: normalizedRel,
        s3Key: '',
        size: 0,
      });
      continue;
    }

    if (effectiveDataGuard) {
      if (sb?.dataGuard !== true) continue;
      if (isRasterOrImageMime(row.fileType)) continue;
    }

    const s3Key = normalizeS3Key(row.url);
    if (!s3Key || row.size < 0 || row.size > MAX_HYDRATE_FILE_BYTES) continue;

    events.push({
      effectiveUpdatedAtMs,
      fileHash: row.fileHash,
      fileId: row.fileId,
      isDeletion: false,
      metaSha256: sb?.sha256,
      order: orderCounter++,
      relPath: normalizedRel,
      s3Key,
      size: row.size,
    });
  }

  // Apply chronological overlay (`effective_updated_at ASC`).
  // At identical millisecond `T_del`, non-deletion candidates sort BEFORE deletion tombstones
  // so `deletedInWorkspace === true` removes all candidates with `effective_updated_at <= T_del`,
  // while a newer user attachment at `T_new > T_del` comes after and mounts again.
  events.sort((a, b) => {
    if (a.effectiveUpdatedAtMs !== b.effectiveUpdatedAtMs) {
      return a.effectiveUpdatedAtMs - b.effectiveUpdatedAtMs;
    }
    if (a.isDeletion !== b.isDeletion) {
      return a.isDeletion ? 1 : -1;
    }
    return a.order - b.order;
  });

  const zone1Map = new Map<string, Zone1Event>();
  for (const ev of events) {
    const targetRelPath = remotion
      ? `public/media/${sanitizeTopicRelPath(path.posix.basename(ev.relPath))}`
      : ev.relPath;
    if (ev.isDeletion) {
      zone1Map.delete(targetRelPath);
    } else {
      zone1Map.set(targetRelPath, { ...ev, relPath: targetRelPath });
    }
  }

  // Enforce Zone 1 budget: <= 50 files and <= 50 MiB, prioritizing freshest by effective_updated_at.
  const zone1CandidatesDesc = [...zone1Map.values()].sort((a, b) => {
    if (b.effectiveUpdatedAtMs !== a.effectiveUpdatedAtMs) {
      return b.effectiveUpdatedAtMs - a.effectiveUpdatedAtMs;
    }
    return b.order - a.order;
  });

  const selectedZone1: Zone1Event[] = [];
  let zone1Bytes = 0;
  for (const item of zone1CandidatesDesc) {
    if (selectedZone1.length >= MAX_ZONE1_FILES) break;
    if (zone1Bytes + item.size > MAX_ZONE1_BYTES) continue;
    selectedZone1.push(item);
    zone1Bytes += item.size;
  }
  selectedZone1.sort((a, b) => {
    if (a.effectiveUpdatedAtMs !== b.effectiveUpdatedAtMs) {
      return a.effectiveUpdatedAtMs - b.effectiveUpdatedAtMs;
    }
    return a.order - b.order;
  });

  // Enforce Zone 2 (`project/*`) filtering and budget: <= 200 files and <= 50 MiB,
  // prioritizing `kind === 'text'` first, then freshest `kind === 'document'`.
  const filteredProjectItems = remotion
    ? []
    : projectItems.filter((item) => {
        if (effectiveDataGuard && item.dataGuardStatus !== 'scrubbed') return false;
        const cleanSubPath = item.path.replace(/^\/+/, '');
        if (!cleanSubPath || cleanSubPath.includes('..')) return false;
        if (item.byteSize < 0 || item.byteSize > MAX_HYDRATE_FILE_BYTES) return false;
        return Boolean(normalizeS3Key(item.s3Key));
      });

  const prioritizedProjectItems = [
    ...filteredProjectItems.filter((item) => item.kind === 'text'),
    ...filteredProjectItems.filter((item) => item.kind !== 'text'),
  ];

  const selectedZone2: typeof filteredProjectItems = [];
  let zone2Bytes = 0;
  for (const item of prioritizedProjectItems) {
    if (selectedZone2.length >= MAX_ZONE2_FILES) break;
    if (zone2Bytes + item.byteSize > MAX_ZONE2_BYTES) continue;
    selectedZone2.push(item);
    zone2Bytes += item.byteSize;
  }

  const [zone1Hydrate, zone2Hydrate, uploadSlots] = await Promise.all([
    Promise.all(
      selectedZone1.map(async (item): Promise<ArckepSandboxHydrateItem> => ({
        getUrl: await presigner.signGetUrl(item.s3Key, SANDBOX_PRESIGN_EXPIRES_SECONDS),
        readOnly: false,
        relPath: item.relPath,
        sha256: computeDeterministicSha256(item),
        size: item.size,
        zone: 'topic',
      })),
    ),
    Promise.all(
      selectedZone2.map(async (item): Promise<ArckepSandboxHydrateItem> => {
        const s3Key = normalizeS3Key(item.s3Key)!;
        return {
          baseRevision: item.currentRevision,
          getUrl: await presigner.signGetUrl(s3Key, SANDBOX_PRESIGN_EXPIRES_SECONDS),
          readOnly: Boolean(item.readOnly),
          relPath: `project/${item.path.replace(/^\/+/, '')}`,
          sha256: item.sha256,
          size: item.byteSize,
          workspaceFileId: item.workspaceFileId,
          zone: 'project',
        };
      }),
    ),
    includeUploadSlots
      ? Promise.all(
          Array.from({ length: SANDBOX_UPLOAD_SLOTS_COUNT }, async (_, slotIndex) => {
            const s3Key = `files/${userId}/sandbox-outputs/${topicId}/${callUuid}/${slotIndex}.bin`;
            slotKeyMap.set(slotIndex, s3Key);
            const putUrl = await presigner.signPutUrl(s3Key, SANDBOX_PRESIGN_EXPIRES_SECONDS);
            return {
              putUrl,
              s3Key,
              slotIndex,
            };
          }),
        )
      : Promise.resolve([]),
  ]);

  return {
    callUuid,
    effectiveAgentId,
    effectiveDataGuard,
    envelope: {
      explicitOutputFile,
      hydrate: [...zone1Hydrate, ...zone2Hydrate],
      remotion: Boolean(remotion),
      uploadSlots,
      version: 1,
    },
    slotKeyMap,
    topicOwned: true,
  };
}
