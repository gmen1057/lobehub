import { describe, expect, it, vi } from 'vitest';

import { ResponsesService } from '../responses.service';

// Stub external dependencies so ResponsesService can be imported in isolation
vi.mock('@/server/modules/AgentRuntime/InMemoryStreamEventManager', () => ({
  InMemoryStreamEventManager: class {},
}));
vi.mock('@/server/modules/AgentRuntime/StreamEventManager', () => ({}));
vi.mock('@/server/services/agentRuntime', () => ({ AgentRuntimeService: class {} }));
vi.mock('@/server/services/aiAgent', () => ({ AiAgentService: class {} }));
vi.mock('../../common/base.service', () => ({
  BaseService: class {
    db: any;
    userId = '';
    constructor() {}
    log() {}
  },
}));

const findById = vi.fn();
vi.mock('@/database/models/file', () => ({
  FileModel: class {
    findById = findById;
  },
}));
vi.mock('@/server/services/file', () => ({
  FileService: class {
    getFullFileUrl = async (url: string) => `https://files.test/${url}`;
  },
}));

const extract = (input: any) => {
  const svc = new (ResponsesService as any)(null, null);
  return svc['extractAttachments'](input);
};

describe('ResponsesService.extractAttachments (arckep)', () => {
  it('строковый ввод — вложений нет', async () => {
    expect(await extract('привет')).toEqual([]);
  });

  it('input_image с https и input_file по id пользователя → files для execAgent', async () => {
    findById.mockResolvedValueOnce({
      fileType: 'application/pdf',
      name: 'договор.pdf',
      size: 1234,
      url: 'files/abc.pdf',
    });
    const files = await extract([
      {
        content: [
          { text: 'что на фото?', type: 'input_text' },
          { image_url: 'https://s3.example/img.png', type: 'input_image' },
          { file_id: 'file_1', type: 'input_file' },
        ],
        role: 'user',
        type: 'message',
      },
    ]);
    expect(files).toEqual([
      { name: 'image', url: 'https://s3.example/img.png' },
      {
        mimeType: 'application/pdf',
        name: 'договор.pdf',
        size: 1234,
        url: 'https://files.test/files/abc.pdf',
      },
    ]);
    expect(findById).toHaveBeenCalledWith('file_1');
  });

  it('чужой или несуществующий file_id пропускается, http-картинка не берётся', async () => {
    findById.mockResolvedValueOnce(null);
    const files = await extract([
      {
        content: [
          { image_url: 'http://plain.example/img.png', type: 'input_image' },
          { file_id: 'file_foreign', type: 'input_file' },
        ],
        role: 'user',
        type: 'message',
      },
    ]);
    expect(files).toEqual([]);
  });

  it('берётся последнее сообщение пользователя', async () => {
    const files = await extract([
      {
        content: [{ image_url: 'https://s3.example/old.png', type: 'input_image' }],
        role: 'user',
        type: 'message',
      },
      { content: 'ответ', role: 'assistant', type: 'message' },
      {
        content: [{ image_url: 'https://s3.example/new.png', type: 'input_image' }],
        role: 'user',
        type: 'message',
      },
    ]);
    expect(files.map((f: any) => f.url)).toEqual(['https://s3.example/new.png']);
  });
});
