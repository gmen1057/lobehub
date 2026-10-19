import { describe, expect, it } from 'vitest';

import {
  ARCKEP_LINK_CONNECTORS,
  hasFilledConnectorSettings,
  resolveArckepLinkConnectors,
} from '../arckepLinkConnectors';

// arckep (19.10.2026): ссылка на Figma в последнем сообщении → подключение mcp-arckep-figma сразу или подсказка

const FIGMA = 'mcp-arckep-figma';
const figmaLink = 'https://www.figma.com/design/AbC123xyz/Landing?node-id=12-34&t=zzz';
const withToken = { identifier: FIGMA, settings: { 'X-MCP-Password': 'enc:v1:AAAA' } };

describe('таблица ссылок', () => {
  it('сейчас одна строка — Figma', () => {
    expect(ARCKEP_LINK_CONNECTORS.map((entry) => entry.connectorId)).toEqual([FIGMA]);
  });
});

describe('resolveArckepLinkConnectors — ссылка есть, подключение настроено', () => {
  it('включает подключение сразу и не добавляет подсказку', () => {
    expect(
      resolveArckepLinkConnectors({
        installedPlugins: [withToken],
        prompt: `${figmaLink} — посмотри что тут`,
      }),
    ).toEqual({ activate: [FIGMA], setupHints: [] });
  });

  it.each([
    ['design', 'https://www.figma.com/design/AbC123/Name'],
    ['старая file', 'https://www.figma.com/file/AbC123/Name?node-id=1%3A2'],
    ['proto', 'https://www.figma.com/proto/AbC123/Name?page-id=0%3A1'],
    ['board (FigJam)', 'https://www.figma.com/board/AbC123/Name'],
    ['slides', 'https://www.figma.com/slides/AbC123/Name'],
    ['make', 'https://www.figma.com/make/AbC123/Name'],
    ['без www', 'https://figma.com/design/AbC123/Name'],
    ['без схемы', 'figma.com/design/AbC123/Name'],
    ['регистр', 'HTTPS://WWW.FIGMA.COM/Design/AbC123/Name'],
    ['в скобках', 'Вот макет (https://www.figma.com/design/AbC123/Name), что скажешь?'],
    ['в разметке', 'Смотри [макет](https://www.figma.com/design/AbC123/Name)'],
    ['в угловых', 'см. <https://www.figma.com/design/AbC123/Name>'],
    ['вторая строка', 'Привет\nпосмотри\nhttps://www.figma.com/design/AbC123/Name'],
  ])('узнаёт ссылку: %s', (_name, prompt) => {
    expect(resolveArckepLinkConnectors({ installedPlugins: [withToken], prompt }).activate).toEqual(
      [FIGMA],
    );
  });

  it('две ссылки в сообщении дают один раз', () => {
    const result = resolveArckepLinkConnectors({
      installedPlugins: [withToken],
      prompt: `${figmaLink} и ещё https://www.figma.com/design/Other456/Second`,
    });
    expect(result.activate).toEqual([FIGMA]);
  });

  it('остальные подключения человека на результат не влияют', () => {
    const result = resolveArckepLinkConnectors({
      installedPlugins: [
        { identifier: 'mcp-arckep-wordstat', settings: { token: 'x' } },
        withToken,
      ],
      prompt: figmaLink,
    });
    expect(result).toEqual({ activate: [FIGMA], setupHints: [] });
  });
});

describe('resolveArckepLinkConnectors — ссылки нет или она чужая', () => {
  it.each([
    ['пустое сообщение', ''],
    ['обычный текст', 'Нарисуй кота и расскажи про Figma'],
    ['слово Figma без ссылки', 'открой figma.com и посмотри'],
    ['корень сайта', 'https://www.figma.com/'],
    ['страница Figma не про файл', 'https://www.figma.com/pricing'],
    ['ссылка сообщества', 'https://www.figma.com/community/file/123456/Some-Kit'],
    ['чужой сайт с похожим именем', 'https://notfigma.com/design/AbC123/Name'],
    ['figma.com как поддомен чужого', 'https://figma.com.evil.ru/design/AbC123/Name'],
    [
      'ссылка Figma внутри параметра чужой ссылки',
      'https://evil.com/?u=figma.com/design/AbC123/Name',
    ],
    ['ссылка с разделом без файла', 'https://www.figma.com/design/'],
    ['другие сервисы', 'https://docs.google.com/document/d/abc/edit https://github.com/a/b'],
  ])('ничего не включает и не подсказывает: %s', (_name, prompt) => {
    expect(resolveArckepLinkConnectors({ installedPlugins: [withToken], prompt })).toEqual({
      activate: [],
      setupHints: [],
    });
    expect(resolveArckepLinkConnectors({ installedPlugins: [], prompt })).toEqual({
      activate: [],
      setupHints: [],
    });
  });

  it('без сообщения (undefined) не падает', () => {
    expect(resolveArckepLinkConnectors({ installedPlugins: [withToken] })).toEqual({
      activate: [],
      setupHints: [],
    });
  });
});

