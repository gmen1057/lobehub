import { createHash } from 'node:crypto';
import path from 'node:path';

import type { LobeChatDatabase } from '@lobechat/database';
import { getMimeType } from '@lobechat/utils';
import debug from 'debug';
import { and, eq, sql } from 'drizzle-orm';

import { files } from '@/database/schemas';
import { appEnv } from '@/envs/app';
import type { ImageContent } from '@/libs/mcp';
import { FileS3 } from '@/server/modules/S3';
import { uuid } from '@/utils/uuid';

import {
  MAX_HYDRATE_FILE_BYTES,
  normalizeSandboxTopicRelPath,
  SANDBOX_FILE_CLIENT_ID_PREFIX,
  SANDBOX_UPLOAD_SLOTS_COUNT,
  sanitizeTopicRelPath,
} from './manifest';
import { applySandboxProjectFileSync, type SandboxProjectSyncResult } from './projectAdapter';

const log = debug('lobe-server:sandbox-commit-sync');

export const ARCKEP_SYNC_MARKER = '\u0001ARCKEP_SYNC\u0001';
export const MAX_PROJECT_TEXT_BYTES = 2 * 1024 * 1024;

const RASTER_VISION_MIMES = new Set(['image/gif', 'image/jpeg', 'image/png', 'image/webp']);

export interface ArckepSandboxSyncedItem {
  baseRevision?: number | null;
  mimeType: string;
  relPath: string;
  sha256: string;
  size: number;
  slotIndex: number;
  zone: 'topic' | 'project';
}

export interface ArckepSandboxSyncReport {
  deletedTopicRelPaths: string[];
  hydratedCount: number;
  resumed: boolean;
  synced: ArckepSandboxSyncedItem[];
  version: 1;
  warnings: string[];
}

export interface SandboxSyncStorage {
  deleteFile: (key: string) => Promise<unknown>;
  getFileByteArray: (key: string) => Promise<Uint8Array>;
  getFileMetadata: (key: string) => Promise<{ contentLength: number; contentType?: string }>;
}

export interface CommitSandboxSyncParams {
  callUuid: string;
  effectiveAgentId?: string;
  effectiveDataGuard: boolean;
  messageId?: string | null;
  remotion?: boolean;
  s3?: SandboxSyncStorage;
  serverDB: LobeChatDatabase;
  slotKeyMap: Map<number, string>;
  syncReport: ArckepSandboxSyncReport;
  topicId: string;
  userId: string;
}

export interface CommitSandboxSyncResult {
  markerLines: string[];
  mediaBlocks: ImageContent[];
  noticeLines: string[];
  receiptFooter: string;
}

const coerceSyncReport = (raw: unknown): ArckepSandboxSyncReport | null => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const rawSynced = Array.isArray(obj.synced) ? obj.synced : [];
  const rawDeleted = Array.isArray(obj.deletedTopicRelPaths)
    ? obj.deletedTopicRelPaths
    : Array.isArray(obj.deletedRelPaths)
      ? obj.deletedRelPaths
      : [];
  const rawWarnings = Array.isArray(obj.warnings) ? obj.warnings : [];

  return {
    deletedTopicRelPaths: rawDeleted.filter((item): item is string => typeof item === 'string'),
    hydratedCount: typeof obj.hydratedCount === 'number' ? obj.hydratedCount : 0,
    resumed: Boolean(obj.resumed),
    synced: rawSynced
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
      .map((item) => ({
        baseRevision:
          typeof item.baseRevision === 'number' && Number.isFinite(item.baseRevision)
            ? item.baseRevision
            : null,
        mimeType: typeof item.mimeType === 'string' ? item.mimeType : '',
        relPath: typeof item.relPath === 'string' ? item.relPath : '',
        sha256: typeof item.sha256 === 'string' ? item.sha256 : '',
        size: typeof item.size === 'number' ? item.size : 0,
        slotIndex: typeof item.slotIndex === 'number' ? item.slotIndex : -1,
        zone: item.zone === 'project' ? 'project' : 'topic',
      })),
    version: 1,
    warnings: rawWarnings
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .map((item) => item.replaceAll(/\s+/g, ' ').trim()),
  };
};

/**
 * Unpacks and strips `_arckepSync` from gateway output so raw internal JSON never reaches the LLM:
 * 1) Trailing `\x01ARCKEP_SYNC\x01<json>` marker in stdout/stderr text;
 * 2) `_arckepSync` field inside JSON payload (e.g. `execute_and_get_file` / `read_file` base64 fallback).
 */
