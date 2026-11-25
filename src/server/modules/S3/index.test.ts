// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  clearMediaUrlCacheForTest,
  resetS3BreakerForTest,
} from '@lobechat/utils/arckepMediaMirror';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FileS3, S3 } from './index';

// Mock AWS SDK
vi.mock('@aws-sdk/client-s3');
vi.mock('@aws-sdk/s3-request-presigner');

// Mock environment variables
vi.mock('@/envs/file', () => ({
  fileEnv: {
    S3_ACCESS_KEY_ID: 'test-access-key',
    S3_BUCKET: 'test-bucket',
    S3_ENABLE_PATH_STYLE: false,
    S3_ENDPOINT: 'https://s3.amazonaws.com',
    S3_PREVIEW_URL_EXPIRE_IN: 7200,
    S3_REGION: 'us-east-1',
    S3_SECRET_ACCESS_KEY: 'test-secret-key',
    S3_SET_ACL: true,
  },
}));

// Mock utilities
vi.mock('@/utils/url', () => ({
  inferContentTypeFromImageUrl: vi.fn((key: string) => {
    if (key.endsWith('.jpg') || key.endsWith('.jpeg')) return 'image/jpeg';
    if (key.endsWith('.png')) return 'image/png';
    if (key.endsWith('.gif')) return 'image/gif';
    return 'application/octet-stream';
  }),
}));

describe('S3', () => {
  let mockS3ClientSend: ReturnType<typeof vi.fn>;
  let mockGetSignedUrl: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetS3BreakerForTest();
    clearMediaUrlCacheForTest();
    delete process.env.S3_LOCAL_MIRROR_DIR;
    delete process.env.S3_LOCAL_SPOOL_DIR;
    delete process.env.MEDIA_LINKS_MODE;
    delete process.env.LOBECHAT_BACKEND_KEY;
    delete process.env.LOBECHAT_BACKEND_INTERNAL_URL;

    // Setup S3Client mock
    mockS3ClientSend = vi.fn();
    (S3Client as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      send: mockS3ClientSend,
    }));

    // Setup getSignedUrl mock
    mockGetSignedUrl = vi.fn().mockResolvedValue('https://presigned-url.example.com');
    (getSignedUrl as unknown as ReturnType<typeof vi.fn>).mockImplementation(mockGetSignedUrl);
  });

  describe('constructor', () => {
    it('should initialize S3 client with correct configuration', () => {
      const testFileEnv = {
        S3_ACCESS_KEY_ID: 'test-access-key',
        S3_BUCKET: 'test-bucket',
        S3_ENABLE_PATH_STYLE: false,
        S3_ENDPOINT: 'https://s3.amazonaws.com',
        S3_PREVIEW_URL_EXPIRE_IN: 7200,
        S3_REGION: 'us-east-1',
        S3_SECRET_ACCESS_KEY: 'test-secret-key',
        S3_SET_ACL: true,
      };

      new S3(
        testFileEnv.S3_ACCESS_KEY_ID,
        testFileEnv.S3_SECRET_ACCESS_KEY,
        testFileEnv.S3_ENDPOINT,
        {
          bucket: testFileEnv.S3_BUCKET,
          forcePathStyle: testFileEnv.S3_ENABLE_PATH_STYLE,
          region: testFileEnv.S3_REGION,
          setAcl: testFileEnv.S3_SET_ACL,
        },
      );

      expect(S3Client).toHaveBeenCalledWith({
        credentials: {
          accessKeyId: 'test-access-key',
          secretAccessKey: 'test-secret-key',
        },
        endpoint: 'https://s3.amazonaws.com',
        forcePathStyle: false,
        region: 'us-east-1',
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
      });
    });

    it('should use default region when S3_REGION is not set', () => {
      const testEnvWithoutRegion = {
        S3_ACCESS_KEY_ID: 'test-access-key',
        S3_BUCKET: 'test-bucket',
        S3_ENABLE_PATH_STYLE: false,
        S3_ENDPOINT: 'https://s3.amazonaws.com',
        S3_PREVIEW_URL_EXPIRE_IN: 7200,
        S3_REGION: '',
        S3_SECRET_ACCESS_KEY: 'test-secret-key',
        S3_SET_ACL: true,
      };

      new S3(
        testEnvWithoutRegion.S3_ACCESS_KEY_ID,
        testEnvWithoutRegion.S3_SECRET_ACCESS_KEY,
        testEnvWithoutRegion.S3_ENDPOINT,
        {
          bucket: testEnvWithoutRegion.S3_BUCKET,
          forcePathStyle: testEnvWithoutRegion.S3_ENABLE_PATH_STYLE,
          region: testEnvWithoutRegion.S3_REGION,
          setAcl: testEnvWithoutRegion.S3_SET_ACL,
        },
      );

      expect(S3Client).toHaveBeenCalledWith(
        expect.objectContaining({
          region: 'us-east-1',
        }),
      );
    });
  });
});

