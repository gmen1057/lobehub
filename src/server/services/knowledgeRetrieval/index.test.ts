import { beforeEach, describe, expect, it, vi } from 'vitest';

import { KnowledgeRetrievalService } from './index';

const mocks = vi.hoisted(() => ({
  file: vi.fn(),
  files: vi.fn(),
  document: vi.fn(),
  parse: vi.fn(),
  search: vi.fn(),
  embeddings: vi.fn(),
  runtime: vi.fn(),
}));
vi.mock('@/database/models/file', () => ({
  FileModel: class {
    findById = mocks.file;
    findByIds = mocks.files;
  },
}));
vi.mock('@/database/models/document', () => ({
  DocumentModel: class {
    findByFileId = mocks.document;
  },
}));
vi.mock('@/database/models/chunk', () => ({
  ChunkModel: class {
    semanticSearchForChat = mocks.search;
  },
}));
vi.mock('@/server/services/document', () => ({
  DocumentService: class {
    parseFile = mocks.parse;
  },
}));
vi.mock('@/server/globalConfig', () => ({ getServerDefaultFilesConfig: () => ({}) }));
vi.mock('@/server/modules/ModelRuntime', () => ({ initModelRuntimeFromDB: mocks.runtime }));

describe('shared owner-scoped knowledge retrieval', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('does not parse or read documents when file ownership lookup denies access', async () => {
    mocks.file.mockResolvedValue(undefined);
    const result = await new KnowledgeRetrievalService({} as any, 'owner').getFileContents([
      'foreign-file',
    ]);
    expect(result[0]).toMatchObject({ error: 'File not found', content: '' });
    expect(mocks.document).not.toHaveBeenCalled();
    expect(mocks.parse).not.toHaveBeenCalled();
  });

  it('reads existing originals without requiring embeddings', async () => {
    mocks.file.mockResolvedValue({ name: 'contacts.vcf' });
    mocks.document.mockResolvedValue({ content: 'FULL ORIGINAL', metadata: {} });
    const result = await new KnowledgeRetrievalService({} as any, 'owner').getFileContents([
      'owned-file',
    ]);
    expect(result[0].content).toBe('FULL ORIGINAL');
    expect(mocks.embeddings).not.toHaveBeenCalled();
  });

  it('removes foreign file IDs before the vector search that has no internal tenant filter', async () => {
    mocks.runtime.mockResolvedValue({ embeddings: mocks.embeddings });
    mocks.embeddings.mockResolvedValue([[1, 2]]);
    mocks.files.mockResolvedValue([{ id: 'owned' }]);
    mocks.search.mockResolvedValue([]);
    const service = new KnowledgeRetrievalService({} as any, 'owner');
    await service.semanticSearchForChat({ fileIds: ['owned', 'foreign'], query: 'contact' });
    expect(mocks.search).toHaveBeenCalledWith(expect.objectContaining({ fileIds: ['owned'] }));
  });
});
