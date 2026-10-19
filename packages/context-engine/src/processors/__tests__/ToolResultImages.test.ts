import { describe, expect, it, vi } from 'vitest';

import { MessagesEngine } from '../../engine/messages/MessagesEngine';
import type { PipelineContext } from '../../types';
import {
  extractToolResultImages,
  TOOL_RESULT_IMAGES_LIMIT,
  type ToolResultImage,
  ToolResultImagesProcessor,
} from '../ToolResultImages';

const createContext = (messages: any[]): PipelineContext => ({
  initialState: { messages: [] } as any,
  isAborted: false,
  messages,
  metadata: { maxTokens: 4096, model: 'gpt-4' },
});

/** Блок картинки после processContentBlocks: адрес на сайте + запись файла */
const imageBlock = (n: number, extra: Record<string, unknown> = {}) => ({
  data: `https://arckep.ru/chat/f/file-${n}`,
  fileId: `file-${n}`,
  mimeType: 'image/png',
  type: 'image',
  ...extra,
});

const toolMessage = (callId: string, blocks: any[], extra: Record<string, unknown> = {}) => ({
  content: `result of ${callId}`,
  pluginState: { content: blocks },
  role: 'tool',
  tool_call_id: callId,
  ...extra,
});

const assistantCalls = (...ids: string[]) => ({
  content: '',
  role: 'assistant',
  tool_calls: ids.map((id) => ({
    function: { arguments: '{}', name: 'mcp-figma____get_screenshot____mcp' },
    id,
    type: 'function',
  })),
});

/** Подписанная ссылка вместо адреса на сайте */
const signed = (image: ToolResultImage) =>
  Promise.resolve(`https://s3.example/signed/${image.fileId}?X-Amz-Signature=abc`);

const makeProcessor = (
  overrides: Partial<ConstructorParameters<typeof ToolResultImagesProcessor>[0]> = {},
) =>
  new ToolResultImagesProcessor({
    isCanUseVision: () => true,
    model: 'claude-opus',
    provider: 'anthropic',
    resolveImageUrl: signed,
    ...overrides,
  });

