import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createServerToolsEngine } from '@/server/modules/Mecha/AgentToolsEngine';
import { createToolImageUrlResolver } from '@/server/modules/Mecha/ContextEngineering/toolResultImageUrl';

import { MessagesEngine } from '../../../../packages/context-engine/src/engine/messages/MessagesEngine';
import { contentBlocksToString, processContentBlocks } from './contentProcessor';

const E2B = 'mcp-arckep-e2b-sandbox';
const mocks = vi.hoisted(() => ({ fileModelCtor: vi.fn(), findById: vi.fn(), sign: vi.fn() }));
vi.mock('@/database/models/file', () => ({
  FileModel: class {
    constructor(...args: unknown[]) {
      mocks.fileModelCtor(...args);
    }
    findById = mocks.findById;
  },
}));
vi.mock('@/server/services/file', () => ({
  FileService: class {
    getFullFileUrl = mocks.sign;
  },
}));

const manifest = (identifier = E2B) => ({
  api: [
    {
      description: 'Прочитать файл. Возвращает base64. Платно: существующая цена.',
      name: 'read_file',
      parameters: { properties: { path: { type: 'string' } }, required: ['path'], type: 'object' },
    },
    {
      description: 'Выполнить код. Файл возвращается как base64. Платно: существующая цена.',
      name: 'execute_and_get_file',
      parameters: {
        properties: { code: { type: 'string' }, output_file: { type: 'string' } },
        required: ['code', 'output_file'],
        type: 'object',
      },
    },
  ],
  identifier,
  meta: { description: 'Sandbox', title: 'Sandbox' },
  type: 'mcp' as const,
});

describe('actual sandbox schema and following model payload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findById.mockResolvedValue({ fileType: 'image/png', size: 4, url: 'owned/scan.png' });
    mocks.sign.mockResolvedValue('https://storage.example/owned/scan.png?signed=fixture');
  });

  it('assembles the transformed file contract into API schemas and system context without changing installed data', async () => {
    const installed = manifest();
    const original = JSON.stringify(installed);
    const engine = createServerToolsEngine({
      installedPlugins: [{ identifier: E2B, manifest: installed } as any],
      isModelSupportToolUse: () => true,
    });
    const result = engine.generateToolsDetailed({
      model: 'fixture',
      provider: 'fixture',
      toolIds: [E2B],
    });
    const read = result.tools?.find((tool) => tool.function.name.includes('read_file'))?.function;
    expect(read?.description).toContain('ссылка на сохранённый файл');
    expect(read?.description).not.toContain('Возвращает base64');
    expect(read?.description).toContain('Платно: существующая цена.');
    expect(read?.parameters).toEqual(installed.api[0].parameters);
    expect(JSON.stringify(installed)).toBe(original);
    const payload = await new MessagesEngine({
      enableSystemDate: false,
      messages: [{ content: 'Сделай Excel', createdAt: 1, updatedAt: 1, id: 'u', role: 'user' }],
      model: 'fixture',
      provider: 'fixture',
      toolsConfig: { manifests: result.enabledManifests, tools: result.enabledToolIds },
    }).process();
    expect(payload.messages.find((message) => message.role === 'system')?.content).toContain(
      'PDF/Excel возвращаются ссылкой для скачивания, без просмотра их содержимого',
    );
  });

  it('does not override arbitrary MCP schemas with similar names', () => {
    const installed = manifest('mcp-arckep-e2b-sandbox-custom');
    const engine = createServerToolsEngine({
      installedPlugins: [{ identifier: installed.identifier, manifest: installed } as any],
      isModelSupportToolUse: () => true,
    });
    expect(engine.getPluginManifest(installed.identifier)).toEqual(installed);
  });

  it.each([true, false])(
    'next model payload respects vision=%s and resolves the owned fileId',
    async (vision) => {
      const blocks = await processContentBlocks(
        [
          {
            text: JSON.stringify({
              content_base64: 'aGVsbG8=',
              filename: 'scan.png',
              success: true,
            }),
            type: 'text',
          },
        ],
        {
          uploadBase64: vi.fn(async () => ({
            fileId: 'owned-scan',
            url: 'https://arckep.ru/chat/f/owned-scan',
          })),
        } as any,
        { fileImagesAsMedia: true },
      );
      const db = {} as any;
      const output = await new MessagesEngine({
        capabilities: { isCanUseFC: () => true, isCanUseVision: () => vision },
        enableSystemDate: false,
        messages: [
          { content: 'Прочитай страницу', id: 'u', role: 'user' },
          {
            content: '',
            id: 'a',
            role: 'assistant',
            tools: [
              { apiName: 'read_file', arguments: '{}', id: 'call', identifier: E2B, type: 'mcp' },
            ],
          },
          {
            content: contentBlocksToString(blocks),
            id: 't',
            plugin: { apiName: 'read_file', identifier: E2B },
            pluginState: { content: blocks },
            role: 'tool',
            tool_call_id: 'call',
          },
        ] as any,
        model: 'fixture',
        provider: 'fixture',
        toolResultImages: { resolveImageUrl: createToolImageUrlResolver(db, 'owner-fixture') },
      }).process();
      const serialized = JSON.stringify(output.messages);
      expect(serialized).not.toContain('aGVsbG8=');
      expect(serialized).toContain('Файл готов:');
      if (vision) {
        expect(serialized).toContain('"type":"image_url"');
        expect(serialized).toContain('https://storage.example/owned/scan.png?signed=fixture');
        expect(mocks.fileModelCtor).toHaveBeenCalledWith(db, 'owner-fixture');
        expect(mocks.findById).toHaveBeenCalledWith('owned-scan');
        expect(mocks.sign).toHaveBeenCalledWith('owned/scan.png');
      } else {
        expect(serialized).not.toContain('"type":"image_url"');
        expect(mocks.findById).not.toHaveBeenCalled();
        expect(mocks.sign).not.toHaveBeenCalled();
      }
    },
  );
});