export const extractAndStripArckepSync = (
  rawText: string,
): { cleanedText: string; syncReport: ArckepSandboxSyncReport | null } => {
  if (!rawText) return { cleanedText: rawText, syncReport: null };

  const markerIndex = rawText.lastIndexOf(ARCKEP_SYNC_MARKER);
  if (markerIndex !== -1) {
    const jsonPart = rawText.slice(markerIndex + ARCKEP_SYNC_MARKER.length).trim();
    let cutIndex = markerIndex;
    if (cutIndex > 0 && rawText[cutIndex - 1] === '\n') {
      cutIndex -= 1;
      if (cutIndex > 0 && rawText[cutIndex - 1] === '\r') cutIndex -= 1;
    }
    const cleanedText = rawText.slice(0, cutIndex);

    try {
      const parsed = JSON.parse(jsonPart);
      return { cleanedText, syncReport: coerceSyncReport(parsed) };
    } catch (error) {
      log('Failed to parse trailing ARCKEP_SYNC payload: %O', error);
      return { cleanedText, syncReport: null };
    }
  }

  if (rawText.includes('"_arckepSync"')) {
    try {
      const parsed = JSON.parse(rawText);
      if (
        parsed &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        '_arckepSync' in parsed
      ) {
        const record = parsed as Record<string, unknown>;
        const syncReport = coerceSyncReport(record._arckepSync);
        delete record._arckepSync;
        const remainingKeys = Object.keys(record);
        const cleanedText = remainingKeys.length > 0 ? JSON.stringify(record) : '';
        return { cleanedText, syncReport };
      }
    } catch {
      // Not a top-level JSON object; leave text untouched.
    }
  }

  return { cleanedText: rawText, syncReport: null };
};

const normalizeMimeType = (rawMime: string, filename: string): string => {
  const cleaned = (rawMime || '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (/^[\w.+-]+\/[\w.+-]+$/.test(cleaned) && cleaned !== 'application/octet-stream') {
    return cleaned;
  }
  const inferred = (getMimeType(filename) || '').split(';')[0]?.trim().toLowerCase();
  if (inferred && /^[\w.+-]+\/[\w.+-]+$/.test(inferred)) {
    return inferred;
  }
  return cleaned && /^[\w.+-]+\/[\w.+-]+$/.test(cleaned) ? cleaned : 'application/octet-stream';
};

const normalizeReportedPath = (rawRelPath: string): string | null => {
  if (!rawRelPath || typeof rawRelPath !== 'string') return null;
  const normalized = rawRelPath
    .normalize('NFC')
    .replaceAll('\\', '/')
    .replace(/^(?:\.\/)+/, '')
    .replace(/^\/+/, '');
  if (!normalized || normalized.length > 260) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F\p{Cf}]/u.test(normalized)) return null;

  const segments = normalized.split('/');
  if (segments.some((seg) => !seg || seg === '.' || seg === '..')) return null;
  return segments.join('/');
};

const buildPublicFileUrl = (fileId: string): string => {
  const baseUrl = (process.env.APP_URL || appEnv.APP_URL || 'https://arckep.ru/chat').replace(
    /\/+$/,
    '',
  );
  return `${baseUrl}/f/${fileId}`;
};

const serializeOrderedJson = (entries: Array<[string, unknown]>): string =>
  JSON.stringify(Object.fromEntries(entries));

type FallbackReason = Extract<SandboxProjectSyncResult, { outcome: 'fallback_to_topic' }>['reason'];

const formatProjectFallbackNotice = (params: {
  basename: string;
  publicUrl: string;
  reason: FallbackReason;
  subPath: string;
}): string => {
  const { basename, publicUrl, reason, subPath } = params;
  const link = `[${basename}](${publicUrl})`;
  switch (reason) {
    case 'revision_conflict': {
      return `Конфликт версий ${subPath}: файл был изменён вне песочницы, ваш вариант из песочницы сохранён в файлы этой переписки: ${link}`;
    }
    case 'binary_or_disallowed_ext': {
      return `project/${subPath} сохранён в файлы этой переписки: папка проекта хранит текстовые исходники, а результат доступен для скачивания в чате: ${link}`;
    }
    case 'too_large': {
      return `project/${subPath} сохранён в файлы этой переписки: папка проекта хранит текстовые исходники до 2 МБ, а результат доступен для скачивания в чате: ${link}`;
    }
    case 'protected_readonly_doc': {
      return `project/${subPath} является справочным документом только для чтения — вариант из песочницы сохранён в файлы этой переписки: ${link}`;
    }
    case 'data_guard_blocked': {
      return `project/${subPath} сохранён в файлы этой переписки (режим защиты данных): ${link}`;
    }
    case 'quota_exceeded': {
      return `Квота рабочего пространства проекта исчерпана — project/${subPath} сохранён в файлы этой переписки: ${link}`;
    }
    default: {
      return `project/${subPath} сохранён в файлы этой переписки: ${link}`;
    }
  }
};