describe('FileS3', () => {
  let mockS3ClientSend: ReturnType<typeof vi.fn>;
  let mockGetSignedUrl: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetS3BreakerForTest();
    clearMediaUrlCacheForTest();
    delete process.env.S3_LOCAL_MIRROR_DIR;
    delete process.env.S3_LOCAL_SPOOL_DIR;
    delete process.env.MEDIA_LINKS_MODE;
    delete process.env.LOBECHAT_BACKEND_KEY;
    delete process.env.LOBECHAT_BACKEND_INTERNAL_URL;

    // Setup S3Client mock
    mockS3ClientSend = vi.fn();
    (S3Client as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      send: mockS3ClientSend,
    }));

    // Setup getSignedUrl mock
    mockGetSignedUrl = vi.fn().mockResolvedValue('https://presigned-url.example.com');
    (getSignedUrl as unknown as ReturnType<typeof vi.fn>).mockImplementation(mockGetSignedUrl);
  });

  describe('constructor', () => {
    it('should initialize S3 client with correct configuration', () => {
      new FileS3();

      expect(S3Client).toHaveBeenCalledWith({
        credentials: {
          accessKeyId: 'test-access-key',
          secretAccessKey: 'test-secret-key',
        },
        endpoint: 'https://s3.amazonaws.com',
        forcePathStyle: false,
        region: 'us-east-1',
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
      });
    });

    it('should use default region when S3_REGION is not set', () => {
      vi.doMock('@/envs/file', () => ({
        fileEnv: {
          S3_ACCESS_KEY_ID: 'test-access-key',
          S3_BUCKET: 'test-bucket',
          S3_ENABLE_PATH_STYLE: false,
          S3_ENDPOINT: 'https://s3.amazonaws.com',
          S3_PREVIEW_URL_EXPIRE_IN: 7200,
          S3_REGION: '',
          S3_SECRET_ACCESS_KEY: 'test-secret-key',
          S3_SET_ACL: true,
        },
      }));

      new FileS3();

      expect(S3Client).toHaveBeenCalledWith(
        expect.objectContaining({
          region: 'us-east-1',
        }),
      );
    });
  });

  describe('deleteFile', () => {
    it('should delete a file with the correct parameters', async () => {
      const s3 = new FileS3();
      mockS3ClientSend.mockResolvedValue({});

      await s3.deleteFile('test-key.txt');

      expect(DeleteObjectCommand).toHaveBeenCalledWith({
        Bucket: 'test-bucket',
        Key: 'test-key.txt',
      });
      expect(mockS3ClientSend).toHaveBeenCalled();
    });

    it('should handle deletion errors', async () => {
      const s3 = new FileS3();
      const error = new Error('Delete failed');
      mockS3ClientSend.mockRejectedValue(error);

      await expect(s3.deleteFile('test-key.txt')).rejects.toThrow('Delete failed');
    });
  });

  describe('deleteFiles', () => {
    it('should delete multiple files with correct parameters', async () => {
      const s3 = new FileS3();
      mockS3ClientSend.mockResolvedValue({});

      const keys = ['file1.txt', 'file2.txt', 'file3.txt'];
      await s3.deleteFiles(keys);

      expect(DeleteObjectsCommand).toHaveBeenCalledWith({
        Bucket: 'test-bucket',
        Delete: {
          Objects: [{ Key: 'file1.txt' }, { Key: 'file2.txt' }, { Key: 'file3.txt' }],
        },
      });
      expect(mockS3ClientSend).toHaveBeenCalled();
    });

    it('should handle empty array', async () => {
      const s3 = new FileS3();
      mockS3ClientSend.mockResolvedValue({});

      await s3.deleteFiles([]);

      expect(DeleteObjectsCommand).toHaveBeenCalledWith({
        Bucket: 'test-bucket',
        Delete: {
          Objects: [],
        },
      });
    });
  });

  describe('getFileContent', () => {
    it('should retrieve file content as string', async () => {
      const s3 = new FileS3();
      const mockContent = 'Hello, World!';
      mockS3ClientSend.mockResolvedValue({
        Body: {
          transformToString: vi.fn().mockResolvedValue(mockContent),
        },
      });

      const result = await s3.getFileContent('test-file.txt');

      expect(GetObjectCommand).toHaveBeenCalledWith({
        Bucket: 'test-bucket',
        Key: 'test-file.txt',
      });
      expect(result).toBe(mockContent);
    });

    it('should throw error when response body is missing', async () => {
      const s3 = new FileS3();
      mockS3ClientSend.mockResolvedValue({
        Body: undefined,
      });

      await expect(s3.getFileContent('test-file.txt')).rejects.toThrow(
        'No body in response with test-file.txt',
      );
    });
  });

  describe('getFileByteArray', () => {
    it('should retrieve file content as byte array', async () => {
      const s3 = new FileS3();
      const mockBytes = new Uint8Array([1, 2, 3, 4, 5]);
      mockS3ClientSend.mockResolvedValue({
        Body: {
          transformToByteArray: vi.fn().mockResolvedValue(mockBytes),
        },
      });

      const result = await s3.getFileByteArray('test-file.bin');

      expect(GetObjectCommand).toHaveBeenCalledWith({
        Bucket: 'test-bucket',
        Key: 'test-file.bin',
      });
      expect(result).toEqual(mockBytes);
    });

    it('should throw error when response body is missing', async () => {
      const s3 = new FileS3();
      mockS3ClientSend.mockResolvedValue({
        Body: undefined,
      });

      await expect(s3.getFileByteArray('test-file.bin')).rejects.toThrow(
        'No body in response with test-file.bin',
      );
    });
  });

  describe('getFileMetadata', () => {
    it('should retrieve file metadata with content length and type', async () => {
      const s3 = new FileS3();
      mockS3ClientSend.mockResolvedValue({
        ContentLength: 1024,
        ContentType: 'image/png',
      });

      const result = await s3.getFileMetadata('test-file.png');

      expect(HeadObjectCommand).toHaveBeenCalledWith({
        Bucket: 'test-bucket',
        Key: 'test-file.png',
      });
      expect(result).toEqual({
        contentLength: 1024,
        contentType: 'image/png',
      });
    });

    it('should return 0 for content length when not provided', async () => {
      const s3 = new FileS3();
      mockS3ClientSend.mockResolvedValue({
        ContentType: 'application/octet-stream',
      });

      const result = await s3.getFileMetadata('test-file.bin');

      expect(result).toEqual({
        contentLength: 0,
        contentType: 'application/octet-stream',
      });
    });

    it('should handle missing content type', async () => {
      const s3 = new FileS3();
      mockS3ClientSend.mockResolvedValue({
        ContentLength: 2048,
      });

      const result = await s3.getFileMetadata('test-file.bin');

      expect(result).toEqual({
        contentLength: 2048,
        contentType: undefined,
      });
    });

    it('should handle S3 errors', async () => {
      const s3 = new FileS3();
      const error = new Error('File not found');
      mockS3ClientSend.mockRejectedValue(error);

      await expect(s3.getFileMetadata('non-existent-file.txt')).rejects.toThrow('File not found');
    });
  });

  describe('createPreSignedUrl', () => {
    it('should create presigned URL for upload with ACL', async () => {
      const s3 = new FileS3();

      const result = await s3.createPreSignedUrl('upload-file.txt');

      expect(PutObjectCommand).toHaveBeenCalledWith({
        ACL: 'public-read',
        Bucket: 'test-bucket',
        Key: 'upload-file.txt',
      });
      expect(mockGetSignedUrl).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
        expiresIn: 3600,
      });
      expect(result).toBe('https://presigned-url.example.com');
    });
  });

  describe('createPreSignedUrlForPreview', () => {
    it('should create presigned URL for preview with default expiration', async () => {
      const s3 = new FileS3();

      const result = await s3.createPreSignedUrlForPreview('preview-file.jpg');

      expect(GetObjectCommand).toHaveBeenCalledWith({
        Bucket: 'test-bucket',
        Key: 'preview-file.jpg',
      });
      // arckep: signed from the start of the hour, valid one hour longer (stable URL per hour)
      expect(mockGetSignedUrl).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
        expiresIn: 7200 + 3600,
        signingDate: expect.any(Date),
      });
      expect(result).toBe('https://presigned-url.example.com');
    });

    it('should create presigned URL for preview with custom expiration', async () => {
      const s3 = new FileS3();

      await s3.createPreSignedUrlForPreview('preview-file.jpg', 1800);

      expect(mockGetSignedUrl).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
        expiresIn: 1800 + 3600,
        signingDate: expect.any(Date),
      });
    });

    it('signs every preview of the hour with the same date (stable URL for prompt caching)', async () => {
      vi.useFakeTimers();
      try {
        const s3 = new FileS3();
        vi.setSystemTime(new Date('2026-10-13T17:05:10Z'));
        await s3.createPreSignedUrlForPreview('preview-file.jpg');
        vi.setSystemTime(new Date('2026-10-13T17:59:59Z'));
        await s3.createPreSignedUrlForPreview('preview-file.jpg');
        vi.setSystemTime(new Date('2026-10-13T18:00:01Z'));
        await s3.createPreSignedUrlForPreview('preview-file.jpg');

        const dates = mockGetSignedUrl.mock.calls
          .slice(-3)
          .map((call: any[]) => (call[2].signingDate as Date).toISOString());
        expect(dates).toEqual([
          '2026-10-13T17:00:00.000Z',
          '2026-10-13T17:00:00.000Z',
          '2026-10-13T18:00:00.000Z',
        ]);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('uploadBuffer', () => {
    it('omits ACL and public caching for an explicitly private upload', async () => {
      const s3 = new FileS3();
      const buffer = Buffer.from('private source');
      mockS3ClientSend.mockResolvedValue({});

      await s3.uploadBuffer('code.bas', buffer, 'text/plain', 'public, max-age=3600', true);

      expect(PutObjectCommand).toHaveBeenCalledWith({
        ACL: undefined,
        Body: buffer,
        Bucket: 'test-bucket',
        CacheControl: 'private, no-store',
        ContentType: 'text/plain',
        Key: 'code.bas',
      });
      expect(mockS3ClientSend).toHaveBeenCalled();
    });

    it('should upload buffer with correct parameters', async () => {
      const s3 = new FileS3();
      mockS3ClientSend.mockResolvedValue({});

      const buffer = Buffer.from('test data');
      await s3.uploadBuffer('test-file.bin', buffer, 'application/octet-stream');

      expect(PutObjectCommand).toHaveBeenCalledWith({
        ACL: 'public-read',
        Body: buffer,
        Bucket: 'test-bucket',
        ContentType: 'application/octet-stream',
        Key: 'test-file.bin',
      });
      expect(mockS3ClientSend).toHaveBeenCalled();
    });

    it('should upload buffer without content type', async () => {
      const s3 = new FileS3();
      mockS3ClientSend.mockResolvedValue({});

      const buffer = Buffer.from('test data');
      await s3.uploadBuffer('test-file.bin', buffer);

      expect(PutObjectCommand).toHaveBeenCalledWith({
        ACL: 'public-read',
        Body: buffer,
        Bucket: 'test-bucket',
        ContentType: undefined,
        Key: 'test-file.bin',
      });
    });
  });

  describe('uploadContent', () => {
    it('should upload string content with correct parameters', async () => {
      const s3 = new FileS3();
      mockS3ClientSend.mockResolvedValue({});

      const content = 'Hello, World!';
      await s3.uploadContent('test-file.txt', content);

      expect(PutObjectCommand).toHaveBeenCalledWith({
        ACL: 'public-read',
        Body: content,
        Bucket: 'test-bucket',
        Key: 'test-file.txt',
      });
      expect(mockS3ClientSend).toHaveBeenCalled();
    });

    it('should handle empty content', async () => {
      const s3 = new FileS3();
      mockS3ClientSend.mockResolvedValue({});

      await s3.uploadContent('empty.txt', '');

      expect(PutObjectCommand).toHaveBeenCalledWith({
        ACL: 'public-read',
        Body: '',
        Bucket: 'test-bucket',
        Key: 'empty.txt',
      });
    });
  });

  describe('uploadMedia', () => {
    it('should upload media with correct content type and cache control for JPEG', async () => {
      const s3 = new FileS3();
      mockS3ClientSend.mockResolvedValue({});

      const buffer = Buffer.from('fake image data');
      await s3.uploadMedia('image.jpg', buffer);

      expect(PutObjectCommand).toHaveBeenCalledWith({
        ACL: 'public-read',
        Body: buffer,
        Bucket: 'test-bucket',
        CacheControl: expect.stringContaining('public, max-age='),
        ContentType: 'image/jpeg',
        Key: 'image.jpg',
      });
      expect(mockS3ClientSend).toHaveBeenCalled();
    });

    it('should upload media with correct content type for PNG', async () => {
      const s3 = new FileS3();
      mockS3ClientSend.mockResolvedValue({});

      const buffer = Buffer.from('fake image data');
      await s3.uploadMedia('image.png', buffer);

      expect(PutObjectCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          ContentType: 'image/png',
          Key: 'image.png',
        }),
      );
    });

    it('should upload media with correct content type for GIF', async () => {
      const s3 = new FileS3();
      mockS3ClientSend.mockResolvedValue({});

      const buffer = Buffer.from('fake image data');
      await s3.uploadMedia('animation.gif', buffer);

      expect(PutObjectCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          ContentType: 'image/gif',
          Key: 'animation.gif',
        }),
      );
    });
  });

  describe('S3 outage circuit breaker, local mirror fallback, and media.arckep.ru links', () => {
    let mirrorDir: string | undefined;

    afterEach(async () => {
      vi.restoreAllMocks();
      if (mirrorDir) {
        await rm(mirrorDir, { force: true, recursive: true });
        mirrorDir = undefined;
      }
    });

    it('falls back to local mirror on S3 outage error, opens breaker after 3 failures, and closes on recovery', async () => {
      mirrorDir = await mkdtemp(path.join(tmpdir(), 'lc-s3-mirror-'));
      process.env.S3_LOCAL_MIRROR_DIR = mirrorDir;
      process.env.LOBECHAT_BACKEND_KEY = 'internal-test-key';
      process.env.LOBECHAT_BACKEND_INTERNAL_URL = 'http://127.0.0.1:8202';

      const key = 'files/user_1/outage-doc.txt';
      await mkdir(path.join(mirrorDir, 'files/user_1'), { recursive: true });
      await writeFile(path.join(mirrorDir, key), 'mirrored-text-content');

      const binKey = 'files/user_1/UT0gLmAa/image';
      const binBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      await mkdir(path.join(mirrorDir, 'files/user_1/UT0gLmAa'), { recursive: true });
      await writeFile(path.join(mirrorDir, binKey), binBytes);

      const s3 = new FileS3();
      const outageError = Object.assign(new Error('ServiceUnavailable'), {
        $metadata: { httpStatusCode: 503 },
        name: 'ServiceUnavailable',
      });
      mockS3ClientSend.mockRejectedValue(outageError);

      // Failure 1, 2, 3 -> each falls back to local mirror and opens circuit breaker
      expect(await s3.getFileContent(key)).toBe('mirrored-text-content');
      expect(await s3.getFileByteArray(binKey)).toEqual(new Uint8Array(binBytes));
      expect(await s3.getFileContent(key)).toBe('mirrored-text-content');
      expect(mockS3ClientSend).toHaveBeenCalledTimes(3);

      // Breaker is now OPEN: reads serve directly from local mirror with 0 S3 calls
      expect(await s3.getFileContent(key)).toBe('mirrored-text-content');
      expect(await s3.getFileByteArray(binKey)).toEqual(new Uint8Array(binBytes));
      expect(mockS3ClientSend).toHaveBeenCalledTimes(3);

      // Breaker OPEN -> createPreSignedUrlForPreview switches to signed media.arckep.ru URL
      const futureExp = Math.floor(Date.now() / 1000) + 7200;
      const signedMediaUrl = `https://media.arckep.ru/m/${binKey}?exp=${futureExp}&sig=deadbeef`;
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({
            mirrored: { [binKey]: true },
            s3_down: true,
            urls: { [binKey]: signedMediaUrl },
          }),
          { headers: { 'content-type': 'application/json' }, status: 200 },
        ),
      );

      const previewUrl = await s3.createPreSignedUrlForPreview(binKey);
      expect(previewUrl).toBe(signedMediaUrl);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(mockGetSignedUrl).not.toHaveBeenCalled();

      // responseContentDisposition forces S3 presigned URL even while breaker is open
      const downloadUrl = await s3.createPreSignedUrlForPreview(binKey, 7200, {
        responseContentDisposition: 'attachment; filename="shot.png"',
      });
      expect(downloadUrl).toBe('https://presigned-url.example.com');
      expect(mockGetSignedUrl).toHaveBeenCalledTimes(1);

      // When S3 recovers (e.g. a non-mirrored key succeeds via S3), breaker closes
      mockS3ClientSend.mockResolvedValueOnce({
        Body: {
          transformToString: vi.fn().mockResolvedValue('fresh-from-s3'),
        },
      });
      expect(await s3.getFileContent('files/user_1/not-in-mirror.txt')).toBe('fresh-from-s3');

      // Now breaker is CLOSED again -> preview URL uses standard hour-rounded S3 presign
      const healthyPreviewUrl = await s3.createPreSignedUrlForPreview(binKey);
      expect(healthyPreviewUrl).toBe('https://presigned-url.example.com');
      expect(mockGetSignedUrl).toHaveBeenCalledTimes(2);
    });

    it('uses signed media.arckep.ru URL when MEDIA_LINKS_MODE=always', async () => {
      process.env.MEDIA_LINKS_MODE = 'always';
      process.env.LOBECHAT_BACKEND_KEY = 'internal-test-key';

      const key = 'files/user_1/always.png';
      const exp = Math.floor(Date.now() / 1000) + 7200;
      const signed = `https://media.arckep.ru/m/${key}?exp=${exp}&sig=123456`;

      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({
            mirrored: { [key]: true },
            s3_down: false,
            urls: { [key]: signed },
          }),
          { headers: { 'content-type': 'application/json' }, status: 200 },
        ),
      );

      const s3 = new FileS3();
      expect(await s3.createPreSignedUrlForPreview(key)).toBe(signed);
      expect(mockGetSignedUrl).not.toHaveBeenCalled();
    });

    it('does not swallow 404/NoSuchKey errors or trip circuit breaker on them', async () => {
      mirrorDir = await mkdtemp(path.join(tmpdir(), 'lc-s3-mirror-'));
      process.env.S3_LOCAL_MIRROR_DIR = mirrorDir;
      await mkdir(path.join(mirrorDir, 'files/user_1'), { recursive: true });
      await writeFile(path.join(mirrorDir, 'files/user_1/deleted.txt'), 'stale');

      const s3 = new FileS3();
      const noSuchKey = Object.assign(new Error('NoSuchKey'), {
        $metadata: { httpStatusCode: 404 },
        name: 'NoSuchKey',
      });
      mockS3ClientSend.mockRejectedValue(noSuchKey);

      await expect(s3.getFileContent('files/user_1/deleted.txt')).rejects.toThrow('NoSuchKey');
      await expect(s3.getFileContent('files/user_1/deleted.txt')).rejects.toThrow('NoSuchKey');
      await expect(s3.getFileContent('files/user_1/deleted.txt')).rejects.toThrow('NoSuchKey');

      // Breaker remains closed after 404s
      expect(await s3.createPreSignedUrlForPreview('files/user_1/deleted.txt')).toBe(
        'https://presigned-url.example.com',
      );
    });
  });
});
