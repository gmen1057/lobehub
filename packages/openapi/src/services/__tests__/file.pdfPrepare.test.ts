import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FileUploadService } from '../file.service';

// arckep (19.10.2026): PDF, загруженный через POST /files, начинает готовиться сразу (страницы и вшитые картинки
// в фоне, aiAgent/pdfPrepare.ts); загрузка эту подготовку не ждёт и от неё не зависит.

const { schedule, checkHash, createRecord, uploadBuffer, findExisting } = vi.hoisted(() => ({
  checkHash: vi.fn(),
  createRecord: vi.fn(),
  findExisting: vi.fn(),
  schedule: vi.fn(),
  uploadBuffer: vi.fn(),
}));

vi.mock('@/const/rbac', () => ({ ALL_SCOPE: 'ALL' }));
vi.mock('@/database/schemas', () => ({
  agentsToSessions: {},
  files: {},
  filesToSessions: {},
  knowledgeBaseFiles: {},
  knowledgeBases: {},
  users: {},
}));
vi.mock('@/utils/uuid', () => ({ nanoid: () => 'nano' }));
vi.mock('@/utils/isChunkingUnsupported', () => ({ isChunkingUnsupported: () => false }));
vi.mock('@/server/services/aiAgent/pdfPrepare', () => ({ schedulePdfPrepare: schedule }));
vi.mock('../../common/base.service', () => ({
  BaseService: class {
    db: any;
    userId: any;
    constructor(db: any, userId: any) {
      this.db = db;
      this.userId = userId;
    }
    log() {}
    handleServiceError(error: unknown): never {
      throw error;
    }
  },
}));
vi.mock('@/database/models/asyncTask', () => ({ AsyncTaskModel: class {} }));
vi.mock('@/database/models/chunk', () => ({ ChunkModel: class {} }));
vi.mock('@/database/models/document', () => ({ DocumentModel: class {} }));
vi.mock('@/database/models/knowledgeBase', () => ({ KnowledgeBaseModel: class {} }));
vi.mock('@/database/models/file', () => ({
  FileModel: class {
    checkHash = checkHash;
    create = createRecord;
  },
}));
vi.mock('@/server/modules/S3', () => ({
  FileS3: class {
    uploadBuffer = uploadBuffer;
  },
}));
vi.mock('@/server/services/document', () => ({ DocumentService: class {} }));
vi.mock('@/server/services/file', () => ({ FileService: class {} }));

const upload = async (file: File, options: Record<string, unknown> = {}) => {
  const service: any = new (FileUploadService as any)({}, 'user-1');
  service.resolveOperationPermission = vi.fn().mockResolvedValue({ isPermitted: true });
  service.validateFile = vi.fn().mockResolvedValue(undefined);
  service.resolveSessionId = vi.fn().mockResolvedValue(undefined);
  service.findExistingUserFile = findExisting;
  service.getFileDetail = vi.fn(async (id: string) => ({ file: { id } }));
  const result = await service.uploadFile(file, options);
  // фоновая цепочка (динамический импорт) успевает дойти до вызова
  await vi.waitFor(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 0));
  return result;
};

const pdf = () =>
  new File([new Uint8Array([37, 80, 68, 70])], 'макет.pdf', { type: 'application/pdf' });

beforeEach(() => {
  vi.clearAllMocks();
  checkHash.mockResolvedValue({ isExist: false });
  createRecord.mockResolvedValue({ id: 'file_new' });
  uploadBuffer.mockResolvedValue(undefined);
  findExisting.mockResolvedValue(null);
  schedule.mockReturnValue(undefined);
});

describe('FileUploadService.uploadFile — подготовка PDF при загрузке', () => {
  it('новый PDF: после записи файла подготовка запускается по id записи', async () => {
    const result = await upload(pdf());

    expect(result).toEqual({ file: { id: 'file_new' } });
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(schedule).toHaveBeenCalledWith(
      expect.anything(),
      'user-1',
      expect.objectContaining({ id: 'file_new', mime: 'application/pdf', name: 'макет.pdf' }),
    );
  });

  it('тот же файл человек грузит повторно: запись его же, подготовка просится по ней (готовая вернётся из кэша)', async () => {
    checkHash.mockResolvedValue({ isExist: true, url: 'files/x.pdf' });
    findExisting.mockResolvedValue({ id: 'file_old' });

    await upload(pdf());

    expect(createRecord).not.toHaveBeenCalled();
    expect(schedule).toHaveBeenCalledWith(
      expect.anything(),
      'user-1',
      expect.objectContaining({ id: 'file_old' }),
    );
  });

  it('файл есть в общей таблице, у человека записи нет: создаётся запись, подготовка идёт по ней', async () => {
    checkHash.mockResolvedValue({ isExist: true, metadata: {}, url: 'files/x.pdf' });

    await upload(pdf());

    expect(createRecord).toHaveBeenCalledTimes(1);
    expect(schedule).toHaveBeenCalledWith(
      expect.anything(),
      'user-1',
      expect.objectContaining({ id: 'file_new' }),
    );
  });

  it('документ базы знаний передаётся с knowledgeBaseId (подготовка сама его пропустит)', async () => {
    await upload(pdf(), { knowledgeBaseId: 'kb1' });

    expect(schedule).toHaveBeenCalledWith(
      expect.anything(),
      'user-1',
      expect.objectContaining({ knowledgeBaseId: 'kb1' }),
    );
  });

  it('сбой запуска подготовки не ломает загрузку', async () => {
    schedule.mockImplementation(() => {
      throw new Error('boom');
    });

    await expect(upload(pdf())).resolves.toEqual({ file: { id: 'file_new' } });
  });

  it('загрузка не ждёт подготовку: результат приходит, пока подготовка не завершена', async () => {
    schedule.mockReturnValue(new Promise(() => {})); // никогда не завершится

    await expect(upload(pdf())).resolves.toEqual({ file: { id: 'file_new' } });
  });
});
