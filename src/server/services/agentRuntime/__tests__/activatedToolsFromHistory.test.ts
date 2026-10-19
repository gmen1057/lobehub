import type { LobeToolManifest } from '@lobechat/context-engine';
import { describe, expect, it } from 'vitest';

import {
  collectActivatedToolIdsFromMessages,
  seedActivatedStepToolsFromHistory,
} from '../activatedToolsFromHistory';

// arckep (19.10.2026): подключённое остаётся подключённым в пределах темы — записи activatedStepTools
// восстанавливаются из истории сообщений новой операции.

const activatorMessage = (
  identifiers: string[],
  { plugin = 'lobe-activator' }: { plugin?: string } = {},
) => ({
  plugin: { apiName: 'activateTools', identifier: plugin },
  pluginState: {
    activatedTools: identifiers.map((identifier) => ({ identifier, name: identifier })),
  },
  role: 'tool',
});

const manifest = (identifier: string): LobeToolManifest =>
  ({
    api: [{ description: 'do it', name: 'run', parameters: { properties: {}, type: 'object' } }],
    identifier,
    meta: { title: identifier },
    type: 'default',
  }) as unknown as LobeToolManifest;

describe('collectActivatedToolIdsFromMessages', () => {
  it('собирает идентификаторы из tool-сообщений активатора, без повторов и в порядке подключения', () => {
    const ids = collectActivatedToolIdsFromMessages([
      { content: 'привет', role: 'user' },
      activatorMessage(['mcp-arckep-studio-images', 'arckep-sites']),
      { content: 'ответ', role: 'assistant' },
      activatorMessage(['arckep-sites', 'lobe-notebook']),
    ]);

    expect(ids).toEqual(['mcp-arckep-studio-images', 'arckep-sites', 'lobe-notebook']);
  });

  it('понимает и старое имя активатора lobe-tools', () => {
    expect(
      collectActivatedToolIdsFromMessages([
        activatorMessage(['lobe-calculator'], { plugin: 'lobe-tools' }),
      ]),
    ).toEqual(['lobe-calculator']);
  });

  it('игнорирует чужие инструменты, не-tool сообщения и сообщения без activatedTools', () => {
    const ids = collectActivatedToolIdsFromMessages([
      // результат другого инструмента с таким же полем состояния
      { ...activatorMessage(['lobe-notebook'], { plugin: 'lobe-user-memory' }) },
      // не tool
      { ...activatorMessage(['lobe-creds']), role: 'assistant' },
      // активатор без activatedTools (activateSkill) и с неверной формой
      { plugin: { identifier: 'lobe-activator' }, pluginState: { name: 'skill' }, role: 'tool' },
      {
        plugin: { identifier: 'lobe-activator' },
        pluginState: { activatedTools: 'oops' },
        role: 'tool',
      },
      { plugin: { identifier: 'lobe-activator' }, pluginState: null, role: 'tool' },
      { role: 'tool' },
      // запись без идентификатора
      {
        plugin: { identifier: 'lobe-activator' },
        pluginState: { activatedTools: [{ name: 'x' }, null, { identifier: 7 }] },
        role: 'tool',
      },
    ] as any);

    expect(ids).toEqual([]);
  });

  it('пустая и отсутствующая история — пустой результат', () => {
    expect(collectActivatedToolIdsFromMessages([])).toEqual([]);
    expect(collectActivatedToolIdsFromMessages(undefined)).toEqual([]);
  });
});

describe('seedActivatedStepToolsFromHistory', () => {
  const toolSet = {
    enabledToolIds: ['lobe-activator', 'mcp-arckep-e2b-sandbox'],
    manifestMap: {
      'arckep-sites': manifest('arckep-sites'),
      'lobe-activator': manifest('lobe-activator'),
      'mcp-arckep-e2b-sandbox': manifest('mcp-arckep-e2b-sandbox'),
      'mcp-arckep-studio-images': manifest('mcp-arckep-studio-images'),
    },
  };

  it('кладёт записи той же формы, что пишет RuntimeExecutors, с манифестом из набора операции', () => {
    const seeded = seedActivatedStepToolsFromHistory(
      [activatorMessage(['mcp-arckep-studio-images'])],
      toolSet,
    );

    expect(seeded).toEqual([
      {
        activatedAtStep: 0,
        id: 'mcp-arckep-studio-images',
        manifest: toolSet.manifestMap['mcp-arckep-studio-images'],
        source: 'discovery',
      },
    ]);
  });

  it('не возвращает то, чего нет в наборе операции: выключенное человеком, память, удалённые подключения', () => {
    const seeded = seedActivatedStepToolsFromHistory(
      [
        activatorMessage(['lobe-user-memory', 'mcp-removed-connection', 'arckep-sites']),
        activatorMessage(['lobe-calculator']),
      ],
      toolSet,
    );

    // у lobe-user-memory (память выключена), mcp-removed-connection и lobe-calculator манифеста нет
    expect(seeded.map((tool) => tool.id)).toEqual(['arckep-sites']);
  });

  it('не дублирует то, что и так включено с первого шага', () => {
    const seeded = seedActivatedStepToolsFromHistory(
      [activatorMessage(['mcp-arckep-e2b-sandbox', 'lobe-activator', 'arckep-sites'])],
      toolSet,
    );

    expect(seeded.map((tool) => tool.id)).toEqual(['arckep-sites']);
  });

  it('без истории, без активаций и без набора инструментов — пусто', () => {
    expect(seedActivatedStepToolsFromHistory([], toolSet)).toEqual([]);
    expect(seedActivatedStepToolsFromHistory([{ content: 'hi', role: 'user' }], toolSet)).toEqual(
      [],
    );
    expect(
      seedActivatedStepToolsFromHistory([activatorMessage(['arckep-sites'])], undefined),
    ).toEqual([]);
    expect(
      seedActivatedStepToolsFromHistory([activatorMessage(['arckep-sites'])], {
        enabledToolIds: [],
        manifestMap: undefined as any,
      }),
    ).toEqual([]);
  });
});
