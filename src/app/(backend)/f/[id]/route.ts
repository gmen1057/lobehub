import { users } from '@lobechat/database/schemas';
import debug from 'debug';
import { eq } from 'drizzle-orm';

import { FileModel } from '@/database/models/file';
import { getServerDB } from '@/database/server';
import { getRedisConfig } from '@/envs/redis';
import { validateArckepToken } from '@/libs/arckep/validateToken';
import { initializeRedis, isRedisEnabled } from '@/libs/redis';
import { FileService } from '@/server/services/file';

const log = debug('lobe-file:proxy');

type Params = Promise<{ id: string }>;

const FILE_PROXY_KEY_PREFIX = 'file-proxy:';
// Cache presigned URL for 4 minutes (URL expires in 5 minutes)
const PRESIGNED_URL_CACHE_TTL = 240;

const buildCacheKey = (id: string) => `${FILE_PROXY_KEY_PREFIX}${id}`;

/**
 * Legacy short `file_<12>` IDs (length <= 17) were generated with 12-char non-CSPRNG suffixes.
 * New `file_<21>` IDs (length 26) and UUIDs (length 36) carry >= 122 bits of CSPRNG entropy.
 */
const isLegacyShortFileId = (id: string) => id.startsWith('file_') && id.length <= 17;

/**
 * Only non-executable raster images, audio, and video count as safe inline media
 * for unauthenticated legacy `file_<12>` access (SVG and DWG are excluded).
 */
const isSafeInlineMedia = (rawFileType: string) => {
  const fileType = (rawFileType || '').split(';')[0]?.trim().toLowerCase() || '';
  return (
    (fileType.startsWith('image/') &&
      fileType !== 'image/svg+xml' &&
      fileType !== 'image/vnd.dwg') ||
    fileType.startsWith('audio/') ||
    fileType.startsWith('video/')
  );
};

interface CachedFileData {
  redirectUrl: string;
}

/**
 * File proxy service
 * GET /f/:id
 *
 * Features:
 * - Query database to get file record (legacy short non-media `file_<12>` requires owner auth)
 * - Generate access URL based on platform (desktop → local file, web → S3 presigned URL)
 * - Cache public presigned URL in Redis to reduce S3 API calls
 * - Return 302 redirect
 */
export const GET = async (req: Request, segmentData: { params: Params }) => {
  try {
    const params = await segmentData.params;
    const { id } = params;
    const legacyShortId = isLegacyShortFileId(id);

    log('File proxy request: %s (legacyShort=%s)', id, legacyShortId);

    // Try to get cached presigned URL from Redis (skip upfront for legacy short IDs until media type is verified)
    const redisConfig = getRedisConfig();
    const redisClient = isRedisEnabled(redisConfig) ? await initializeRedis(redisConfig) : null;

    const cacheKey = buildCacheKey(id);
    if (!legacyShortId && redisClient) {
      const cachedStr = await redisClient.get(cacheKey);
      const cached = cachedStr ? (JSON.parse(cachedStr) as CachedFileData) : null;
      if (cached?.redirectUrl) {
        log('Cache hit for file: %s', id);
        return Response.redirect(cached.redirectUrl, 302);
      }
      log('Cache miss for file: %s', id);
    }

    // Get database connection
    const db = await getServerDB();

    // Query file record
    const file = await FileModel.getFileById(db, id);

    if (!file) {
      log('File not found: %s', id);
      return new Response('File not found', {
        status: 404,
      });
    }

    // Automatically saved code is private and is opened through the Studio's authenticated API.
    if (file.url.startsWith(`files/${file.userId}/code-artifacts/`)) {
      return new Response('File not found', { status: 404 });
    }

    const inlinePreview = isSafeInlineMedia(file.fileType || '');

    if (legacyShortId) {
      if (inlinePreview) {
        if (redisClient) {
          const cachedStr = await redisClient.get(cacheKey);
          const cached = cachedStr ? (JSON.parse(cachedStr) as CachedFileData) : null;
          if (cached?.redirectUrl) {
            log('Cache hit for legacy media file: %s', id);
            return Response.redirect(cached.redirectUrl, 302);
          }
        }
      } else {
        const arckepAuth = await validateArckepToken(req);
        if (arckepAuth.status === 'unreachable') {
          return new Response('Auth backend temporarily unavailable', {
            headers: { 'Retry-After': '5' },
            status: 503,
          });
        }
        if (arckepAuth.status !== 'valid' || !arckepAuth.userId) {
          log('Blocked unauthenticated access to legacy non-media file: %s', id);
          return new Response('Forbidden', { status: 403 });
        }

        const [owner] = await db
          .select({ email: users.email })
          .from(users)
          .where(eq(users.id, file.userId))
          .limit(1);
        const expectedEmail = `user${arckepAuth.userId}@arckep.ru`;
        if (!owner?.email || owner.email !== expectedEmail) {
          log('Blocked foreign access to legacy non-media file: %s', id);
          return new Response('Forbidden', { status: 403 });
        }
      }
    }

    // Create file service with file owner's userId
    const fileService = new FileService(db, file.userId);

    const asciiName = (file.name || 'file').replaceAll(/[^\w.-]+/g, '_').slice(0, 120) || 'file';

    // Web: Generate S3 presigned URL (5 minutes expiry).
    // Documents must download as attachment — a 302 inside the chat iframe
    // otherwise swallows the click (incident 2026-09-08 getpiano KP .docx).
    const redirectUrl = await fileService.createPreSignedUrlForPreview(
      file.url,
      300,
      inlinePreview
        ? undefined
        : { responseContentDisposition: `attachment; filename="${asciiName}"` },
    );
    log('Web S3 presigned URL generated (expires in 5 min)');

    // Cache the presigned URL in Redis only for public-capable files (never cache owner-gated legacy documents)
    const canCachePublicly = !legacyShortId || inlinePreview;
    if (redisClient && canCachePublicly) {
      await redisClient.set(cacheKey, JSON.stringify({ redirectUrl }), {
        ex: PRESIGNED_URL_CACHE_TTL,
      });
      log('Cached presigned URL for file: %s (TTL: %ds)', id, PRESIGNED_URL_CACHE_TTL);
    }

    // Return 302 redirect
    return Response.redirect(redirectUrl, 302);
  } catch (error) {
    console.error('File proxy error:', error);
    return new Response('Internal server error', {
      status: 500,
    });
  }
};
