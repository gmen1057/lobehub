import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createToolImageUrlResolver, MAX_TOOL_IMAGE_BYTES } from '../toolResultImageUrl';

const mocks = vi.hoisted(() => ({
  fileServiceCtor: vi.fn(),
  findById: vi.fn(),
  getFullFileUrl: vi.fn(),
}));

vi.mock('@/database/models/file', () => ({
  FileModel: class {
    findById = mocks.findById;
  },
}));
vi.mock('@/server/services/file', () => ({
  FileService: class {
    constructor(...args: unknown[]) {
      mocks.fileServiceCtor(...args);
    }

    getFullFileUrl = mocks.getFullFileUrl;
  },
}));

const db = {} as any;
const image = { fileId: 'file-1', mimeType: 'image/png', url: 'https://arckep.ru/chat/f/file-1' };

describe('createToolImageUrlResolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findById.mockResolvedValue({
      fileType: 'image/png',
      id: 'file-1',
      size: 300_000,
      url: 'files/mcp/images/2026-10-19/abc.png',
    });
    mocks.getFullFileUrl.mockResolvedValue('https://s3.example/signed/abc.png?X-Amz-Signature=1');
  });

  it('по fileId берёт ключ файла ЭТОГО пользователя и отдаёт подписанную ссылку хранилища, не адрес /f/:id', async () => {
    const resolve = createToolImageUrlResolver(db, 'user-1');

    const url = await resolve(image);

    expect(url).toBe('https://s3.example/signed/abc.png?X-Amz-Signature=1');
    expect(mocks.findById).toHaveBeenCalledWith('file-1');
    expect(mocks.fileServiceCtor).toHaveBeenCalledWith(db, 'user-1');
    // В getFullFileUrl идёт ключ в хранилище, а не `${APP_URL}/f/:id`
    expect(mocks.getFullFileUrl).toHaveBeenCalledWith('files/mcp/images/2026-10-19/abc.png');
  });

  it('без fileId (адрес с чужого сайта, старое сообщение) картинку не берёт и в хранилище не ходит', async () => {
    const resolve = createToolImageUrlResolver(db, 'user-1');

    expect(await resolve({ url: 'https://example.com/pic.png' })).toBeUndefined();
    expect(mocks.findById).not.toHaveBeenCalled();
  });

  it('файла нет у этого пользователя (чужой или удалён) — картинки нет', async () => {
    mocks.findById.mockResolvedValue(undefined);

    expect(await createToolImageUrlResolver(db, 'user-1')(image)).toBeUndefined();
    expect(mocks.getFullFileUrl).not.toHaveBeenCalled();
  });

  it('не растровая картинка (SVG, аудио) — картинки нет', async () => {
    const resolve = createToolImageUrlResolver(db, 'user-1');

    mocks.findById.mockResolvedValue({ fileType: 'image/svg+xml', size: 10, url: 'k.svg' });
    expect(await resolve(image)).toBeUndefined();

    mocks.findById.mockResolvedValue({ fileType: 'audio/mpeg', size: 10, url: 'k.mp3' });
    expect(await resolve(image)).toBeUndefined();
    expect(mocks.getFullFileUrl).not.toHaveBeenCalled();
  });

  it('слишком большой файл не уходит модели (один такой ломает весь запрос)', async () => {
    mocks.findById.mockResolvedValue({
      fileType: 'image/png',
      size: MAX_TOOL_IMAGE_BYTES + 1,
      url: 'k.png',
    });

    expect(await createToolImageUrlResolver(db, 'user-1')(image)).toBeUndefined();
    expect(mocks.getFullFileUrl).not.toHaveBeenCalled();
  });

  it('ошибка базы или хранилища не роняет ответ модели — просто нет картинки', async () => {
    mocks.getFullFileUrl.mockRejectedValue(new Error('S3 is down'));
    expect(await createToolImageUrlResolver(db, 'user-1')(image)).toBeUndefined();

    mocks.findById.mockRejectedValue(new Error('db is down'));
    expect(await createToolImageUrlResolver(db, 'user-1')(image)).toBeUndefined();
  });
});