describe('resolveArckepLinkConnectors — ссылка есть, подключения нет', () => {
  it('подключение не установлено: подсказка «подключите Figma»', () => {
    const result = resolveArckepLinkConnectors({ installedPlugins: [], prompt: figmaLink });
    expect(result.activate).toEqual([]);
    expect(result.setupHints).toHaveLength(1);
    expect(result.setupHints[0]).toContain(
      'Подключите Figma: Подключения → Figma → вставьте личный токен',
    );
    expect(result.setupHints[0]).toContain('Do not say you cannot open Figma links');
  });

  it('установлено, но настройки пусты (токена нет): подсказка, не включение', () => {
    for (const settings of [
      undefined,
      null,
      {},
      { 'X-MCP-Password': '' },
      { 'X-MCP-Password': '   ' },
    ]) {
      const result = resolveArckepLinkConnectors({
        installedPlugins: [{ identifier: FIGMA, settings }],
        prompt: figmaLink,
      });
      expect(result.activate, JSON.stringify(settings)).toEqual([]);
      expect(result.setupHints, JSON.stringify(settings)).toHaveLength(1);
    }
  });

  it('подключение другого человека/другое по названию не считается', () => {
    const result = resolveArckepLinkConnectors({
      installedPlugins: [{ identifier: 'mcp-arckep-wordstat', settings: { token: 'x' } }],
      prompt: figmaLink,
    });
    expect(result.activate).toEqual([]);
    expect(result.setupHints).toHaveLength(1);
  });
});

describe('resolveArckepLinkConnectors — выключено в запросе', () => {
  it('disabled_tools с подключением: не включаем', () => {
    expect(
      resolveArckepLinkConnectors({
        excludePluginIds: [FIGMA],
        installedPlugins: [withToken],
        prompt: figmaLink,
      }),
    ).toEqual({ activate: [], setupHints: [] });
  });

  it('выключенное не уговариваем подключить, даже если токена нет', () => {
    expect(
      resolveArckepLinkConnectors({
        excludePluginIds: [FIGMA],
        installedPlugins: [],
        prompt: figmaLink,
      }),
    ).toEqual({ activate: [], setupHints: [] });
  });

  it('выключено другое подключение — Figma включается', () => {
    expect(
      resolveArckepLinkConnectors({
        excludePluginIds: ['mcp-arckep-wordstat'],
        installedPlugins: [withToken],
        prompt: figmaLink,
      }).activate,
    ).toEqual([FIGMA]);
  });
});

describe('resolveArckepLinkConnectors — таблица расширяется строкой', () => {
  const table = [
    ...ARCKEP_LINK_CONNECTORS,
    {
      connectorId: 'mcp-arckep-docs',
      pattern: /docs\.example\.com\/d\/\w+/i,
      requiresSettings: false,
      setupHint: 'Docs is not connected.',
    },
  ];

  it('подключение без личных настроек включается, если оно просто установлено', () => {
    const result = resolveArckepLinkConnectors({
      installedPlugins: [{ identifier: 'mcp-arckep-docs' }],
      prompt: 'см. https://docs.example.com/d/abc123',
      table,
    });
    expect(result).toEqual({ activate: ['mcp-arckep-docs'], setupHints: [] });
  });

  it('обе ссылки в одном сообщении: что настроено — включается, что нет — подсказка', () => {
    const result = resolveArckepLinkConnectors({
      installedPlugins: [withToken],
      prompt: `${figmaLink} и https://docs.example.com/d/abc123`,
      table,
    });
    expect(result.activate).toEqual([FIGMA]);
    expect(result.setupHints).toEqual(['Docs is not connected.']);
  });
});

describe('hasFilledConnectorSettings', () => {
  it('непустое значение — заполнено', () => {
    expect(hasFilledConnectorSettings({ 'X-MCP-Password': 'enc:v1:AAAA' })).toBe(true);
    expect(hasFilledConnectorSettings({ limit: 5 })).toBe(true);
    expect(hasFilledConnectorSettings({ flag: false })).toBe(true);
  });

  it('пустое, пустые строки и не-объекты — не заполнено', () => {
    for (const value of [
      undefined,
      null,
      '',
      'token',
      0,
      [],
      {},
      { a: '' },
      { a: ' ' },
      { a: null },
    ]) {
      expect(hasFilledConnectorSettings(value), JSON.stringify(value)).toBe(false);
    }
  });
});
