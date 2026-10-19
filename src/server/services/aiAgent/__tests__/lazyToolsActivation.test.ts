// @vitest-environment node
import { builtinTools } from '@lobechat/builtin-tools';
import { buildStepToolDelta, type LobeToolManifest, ToolResolver } from '@lobechat/context-engine';
import { describe, expect, it } from 'vitest';

import { createServerAgentToolsEngine } from '@/server/modules/Mecha';
import { seedActivatedStepToolsFromHistory } from '@/server/services/agentRuntime/activatedToolsFromHistory';
import { hasServerRuntime } from '@/server/services/toolExecution/serverRuntimes';
import { activatorRuntime } from '@/server/services/toolExecution/serverRuntimes/activator';

// arckep (19.10.2026): настоящие модули, без подмен. Отложенные инструменты (MCP-подключение, база
// знаний, ссылки на темы) находятся движком инструментов, подключаются шагом activateTools, из
// истории темы возвращаются в следующую операцию и уже в первом шаге дают функции модели.

const mcpManifest = {
  api: [
    {
      description: 'Ключевые слова',
      name: 'keywords',
      parameters: { properties: { q: { type: 'string' } }, type: 'object' },
    },
  ],
  identifier: 'mcp-arckep-wordstat',
  mcpParams: { type: 'http', url: 'http://127.0.0.1:1/mcp' },
  meta: { description: 'Wordstat', title: 'Wordstat' },
  type: 'mcp',
} as unknown as LobeToolManifest;

const LAZY_IDS = ['lobe-knowledge-base', 'lobe-topic-reference', 'mcp-arckep-wordstat'];

describe('отложенные инструменты: движок → activateTools → история темы → первый шаг', () => {
  const engine = createServerAgentToolsEngine(
    {
      installedPlugins: [
        { identifier: 'mcp-arckep-wordstat', manifest: mcpManifest, type: 'plugin' } as any,
      ],
      isModelSupportToolUse: () => true,
    },
    { agentConfig: { plugins: ['mcp-arckep-wordstat'] }, model: 'gpt-4', provider: 'openai' },
  );

  // то же, что кладёт в карту операции execAgent для отложенных
  const manifestMap = Object.fromEntries(
    LAZY_IDS.map((id) => [id, engine.getPluginManifest(id)]),
  ) as Record<string, LobeToolManifest>;

  it('движок находит манифесты базы знаний, ссылок на темы и MCP-подключения', () => {
    for (const id of LAZY_IDS) {
      expect(manifestMap[id], id).toBeDefined();
      expect(manifestMap[id].identifier).toBe(id);
    }
    expect(manifestMap['mcp-arckep-wordstat']).toMatchObject({
      mcpParams: (mcpManifest as any).mcpParams,
    });
  });

  it('у базы знаний и ссылок на темы есть серверные runtime — вызов после подключения исполняется', () => {
    expect(builtinTools.some((tool) => tool.identifier === 'lobe-knowledge-base')).toBe(true);
    expect(hasServerRuntime('lobe-knowledge-base')).toBe(true);
    expect(hasServerRuntime('lobe-topic-reference')).toBe(true);
  });

  it('activateTools подключает все три, а сообщение с результатом возвращает их в следующую операцию', async () => {
    const runtime = (await activatorRuntime.factory({
      toolManifestMap: manifestMap,
    } as any)) as any;

    const result = await runtime.activateTools({ identifiers: LAZY_IDS });

    expect(result.success).toBe(true);
    expect(result.state.notFound).toEqual([]);
    expect(result.state.activatedTools.map((tool: any) => tool.identifier)).toEqual(LAZY_IDS);

    // сообщение, как его пишет RuntimeExecutors, и набор операции следующего сообщения темы
    const history = [
      { content: 'найди ключи', role: 'user' },
      {
        plugin: { apiName: 'activateTools', identifier: 'lobe-activator' },
        pluginState: result.state,
        role: 'tool',
      },
    ];
    const operationToolSet = {
      enabledToolIds: ['lobe-activator'],
      manifestMap: {
        ...manifestMap,
        'lobe-activator': engine.getPluginManifest('lobe-activator')!,
      },
      sourceMap: {},
      tools: [],
    };
    const seeded = seedActivatedStepToolsFromHistory(history, operationToolSet);
    expect(seeded.map((tool) => tool.id)).toEqual(LAZY_IDS);

    const resolved = new ToolResolver().resolve(
      operationToolSet,
      buildStepToolDelta({
        enabledToolIds: operationToolSet.enabledToolIds,
        operationManifestMap: operationToolSet.manifestMap,
      } as any),
      seeded,
    );

    // функции всех трёх уже в первом шаге; источник такой же, как после шага activateTools
    const functionNames = resolved.tools.map((tool) => tool.function.name);
    for (const id of LAZY_IDS) {
      expect(
        functionNames.some((name) => name.includes(id)),
        id,
      ).toBe(true);
      expect(resolved.enabledToolIds).toContain(id);
      expect(resolved.sourceMap[id]).toBe('builtin');
    }
    // у MCP-подключения в имени функции остаётся тип: по нему вызов уйдёт в MCP, а не во встроенные
    expect(functionNames.find((name) => name.includes('mcp-arckep-wordstat'))).toContain('mcp');
  });
});