describe('extractToolResultImages', () => {
  it('берёт только картинки с адресом http(s); base64, data-URI и SVG — никогда', () => {
    const images = extractToolResultImages({
      content: [
        { text: 'hello', type: 'text' },
        imageBlock(1),
        { data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB', mimeType: 'image/png', type: 'image' },
        { data: 'data:image/png;base64,AAAA', mimeType: 'image/png', type: 'image' },
        imageBlock(2, { mimeType: 'image/svg+xml' }),
        imageBlock(3, { data: 'https://example.com/pic.svg?x=1', mimeType: undefined }),
        { type: 'audio', data: 'https://arckep.ru/chat/f/a', mimeType: 'audio/mp3' },
      ],
    });

    expect(images).toEqual([
      { fileId: 'file-1', mimeType: 'image/png', url: 'https://arckep.ru/chat/f/file-1' },
    ]);
  });

  it('не падает на мусоре', () => {
    expect(extractToolResultImages(undefined)).toEqual([]);
    expect(extractToolResultImages(null)).toEqual([]);
    expect(extractToolResultImages({ content: 'text' })).toEqual([]);
    expect(extractToolResultImages({ content: [null, 5, 'x'] })).toEqual([]);
  });
});

describe('ToolResultImagesProcessor', () => {
  it('кладёт user-сообщение с подписью и картинкой сразу после tool-сообщения; адрес — подписанная ссылка', async () => {
    const messages = [
      { content: 'Покажи макет', role: 'user' },
      assistantCalls('call_1'),
      toolMessage('call_1', [{ text: 'ok', type: 'text' }, imageBlock(1)]),
    ];

    const result = await makeProcessor().process(createContext(messages));

    expect(result.messages).toHaveLength(4);
    expect(result.messages[3]).toEqual({
      content: [
        {
          text: 'Images returned by tool mcp-figma.get_screenshot (already shown to the user; look at them to answer):',
          type: 'text',
        },
        {
          image_url: {
            detail: 'auto',
            url: 'https://s3.example/signed/file-1?X-Amz-Signature=abc',
          },
          type: 'image_url',
        },
      ],
      role: 'user',
    });
    // Адрес на сайте (/f/:id) в добавленное сообщение не попадает, а исходный список не меняется
    expect(JSON.stringify(result.messages[3])).not.toContain('arckep.ru/chat/f/');
    expect(messages).toHaveLength(3);
    expect(result.metadata.toolResultImages).toEqual({ candidates: 1, inserted: 1, messages: 1 });
  });

  it('подпись берёт из plugin сообщения, если он есть', async () => {
    const messages = [
      { content: 'q', role: 'user' },
      assistantCalls('call_1'),
      toolMessage('call_1', [imageBlock(1)], {
        plugin: { apiName: 'screenshot', identifier: 'web-fetch', type: 'mcp' },
      }),
    ];

    const result = await makeProcessor().process(createContext(messages));

    expect((result.messages[3] as any).content[0].text).toContain('tool web-fetch.screenshot (');
  });

  it('группа из нескольких tool-сообщений: user-сообщение — после последнего из них, по подписи на каждый ответ', async () => {
    const messages = [
      { content: 'q', role: 'user' },
      assistantCalls('call_1', 'call_2', 'call_3'),
      toolMessage('call_1', [imageBlock(1)]),
      toolMessage('call_2', [{ text: 'нет картинок', type: 'text' }]),
      toolMessage('call_3', [imageBlock(3), imageBlock(4)]),
    ];

    const result = await makeProcessor().process(createContext(messages));

    expect(result.messages.map((m: any) => m.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool',
      'tool',
      'user',
    ]);
    const parts = (result.messages[5] as any).content;
    expect(parts.map((p: any) => p.type)).toEqual([
      'text',
      'image_url',
      'text',
      'image_url',
      'image_url',
    ]);
    expect(parts[1].image_url.url).toContain('file-1');
    expect(parts[3].image_url.url).toContain('file-3');
    expect(parts[4].image_url.url).toContain('file-4');
  });

  it('картинки из прошлых ходов (до последнего user-сообщения) не отправляются', async () => {
    const messages = [
      { content: 'первый вопрос', role: 'user' },
      assistantCalls('call_old'),
      toolMessage('call_old', [imageBlock(1)]),
      { content: 'готово', role: 'assistant' },
      { content: 'второй вопрос', role: 'user' },
      assistantCalls('call_new'),
      toolMessage('call_new', [imageBlock(2)]),
    ];

    const result = await makeProcessor().process(createContext(messages));

    expect(result.messages).toHaveLength(8);
    const added = result.messages.filter((m: any) => Array.isArray(m.content));
    expect(added).toHaveLength(1);
    expect(JSON.stringify(added[0])).not.toContain('file-1');
    expect(JSON.stringify(added[0])).toContain('file-2');
  });

  it('несколько групп в одном ходу: user-сообщение после каждой, порядок assistant → tool сохранён', async () => {
    const messages = [
      { content: 'q', role: 'user' },
      assistantCalls('call_a'),
      toolMessage('call_a', [imageBlock(1)]),
      assistantCalls('call_b'),
      toolMessage('call_b', [imageBlock(2)]),
    ];

    const result = await makeProcessor().process(createContext(messages));

    expect(result.messages.map((m: any) => m.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'user',
      'assistant',
      'tool',
      'user',
    ]);
    expect((result.messages[3] as any).content[1].image_url.url).toContain('file-1');
    expect((result.messages[6] as any).content[1].image_url.url).toContain('file-2');
  });

  it(`не больше ${TOOL_RESULT_IMAGES_LIMIT} картинок за запрос — самые свежие`, async () => {
    const messages = [
      { content: 'q', role: 'user' },
      assistantCalls('call_1', 'call_2'),
      toolMessage('call_1', [imageBlock(1), imageBlock(2), imageBlock(3)]),
      toolMessage('call_2', [imageBlock(4), imageBlock(5), imageBlock(6)]),
    ];

    const result = await makeProcessor().process(createContext(messages));

    const images = (result.messages.at(-1) as any).content.filter(
      (p: any) => p.type === 'image_url',
    );
    expect(images.map((p: any) => /file-(\d)/.exec(p.image_url.url)![1])).toEqual([
      '3',
      '4',
      '5',
      '6',
    ]);
    expect(result.metadata.toolResultImages).toEqual({ candidates: 6, inserted: 4, messages: 1 });
  });

  it('предел можно задать, 0 — ничего не добавляет', async () => {
    const messages = [
      { content: 'q', role: 'user' },
      assistantCalls('call_1'),
      toolMessage('call_1', [imageBlock(1), imageBlock(2)]),
    ];

    const one = await makeProcessor({ maxImages: 1 }).process(createContext(messages));
    expect(
      (one.messages.at(-1) as any).content.filter((p: any) => p.type === 'image_url'),
    ).toHaveLength(1);

    const none = await makeProcessor({ maxImages: 0 }).process(createContext(messages));
    expect(none.messages).toHaveLength(3);
  });

  it('модель без зрения или без проверки зрения — сообщения не меняются', async () => {
    const messages = [
      { content: 'q', role: 'user' },
      assistantCalls('call_1'),
      toolMessage('call_1', [imageBlock(1)]),
    ];
    const resolveImageUrl = vi.fn(signed);

    const noVision = await makeProcessor({ isCanUseVision: () => false, resolveImageUrl }).process(
      createContext(messages),
    );
    const unknown = await makeProcessor({ isCanUseVision: undefined, resolveImageUrl }).process(
      createContext(messages),
    );

    expect(noVision.messages).toEqual(messages);
    expect(unknown.messages).toEqual(messages);
    expect(resolveImageUrl).not.toHaveBeenCalled();
  });

  it('SVG и сырой base64 до модели не доходят', async () => {
    const messages = [
      { content: 'q', role: 'user' },
      assistantCalls('call_1'),
      toolMessage('call_1', [
        imageBlock(1, { mimeType: 'image/svg+xml' }),
        { data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB', mimeType: 'image/png', type: 'image' },
      ]),
    ];
    const resolveImageUrl = vi.fn(signed);

    const result = await makeProcessor({ resolveImageUrl }).process(createContext(messages));

    expect(result.messages).toHaveLength(3);
    expect(resolveImageUrl).not.toHaveBeenCalled();
  });

  it('картинка без адреса для провайдера (resolver вернул undefined или упал) пропускается, пустого сообщения нет', async () => {
    const messages = [
      { content: 'q', role: 'user' },
      assistantCalls('call_1'),
      toolMessage('call_1', [imageBlock(1), imageBlock(2)]),
    ];
    const resolveImageUrl = vi.fn(async (image: ToolResultImage) => {
      if (image.fileId === 'file-1') throw new Error('storage is down');
      return undefined;
    });

    const result = await makeProcessor({ resolveImageUrl }).process(createContext(messages));

    expect(result.messages).toHaveLength(3);
    expect(result.metadata.toolResultImages).toEqual({ candidates: 2, inserted: 0, messages: 0 });
  });

  it('одну и ту же картинку не повторяет', async () => {
    const messages = [
      { content: 'q', role: 'user' },
      assistantCalls('call_1', 'call_2'),
      toolMessage('call_1', [imageBlock(1)]),
      toolMessage('call_2', [imageBlock(1)]),
    ];

    const result = await makeProcessor().process(createContext(messages));

    const images = (result.messages.at(-1) as any).content.filter(
      (p: any) => p.type === 'image_url',
    );
    expect(images).toHaveLength(1);
  });

  it('без user-сообщений (бот, cron) текущий ход — вся переписка', async () => {
    const messages = [assistantCalls('call_1'), toolMessage('call_1', [imageBlock(1)])];

    const result = await makeProcessor().process(createContext(messages));

    expect(result.messages.map((m: any) => m.role)).toEqual(['assistant', 'tool', 'user']);
  });
});

describe('MessagesEngine: картинки инструментов в общем конвейере', () => {
  const messages = [
    { content: 'Посмотри кадр', createdAt: 1, id: 'u1', role: 'user', updatedAt: 1 },
    {
      content: '',
      createdAt: 2,
      id: 'a1',
      role: 'assistant',
      tools: [
        {
          apiName: 'get_screenshot',
          arguments: '{}',
          id: 'call_1',
          identifier: 'mcp-figma',
          type: 'mcp',
        },
      ],
      updatedAt: 2,
    },
    {
      content: 'Screenshot of node 1:2\n\n![](https://arckep.ru/chat/f/file-1)',
      createdAt: 3,
      id: 't1',
      plugin: {
        apiName: 'get_screenshot',
        arguments: '{}',
        id: 'call_1',
        identifier: 'mcp-figma',
        type: 'mcp',
      },
      pluginState: { content: [imageBlock(1)] },
      role: 'tool',
      tool_call_id: 'call_1',
      updatedAt: 3,
    },
  ] as any[];

  const run = (params: Record<string, unknown> = {}) =>
    new MessagesEngine({
      capabilities: { isCanUseVision: () => true },
      messages,
      model: 'claude-opus',
      provider: 'anthropic',
      toolResultImages: { resolveImageUrl: signed },
      ...params,
    }).processMessages();

  it('после очистки: assistant(tool_calls) → tool (только текст, ссылка на сайт) → user с картинкой', async () => {
    const result = await run();

    const roles = result.map((m) => m.role);
    expect(roles.slice(-4)).toEqual(['user', 'assistant', 'tool', 'user']);

    const tool = result.at(-2)!;
    expect(typeof tool.content).toBe('string');
    expect(tool.content).toContain('![](https://arckep.ru/chat/f/file-1)');

    const last = result.at(-1)!;
    expect(Array.isArray(last.content)).toBe(true);
    expect(Object.keys(last).sort()).toEqual(['content', 'role']);
    expect((last.content as any[]).at(-1)).toEqual({
      image_url: { detail: 'auto', url: 'https://s3.example/signed/file-1?X-Amz-Signature=abc' },
      type: 'image_url',
    });
  });

  it('без toolResultImages (клиентский конвейер) или без зрения — конвейер как раньше', async () => {
    const without = await run({ toolResultImages: undefined });
    const noVision = await run({ capabilities: { isCanUseVision: () => false } });

    expect(without.at(-1)!.role).toBe('tool');
    expect(noVision.at(-1)!.role).toBe('tool');
  });
});
