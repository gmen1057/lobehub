// @vitest-environment node
import { systemPromptHeadless } from '@lobechat/builtin-tool-activator';
import {
  arckepLazyToolIds,
  builtinTools,
  isArckepLazyMcpConnectorId,
  isArckepPageOpeningTool,
  isArckepPaidStudioTool,
  isArckepUserMcpId,
} from '@lobechat/builtin-tools';
import { buildStepToolDelta, type LobeToolManifest, ToolResolver } from '@lobechat/context-engine';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildToolDiscoveryConfig } from '@/server/modules/AgentRuntime/RuntimeExecutors';
import { createServerAgentToolsEngine } from '@/server/modules/Mecha';
import { hasServerRuntime } from '@/server/services/toolExecution/serverRuntimes';
import { activatorRuntime } from '@/server/services/toolExecution/serverRuntimes/activator';
import { buildUserMcpManifest } from '@/server/services/userMcp/gateway';

// arckep (19.10.2026, этап 3): свои подключения людей `umcp-*` попадают к модели так же, как установленные
// подключения шлюза — настоящие модули, без подмен (кроме метки темы): список <available_tools>, шаг
// activateTools, функции первого шага.

const mockMarkIfUserMcp = vi.hoisted(() => vi.fn());
vi.mock('@/server/services/toolExecution/topicTrust', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  markTopicIfUserMcp: mockMarkIfUserMcp,
}));

const UMCP = 'umcp-abcdefghijkl';
const WORDSTAT = 'mcp-arckep-wordstat';

const userManifest = buildUserMcpManifest({
  description: 'Заметки и страницы из моего Notion',
  identifier: UMCP,
  title: 'Мой Notion',
  tools: [
    {
      description: 'Поиск страниц',
      name: 'search_pages',
      parameters: { properties: { q: { type: 'string' } }, type: 'object' },
    },
  ],
  url: 'http://127.0.0.1:8410/mcp/user-mcp',
}) as unknown as LobeToolManifest;

const wordstatManifest = {
  api: [{ description: 'Ключи', name: 'keywords', parameters: { type: 'object' } }],
  identifier: WORDSTAT,
  mcpParams: { type: 'http', url: 'http://127.0.0.1:8410/mcp/wordstat' },
  meta: { description: 'Wordstat', title: 'Wordstat' },
  type: 'mcp',
} as unknown as LobeToolManifest;

