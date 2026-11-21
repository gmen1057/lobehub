import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FileService } from '@/server/services/file';

const { checkHash, create, uploadBuffer } = vi.hoisted(() => ({
  checkHash: vi.fn(),
  create: vi.fn(),
  uploadBuffer: vi.fn(),
}));

vi.mock('@/database/models/file', () => ({
  FileModel: class {
    checkHash = checkHash;
    create = create;
  },
}));
vi.mock('@/envs/app', () => ({ appEnv: { APP_URL: 'https://arckep.ru/chat' } }));
vi.mock('@/server/services/file/impls', () => ({
  createFileServiceModule: () => ({ uploadBuffer }),
}));

describe('code artifact file registration', () => {
  const fileService = new FileService({} as never, 'owner_1');
  const codeArtifact = {
    identifier: 'vba-1',
    language: 'vb',
    title: 'Module1.bas',
    topicId: 'tpc_1',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    checkHash.mockResolvedValue({ isExist: false });
    create.mockResolvedValue({ id: 'file-id' });
    uploadBuffer.mockResolvedValue({ key: 'storage/actual-key' });
  });

  it('uses the returned storage key and keeps metadata out of global hash deduplication', async () => {
    const bytes = Buffer.from('MsgBox "Привет"\n');
    const result = await fileService.uploadFromBuffer(
      bytes,
      'text/plain; charset=utf-8',
      'requested/Module1.bas',
      {
        metadata: { codeArtifact },
        privateFile: true,
        skipGlobalDedup: true,
      },
    );
    expect(uploadBuffer).toHaveBeenCalledWith(
      'requested/Module1.bas',
      bytes,
      'text/plain; charset=utf-8',
      true,
    );
    expect(checkHash).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        fileHash: undefined,
        metadata: expect.objectContaining({ codeArtifact }),
        url: 'storage/actual-key',
      }),
      false,
    );
    expect(result).toMatchObject({ fileId: 'file-id', key: 'storage/actual-key' });
  });

  it('preserves global hash deduplication for existing callers', async () => {
    await fileService.uploadFromBuffer(Buffer.from('original'), 'text/plain', 'requested/text.txt');
    const hash = expect.stringMatching(/^[\da-f]{64}$/);
    expect(checkHash).toHaveBeenCalledWith(hash);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ fileHash: hash, url: 'storage/actual-key' }),
      true,
    );
  });
});