export async function commitSandboxSync(
  params: CommitSandboxSyncParams,
): Promise<CommitSandboxSyncResult> {
  const {
    callUuid,
    effectiveAgentId,
    effectiveDataGuard,
    messageId,
    remotion = false,
    serverDB,
    slotKeyMap,
    syncReport,
    topicId,
    userId,
  } = params;

  const warningLines = [...syncReport.warnings];
  const noticeLines: string[] = [];
  const markerLines: string[] = [];
  const mediaBlocks: ImageContent[] = [];

  if (
    !serverDB ||
    typeof (serverDB as unknown as { insert?: unknown }).insert !== 'function' ||
    !userId ||
    !topicId
  ) {
    const receiptFooter = warningLines.join('\n');
    return { markerLines, mediaBlocks, noticeLines, receiptFooter };
  }

  const nowDate = new Date();
  const nowIso = nowDate.toISOString();

  // 1. Mark deleted topic files (`deletedInWorkspace = true`) without deleting DB rows or S3 blobs
  if (!remotion && syncReport.deletedTopicRelPaths.length > 0) {
    const deletedSet = new Set<string>();
    for (const rawPath of syncReport.deletedTopicRelPaths) {
      const normalized = normalizeSandboxTopicRelPath(rawPath) ?? sanitizeTopicRelPath(rawPath, '');
      if (normalized) deletedSet.add(normalized);
    }

    if (deletedSet.size > 0) {
      const sandboxPrefix = `${SANDBOX_FILE_CLIENT_ID_PREFIX}${topicId}/`;
      try {
        const existingRows = await serverDB
          .select({
            id: files.id,
            metadata: files.metadata,
          })
          .from(files)
          .where(
            and(eq(files.userId, userId), sql`starts_with(${files.clientId}, ${sandboxPrefix})`),
          );

        for (const row of existingRows) {
          const meta = ((row.metadata ?? {}) as Record<string, unknown>) || {};
          const sb = (meta.sandboxFile ?? {}) as Record<string, unknown>;
          const rowRel = typeof sb.relPath === 'string' ? sb.relPath : '';
          if (rowRel && deletedSet.has(rowRel) && sb.deletedInWorkspace !== true) {
            await serverDB
              .update(files)
              .set({
                metadata: {
                  ...meta,
                  sandboxFile: {
                    ...sb,
                    deletedInWorkspace: true,
                    updatedAt: nowIso,
                  },
                },
                updatedAt: nowDate,
              })
              .where(and(eq(files.id, row.id), eq(files.userId, userId)));
          }
        }
      } catch (error) {
        log('Failed to mark deletedTopicRelPaths for topic %s: %O', topicId, error);
      }
    }
  }

  // 2. Commit synced slots
  if (syncReport.synced.length > 0) {
    let storage: SandboxSyncStorage | null = params.s3 ?? null;
    if (!storage) {
      try {
        storage = new FileS3();
      } catch (error) {
        log('FileS3 unavailable during commitSandboxSync: %O', error);
        warningLines.push(
          'Хранилище файлов недоступно: результаты песочницы не удалось зафиксировать.',
        );
      }
    }

    if (storage) {
      const seenSlots = new Set<number>();

      const saveInTopicZone = async (opts: {
        actualSize: number;
        fallbackNotice?: string;
        item: ArckepSandboxSyncedItem;
        s3Key: string;
        topicRelPath: string;
      }) => {
        const basename = sanitizeTopicRelPath(path.posix.basename(opts.topicRelPath));
        const safeMimeType = normalizeMimeType(opts.item.mimeType, basename);
        const fileId = uuid();
        const sha256Hex = /^[\da-f]{64}$/i.test(opts.item.sha256)
          ? opts.item.sha256.toLowerCase()
          : createHash('sha256')
              .update(`${fileId}:${opts.s3Key}:${opts.actualSize}:${nowIso}`)
              .digest('hex');

        await serverDB.insert(files).values({
          clientId: `${SANDBOX_FILE_CLIENT_ID_PREFIX}${topicId}/${callUuid}/${opts.item.slotIndex}`,
          fileHash: null,
          fileType: safeMimeType,
          id: fileId,
          metadata: {
            ...(effectiveDataGuard ? { dataGuardScrubbed: true } : {}),
            sandboxFile: {
              dataGuard: effectiveDataGuard,
              deletedInWorkspace: false,
              relPath: opts.topicRelPath,
              sha256: sha256Hex,
              topicId,
              updatedAt: nowIso,
            },
          },
          name: basename,
          size: opts.actualSize,
          url: opts.s3Key,
          userId,
        });

        const publicUrl = buildPublicFileUrl(fileId);
        if (opts.fallbackNotice) {
          noticeLines.push(opts.fallbackNotice.replace('__PUBLIC_URL__', publicUrl));
        } else {
          const displayName = remotion ? basename : opts.topicRelPath;
          noticeLines.push(`Сохранено в хранилище чата: [${displayName}](${publicUrl})`);
        }

        markerLines.push(
          `ARCKEP_FILE ${serializeOrderedJson([
            ['fileId', fileId],
            ['filename', basename],
            ['mimeType', safeMimeType],
            ['size', opts.actualSize],
          ])}`,
        );

        if (!effectiveDataGuard && RASTER_VISION_MIMES.has(safeMimeType)) {
          mediaBlocks.push({
            data: publicUrl,
            fileId,
            mimeType: safeMimeType,
            type: 'image',
          });
        }
      };

      for (const item of syncReport.synced) {
        if (
          !Number.isInteger(item.slotIndex) ||
          item.slotIndex < 0 ||
          item.slotIndex >= SANDBOX_UPLOAD_SLOTS_COUNT ||
          seenSlots.has(item.slotIndex)
        ) {
          continue;
        }
        const s3Key = slotKeyMap.get(item.slotIndex);
        if (!s3Key) continue;
        seenSlots.add(item.slotIndex);

        const normalizedRelPath = normalizeReportedPath(item.relPath);
        if (!normalizedRelPath) {
          warningLines.push('Пропущен файл с недопустимым путём из песочницы.');
          continue;
        }

        let actualSize: number;
        try {
          const meta = await storage.getFileMetadata(s3Key);
          actualSize = meta.contentLength;
        } catch (error) {
          log('S3 HeadObject failed for slot %d (%s): %O', item.slotIndex, s3Key, error);
          warningLines.push(
            `Не удалось проверить загруженный файл ${normalizedRelPath} в хранилище.`,
          );
          continue;
        }

        if (
          !Number.isFinite(actualSize) ||
          actualSize <= 0 ||
          actualSize > MAX_HYDRATE_FILE_BYTES
        ) {
          warningLines.push(
            actualSize > MAX_HYDRATE_FILE_BYTES
              ? `Файл ${normalizedRelPath} превышает лимит 25 МБ и пропущен.`
              : `Файл ${normalizedRelPath} пуст в хранилище и пропущен.`,
          );
          continue;
        }

        const isProjectZone =
          !remotion &&
          item.zone === 'project' &&
          normalizedRelPath.startsWith('project/') &&
          normalizedRelPath.length > 'project/'.length;

        if (!isProjectZone) {
          const topicRelPath = remotion
            ? sanitizeTopicRelPath(path.posix.basename(normalizedRelPath))
            : (normalizeSandboxTopicRelPath(normalizedRelPath) ??
              sanitizeTopicRelPath(path.posix.basename(normalizedRelPath)));
          await saveInTopicZone({
            actualSize,
            item,
            s3Key,
            topicRelPath,
          });
          continue;
        }

        const subPath = normalizedRelPath.slice('project/'.length);
        const basename = sanitizeTopicRelPath(path.posix.basename(subPath));
        const fallbackTopicRelPath =
          normalizeSandboxTopicRelPath(subPath) ?? sanitizeTopicRelPath(basename);

        // Pre-check before downloading buffer into memory: no project or > 2 MiB -> zero-copy fallback to Zone 1
        if (!effectiveAgentId || effectiveAgentId === 'inbox') {
          await saveInTopicZone({
            actualSize,
            fallbackNotice: formatProjectFallbackNotice({
              basename,
              publicUrl: '__PUBLIC_URL__',
              reason: 'workspace_disabled',
              subPath,
            }),
            item,
            s3Key,
            topicRelPath: fallbackTopicRelPath,
          });
          continue;
        }

        if (actualSize > MAX_PROJECT_TEXT_BYTES) {
          await saveInTopicZone({
            actualSize,
            fallbackNotice: formatProjectFallbackNotice({
              basename,
              publicUrl: '__PUBLIC_URL__',
              reason: 'too_large',
              subPath,
            }),
            item,
            s3Key,
            topicRelPath: fallbackTopicRelPath,
          });
          continue;
        }

        let bytes: Uint8Array;
        try {
          bytes = await storage.getFileByteArray(s3Key);
        } catch (error) {
          log(
            'getFileByteArray failed for project sync %s, falling back to topic: %O',
            s3Key,
            error,
          );
          await saveInTopicZone({
            actualSize,
            fallbackNotice: formatProjectFallbackNotice({
              basename,
              publicUrl: '__PUBLIC_URL__',
              reason: 'workspace_disabled',
              subPath,
            }),
            item,
            s3Key,
            topicRelPath: fallbackTopicRelPath,
          });
          continue;
        }

        if (bytes.byteLength > MAX_PROJECT_TEXT_BYTES) {
          await saveInTopicZone({
            actualSize: bytes.byteLength,
            fallbackNotice: formatProjectFallbackNotice({
              basename,
              publicUrl: '__PUBLIC_URL__',
              reason: 'too_large',
              subPath,
            }),
            item,
            s3Key,
            topicRelPath: fallbackTopicRelPath,
          });
          continue;
        }

        const verifiedSha256 = createHash('sha256').update(bytes).digest('hex');
        const projectRes: SandboxProjectSyncResult = await applySandboxProjectFileSync({
          agentId: effectiveAgentId,
          baseRevision: item.baseRevision ?? null,
          bytes,
          dataGuardProtected: effectiveDataGuard,
          messageId,
          path: subPath,
          serverDB,
          sha256: verifiedSha256,
          topicId,
          userId,
        }).catch((error): SandboxProjectSyncResult => {
          log(
            'applySandboxProjectFileSync threw for %s, lossless fallback to topic: %O',
            subPath,
            error,
          );
          return {
            message: (error as Error).message || 'Ошибка сохранения в проект',
            outcome: 'fallback_to_topic',
            reason: 'workspace_disabled',
          };
        });

        if (projectRes.outcome === 'created' || projectRes.outcome === 'updated') {
          await storage.deleteFile(s3Key).catch(() => {});
          noticeLines.push(
            projectRes.outcome === 'created'
              ? `Создан файл проекта: ${projectRes.path} (v${projectRes.revision})`
              : `Обновлён файл проекта: ${projectRes.path} (v${projectRes.prevRevision ?? 0} → v${projectRes.revision})`,
          );
          markerLines.push(
            `ARCKEP_WORKSPACE_CHANGE ${serializeOrderedJson([
              ['workspaceFileId', projectRes.workspaceFileId],
              ['agentId', projectRes.agentId],
              ['path', projectRes.path],
              ['action', projectRes.outcome],
              ['prevRevision', projectRes.prevRevision],
              ['revision', projectRes.revision],
              ['addedLines', projectRes.addedLines],
              ['removedLines', projectRes.removedLines],
              ['authorType', 'sandbox'],
            ])}`,
          );
          continue;
        }

        if (projectRes.outcome === 'proposal_created') {
          await storage.deleteFile(s3Key).catch(() => {});
          noticeLines.push(
            `Создано предложение правки защищённого файла проекта: ${projectRes.targetPath} (ожидает подтверждения)`,
          );
          markerLines.push(
            `ARCKEP_WORKSPACE_PROPOSAL ${serializeOrderedJson([
              ['proposalId', projectRes.proposalId],
              ['agentId', projectRes.agentId],
              ['workspaceFileId', projectRes.workspaceFileId],
              ['targetPath', projectRes.targetPath],
              ['proposalType', projectRes.proposalType],
              ['baseRevision', projectRes.baseRevision],
              ['reason', projectRes.reason],
              ['addedLines', projectRes.addedLines],
              ['removedLines', projectRes.removedLines],
              ['diffPreview', projectRes.diffPreview],
            ])}`,
          );
          continue;
        }

        if (projectRes.outcome === 'fallback_to_topic') {
          // Lossless fallback to Zone 1 (`outcome === 'fallback_to_topic'`) — keep S3 object!
          await saveInTopicZone({
            actualSize,
            fallbackNotice: formatProjectFallbackNotice({
              basename,
              publicUrl: '__PUBLIC_URL__',
              reason: projectRes.reason,
              subPath,
            }),
            item,
            s3Key,
            topicRelPath: fallbackTopicRelPath,
          });
        }
      }
    }
  }

  const receiptFooter = [...warningLines, ...noticeLines, ...markerLines].join('\n');
  return {
    markerLines,
    mediaBlocks,
    noticeLines,
    receiptFooter,
  };
}