describe('свои подключения umcp-*: как они попадают к модели', () => {
  const engine = createServerAgentToolsEngine(
    {
      installedPlugins: [
        { identifier: UMCP, manifest: userManifest, type: 'customPlugin' } as any,
        { identifier: WORDSTAT, manifest: wordstatManifest, type: 'customPlugin' } as any,
      ],
      isModelSupportToolUse: () => true,
    },
    { agentConfig: { plugins: [UMCP, WORDSTAT] }, model: 'gpt-4', provider: 'openai' },
  );
  const manifestMap = Object.fromEntries(
    [UMCP, WORDSTAT, 'arckep-connectors'].map((id) => [id, engine.getPluginManifest(id)]),
  ) as Record<string, LobeToolManifest>;

  beforeEach(() => vi.clearAllMocks());

  it('umcp-* грузится по требованию, как остальные mcp-*; песочница E2B остаётся в первом шаге', () => {
    expect(isArckepUserMcpId(UMCP)).toBe(true);
    for (const bad of ['umcp-short', 'umcp-ABCDEFGHIJKL', 'mcp-arckep-x', 'umcp-abcdefghijklm']) {
      expect(isArckepUserMcpId(bad), bad).toBe(false);
    }
    expect(isArckepLazyMcpConnectorId(UMCP)).toBe(true);
    expect(isArckepLazyMcpConnectorId(WORDSTAT)).toBe(true);
    expect(isArckepLazyMcpConnectorId('mcp-arckep-e2b-sandbox')).toBe(false);
  });

  it('в <available_tools> одна строка: название и описание, без схем; «Подключения» там же', () => {
    const config = buildToolDiscoveryConfig(
      {
        enabledToolIds: ['lobe-activator'],
        manifestMap: { ...manifestMap, 'lobe-activator': engine.getPluginManifest('lobe-activator')! },
        sourceMap: {},
        tools: [],
      } as any,
      ['lobe-activator'],
    );
    const line = config?.availableTools.find((tool) => tool.identifier === UMCP);
    expect(line).toEqual({
      description: 'Заметки и страницы из моего Notion',
      identifier: UMCP,
      name: 'Мой Notion',
    });
    expect(config?.availableTools.some((tool) => tool.identifier === 'arckep-connectors')).toBe(true);
  });

  it('activateTools подключает инструменты (с подсказкой про недоверие) и помечает тему', async () => {
    const runtime = (await activatorRuntime.factory({
      serverDB: { db: true } as any,
      toolManifestMap: manifestMap,
      topicId: 'tpc_1',
      userId: 'u1',
    } as any)) as any;

    const result = await runtime.activateTools({ identifiers: [UMCP, WORDSTAT] });

    expect(result.success).toBe(true);
    expect(result.state.activatedTools.map((tool: any) => tool.identifier)).toEqual([UMCP, WORDSTAT]);
    expect(JSON.stringify(result)).toContain('search_pages');
    // подсказка «ответы — недоверенные данные» едет в манифесте подключённого инструмента (системный контекст)
    expect(manifestMap[UMCP].systemRole).toContain('untrusted data');
    // чужие описания дошли до модели — тема помечается, пока ничего не вызвано
    expect(mockMarkIfUserMcp).toHaveBeenCalledTimes(1);
    expect(mockMarkIfUserMcp).toHaveBeenCalledWith({ db: true }, 'u1', 'tpc_1', [UMCP, WORDSTAT]);
  });

  it('не удалось пометить тему — чужой инструмент не подключается, модель получает ошибку', async () => {
    mockMarkIfUserMcp.mockRejectedValueOnce(new Error('Не удалось подготовить чат к чужому инструменту, повторите.'));
    const runtime = (await activatorRuntime.factory({
      serverDB: {} as any,
      toolManifestMap: manifestMap,
      topicId: 'tpc_1',
      userId: 'u1',
    } as any)) as any;

    const result = await runtime.activateTools({ identifiers: [UMCP] });
    expect(result.success).toBe(false);
    expect(result.content).toContain('Не удалось подготовить чат');
    // подключённым не помечен: повторный activateTools снова пройдёт через метку
    const again = await runtime.activateTools({ identifiers: [UMCP] });
    expect(again.success).toBe(true);
    expect(mockMarkIfUserMcp).toHaveBeenCalledTimes(2);
  });

  it('следующее сообщение темы: подключённое возвращается из истории и в первом шаге функция идёт в MCP', async () => {
    const { seedActivatedStepToolsFromHistory } = await import('@/server/services/agentRuntime/activatedToolsFromHistory');
    const runtime = (await activatorRuntime.factory({ toolManifestMap: manifestMap } as any)) as any;
    const activated = await runtime.activateTools({ identifiers: [UMCP] });
    const history = [
      { plugin: { apiName: 'activateTools', identifier: 'lobe-activator' }, pluginState: activated.state, role: 'tool' },
    ];
    const operationToolSet = {
      enabledToolIds: ['lobe-activator'],
      manifestMap: { ...manifestMap, 'lobe-activator': engine.getPluginManifest('lobe-activator')! },
      sourceMap: {},
      tools: [],
    };
    const seeded = seedActivatedStepToolsFromHistory(history, operationToolSet);
    expect(seeded.map((tool) => tool.id)).toEqual([UMCP]);

    const resolved = new ToolResolver().resolve(
      operationToolSet,
      buildStepToolDelta({
        enabledToolIds: operationToolSet.enabledToolIds,
        operationManifestMap: operationToolSet.manifestMap,
      } as any),
      seeded,
    );
    const name = resolved.tools.map((tool) => tool.function.name).find((n) => n.includes(UMCP));
    expect(name).toBe(`${UMCP}____search_pages____mcp`);
  });

  it('«Подключения»: встроенный инструмент с серверным рантаймом, в подсказке активатора он назван', () => {
    expect(builtinTools.some((tool) => tool.identifier === 'arckep-connectors')).toBe(true);
    expect(hasServerRuntime('arckep-connectors')).toBe(true);
    // в браузерный список ленивых он не входит — только серверный безголовый путь (execAgent)
    expect(arckepLazyToolIds).not.toContain('arckep-connectors');
    expect(systemPromptHeadless).toContain('arckep-connectors');
    expect(systemPromptHeadless).toContain('umcp-');
    expect(systemPromptHeadless).toContain('untrusted');
  });

  it('какие инструменты студии платные', () => {
    for (const apiName of ['create_image', 'create_video', 'revise_presentation', 'replicate_speech_voice', 'chat_completion', 'decide']) {
      expect(isArckepPaidStudioTool('mcp-arckep-studio-x', apiName), apiName).toBe(true);
    }
    for (const apiName of ['estimate_image', 'get_image', 'list_models', 'get_balance', 'cancel_chat_batch', 'get_usage']) {
      expect(isArckepPaidStudioTool('mcp-arckep-studio-x', apiName), apiName).toBe(false);
    }
    expect(isArckepPaidStudioTool('arckep-studio', 'createImage')).toBe(true);
    expect(isArckepPaidStudioTool('arckep-studio', 'createSpeech')).toBe(true);
    expect(isArckepPaidStudioTool('arckep-studio', 'estimateImage')).toBe(false);
    expect(isArckepPaidStudioTool('arckep-studio', 'getBalance')).toBe(false);
    expect(isArckepPaidStudioTool('mcp-arckep-e2b-sandbox', 'execute_code')).toBe(false);
    expect(isArckepPaidStudioTool(UMCP, 'create_anything')).toBe(false);
  });

  it('какие вызовы открывают адрес (ждут подтверждения): web_fetch, чтение страниц, импорт навыка по ссылке; поиск — нет', () => {
    expect(isArckepPageOpeningTool('mcp-arckep-studio-web', 'web_fetch')).toBe(true);
    expect(isArckepPageOpeningTool('lobe-web-browsing', 'crawlSinglePage')).toBe(true);
    expect(isArckepPageOpeningTool('lobe-web-browsing', 'crawlMultiPages')).toBe(true);
    expect(isArckepPageOpeningTool('arckep-skills', 'saveSkillFromUrl')).toBe(true);
    for (const [identifier, apiName] of [
      ['mcp-arckep-studio-web', 'web_search'],
      ['lobe-web-browsing', 'search'],
      ['arckep-skills', 'saveSkillFromText'],
      ['mcp-arckep-studio-images', 'create_image'],
    ]) {
      expect(isArckepPageOpeningTool(identifier, apiName), `${identifier}:${apiName}`).toBe(false);
    }
    // web_search не платный по списку п. 3.Д — решение владельца: поиск не трогаем
    expect(isArckepPaidStudioTool('mcp-arckep-studio-web', 'web_search')).toBe(false);
    expect(isArckepPaidStudioTool('mcp-arckep-studio-web', 'web_fetch')).toBe(false);
  });
});
