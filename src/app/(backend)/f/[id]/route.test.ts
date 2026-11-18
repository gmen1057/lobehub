// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GET } from './route';

const mockGetFileById = vi.fn();
const mockValidateArckepToken = vi.fn();
const mockCreatePreSignedUrlForPreview = vi.fn();
const mockRedisGet = vi.fn();
const mockRedisSet = vi.fn();
const mockOwnerLimit = vi.fn();

vi.mock('@/database/models/file', () => ({
  FileModel: {
    getFileById: (...args: unknown[]) => mockGetFileById(...args),
  },
}));

vi.mock('@/database/server', () => ({
  getServerDB: vi.fn(async () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: (...args: unknown[]) => mockOwnerLimit(...args),
        }),
      }),
    }),
  })),
}));

vi.mock('@/envs/redis', () => ({
  getRedisConfig: vi.fn(() => ({ enabled: true })),
}));

vi.mock('@/libs/redis', () => ({
  initializeRedis: vi.fn(async () => ({
    get: (...args: unknown[]) => mockRedisGet(...args),
    set: (...args: unknown[]) => mockRedisSet(...args),
  })),
  isRedisEnabled: vi.fn(() => true),
}));

vi.mock('@/libs/arckep/validateToken', () => ({
  validateArckepToken: (...args: unknown[]) => mockValidateArckepToken(...args),
}));

vi.mock('@/server/services/file', () => ({
  FileService: class {
    createPreSignedUrlForPreview = (...args: unknown[]) =>
      mockCreatePreSignedUrlForPreview(...args);
  },
}));

describe('GET /f/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedisGet.mockResolvedValue(null);
    mockRedisSet.mockResolvedValue('OK');
    mockCreatePreSignedUrlForPreview.mockResolvedValue('https://s3.example.test/signed-url');
  });

  it('serves new 21-char file_<21> documents publicly and caches in Redis', async () => {
    const id = 'file_AbCdEfGhIjKlMnOpQrStU';
    mockGetFileById.mockResolvedValue({
      fileType: 'application/pdf',
      id,
      name: 'report.pdf',
      url: 'files/user_1/report.pdf',
      userId: 'user_lobe_1',
    });

    const res = await GET(new Request(`https://arckep.ru/chat/f/${id}`), {
      params: Promise.resolve({ id }),
    });

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://s3.example.test/signed-url');
    expect(mockValidateArckepToken).not.toHaveBeenCalled();
    expect(mockRedisSet).toHaveBeenCalledTimes(1);
  });

  it('allows unauthenticated access to legacy 12-char safe inline media (image/png, video/mp4)', async () => {
    const id = 'file_95Rca7PxzpAi';
    mockGetFileById.mockResolvedValue({
      fileType: 'image/png',
      id,
      name: 'banner.png',
      url: 'files/user_1/banner.png',
      userId: 'user_lobe_1',
    });

    const res = await GET(new Request(`https://arckep.ru/chat/f/${id}`), {
      params: Promise.resolve({ id }),
    });

    expect(res.status).toBe(302);
    expect(mockValidateArckepToken).not.toHaveBeenCalled();
    expect(mockCreatePreSignedUrlForPreview).toHaveBeenCalledWith(
      'files/user_1/banner.png',
      300,
      undefined,
    );
    expect(mockRedisSet).toHaveBeenCalledTimes(1);
  });

  it.each([
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'image/svg+xml',
    'text/html',
    'application/octet-stream',
  ])(
    'blocks unauthenticated access to legacy 12-char non-media (%s) even if Redis has entry',
    async (fileType) => {
      const id = 'file_iIPltlJnQnGl';
      mockRedisGet.mockResolvedValue(
        JSON.stringify({ redirectUrl: 'https://s3.example.test/leaked' }),
      );
      mockGetFileById.mockResolvedValue({
        fileType,
        id,
        name: 'secret.file',
        url: 'files/user_1/secret.file',
        userId: 'user_lobe_1',
      });
      mockValidateArckepToken.mockResolvedValue({ status: 'missing' });

      const res = await GET(new Request(`https://arckep.ru/chat/f/${id}`), {
        params: Promise.resolve({ id }),
      });

      expect(res.status).toBe(403);
      expect(mockCreatePreSignedUrlForPreview).not.toHaveBeenCalled();
      expect(mockRedisSet).not.toHaveBeenCalled();
    },
  );

  it('blocks authenticated foreign user from accessing another user legacy 12-char document', async () => {
    const id = 'file_iIPltlJnQnGl';
    mockGetFileById.mockResolvedValue({
      fileType: 'application/pdf',
      id,
      name: 'private.pdf',
      url: 'files/user_1/private.pdf',
      userId: 'user_lobe_owner',
    });
    mockValidateArckepToken.mockResolvedValue({ status: 'valid', userId: '999' });
    mockOwnerLimit.mockResolvedValue([{ email: 'user42@arckep.ru' }]);

    const res = await GET(
      new Request(`https://arckep.ru/chat/f/${id}`, {
        headers: { Cookie: 'arckep_token=foreign-jwt' },
      }),
      { params: Promise.resolve({ id }) },
    );

    expect(res.status).toBe(403);
    expect(mockCreatePreSignedUrlForPreview).not.toHaveBeenCalled();
  });

  it('allows authenticated file owner to download their legacy 12-char document without public Redis caching', async () => {
    const id = 'file_iIPltlJnQnGl';
    mockGetFileById.mockResolvedValue({
      fileType: 'application/pdf',
      id,
      name: 'contract.pdf',
      url: 'files/user_42/contract.pdf',
      userId: 'user_lobe_owner',
    });
    mockValidateArckepToken.mockResolvedValue({ status: 'valid', userId: '42' });
    mockOwnerLimit.mockResolvedValue([{ email: 'user42@arckep.ru' }]);

    const res = await GET(
      new Request(`https://arckep.ru/chat/f/${id}`, {
        headers: { Cookie: 'arckep_token=owner-jwt' },
      }),
      { params: Promise.resolve({ id }) },
    );

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://s3.example.test/signed-url');
    expect(mockCreatePreSignedUrlForPreview).toHaveBeenCalledWith(
      'files/user_42/contract.pdf',
      300,
      { responseContentDisposition: 'attachment; filename="contract.pdf"' },
    );
    expect(mockRedisSet).not.toHaveBeenCalled();
  });
});
