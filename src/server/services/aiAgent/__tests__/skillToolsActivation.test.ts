// @vitest-environment node
import { SkillsIdentifier } from '@lobechat/builtin-tool-skills';
import { buildStepToolDelta, type LobeToolManifest, ToolResolver } from '@lobechat/context-engine';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildToolDiscoveryConfig } from '@/server/modules/AgentRuntime/RuntimeExecutors';
import { createServerAgentToolsEngine } from '@/server/modules/Mecha';
import { seedActivatedStepToolsFromHistory } from '@/server/services/agentRuntime/activatedToolsFromHistory';
import { hasServerRuntime } from '@/server/services/toolExecution/serverRuntimes';
import { activatorRuntime } from '@/server/services/toolExecution/serverRuntimes/activator';

// arckep (19.10.2026): настоящие модули, без подмен. Инструменты навыков (lobe-skills) в движке без
// интерфейса не в постоянной части запроса: манифест лежит в карте операции, в <available_tools> его нет,
// а activateSkill подключает инструменты вместе с навыком, у которого есть справочники или скрипты.

beforeEach(() => {
  vi.stubEnv('ARCKEP_HEADLESS_TOOLS', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const buildEngine = () =>
  createServerAgentToolsEngine(
    { installedPlugins: [], isModelSupportToolUse: () => true },
    { agentConfig: { plugins: [] }, model: 'gpt-4', provider: 'openai' },
  );

const activatorManifest = (engine: ReturnType<typeof buildEngine>) =>
  engine.getPluginManifest('lobe-activator')!;

/** База без навыков человека: select().from().where().limit()/orderBy() отдают пустой список. */
const emptySkillsDb = (() => {
  const query: any = {
    from: () => query,
    limit: async () => [],
    orderBy: async () => [],
    where: () => query,
  };
  return { select: () => query } as any;
})();

const makeRuntime = async (manifestMap: Record<string, LobeToolManifest>) =>
  (await activatorRuntime.factory({
    serverDB: emptySkillsDb,
    toolManifestMap: manifestMap,
    userId: 'user_1',
  } as any)) as any;

describe('инструменты навыков в движке без интерфейса', () => {
  it('манифест — вариант без подтверждения человеком, execScript принимает имя навыка', () => {
    const manifest = buildEngine().getPluginManifest(SkillsIdentifier)!;

    expect(manifest).toBeDefined();
    expect(manifest.api.map((api) => api.name)).toEqual([
      'readReference',
      'runCommand',
      'execScript',
      'exportFile',
    ]);
    expect((manifest as any).humanIntervention).toBeUndefined();
    for (const api of manifest.api)
      expect((api as any).humanIntervention, api.name).toBeUndefined();

    const execScript = manifest.api.find((api) => api.name === 'execScript')!;
    expect(execScript.parameters.required).toEqual(['skill', 'command', 'description']);
    // платная песочница названа в описаниях, чтобы модель не жгла её впустую
    expect(manifest.api.find((api) => api.name === 'runCommand')!.description).toContain(
      '0.2 RUB per minute',
    );
  });

  it('вне движка без интерфейса остаётся апстримный манифест (с подтверждением)', () => {
    vi.stubEnv('ARCKEP_HEADLESS_TOOLS', '');
    const manifest = buildEngine().getPluginManifest(SkillsIdentifier)!;
    const runCommand = manifest.api.find((api) => api.name === 'runCommand')!;
    expect((runCommand as any).humanIntervention).toBe('required');
  });

  it('не включён с первого шага и не перечислен в <available_tools>', () => {
    const engine = buildEngine();
    const result = engine.generateToolsDetailed({
      excludeDefaultToolIds: [SkillsIdentifier],
      model: 'gpt-4',
      provider: 'openai',
      toolIds: [],
    });
    expect(result.enabledToolIds).not.toContain(SkillsIdentifier);
    expect(JSON.stringify(result.tools ?? [])).not.toContain('lobe-skills');

    // карта операции: активатор включён, lobe-skills и ещё один отложенный инструмент — только в карте
    const manifestMap = {
      'lobe-activator': activatorManifest(engine),
      'lobe-knowledge-base': engine.getPluginManifest('lobe-knowledge-base')!,
      [SkillsIdentifier]: engine.getPluginManifest(SkillsIdentifier)!,
    };
    const discovery = buildToolDiscoveryConfig(
      { enabledToolIds: ['lobe-activator'], manifestMap, sourceMap: {}, tools: [] } as any,
      ['lobe-activator'],
    );
    const listed = discovery!.availableTools.map((tool) => tool.identifier);
    expect(listed).toContain('lobe-knowledge-base');
    expect(listed).not.toContain(SkillsIdentifier);
  });

  describe('activateSkill', () => {
    it('навык со справочниками подключает инструменты навыков', async () => {
      const engine = buildEngine();
      const manifestMap = { [SkillsIdentifier]: engine.getPluginManifest(SkillsIdentifier)! };
      const runtime = await makeRuntime(manifestMap);

      const result = await runtime.activateSkill({ name: 'SEO Demand' });

      expect(result.success).toBe(true);
      expect(result.state.hasResources).toBe(true);
      expect(result.state.activatedTools).toEqual([
        { apiCount: 4, avatar: '🛠️', identifier: SkillsIdentifier, name: 'Навыки' },
      ]);
      expect(result.content).toContain('readReference, runCommand, execScript, exportFile');
      expect(result.content).toContain('Use "SEO Demand" as the skill name');
    });

    it('навык без справочников (Artifacts) инструментов не подключает', async () => {
      const runtime = await makeRuntime({});
      const result = await runtime.activateSkill({ name: 'Artifacts' });

      expect(result.success).toBe(true);
      expect(result.state.hasResources).toBe(false);
      expect(result.state.activatedTools).toBeUndefined();
      expect(result.content).not.toContain('Skill tools connected');
    });

    it('LobeHub и Task в движке без интерфейса не активируются', async () => {
      const runtime = await makeRuntime({});
      for (const name of ['LobeHub', 'Task']) {
        const result = await runtime.activateSkill({ name });
        expect(result.success, name).toBe(false);
        expect(result.content).toContain(`Skill not found: "${name}"`);
      }
    });

    it('вне движка без интерфейса инструменты не подключаются', async () => {
      vi.stubEnv('ARCKEP_HEADLESS_TOOLS', '');
      const runtime = await makeRuntime({});
      const result = await runtime.activateSkill({ name: 'SEO Demand' });
      expect(result.success).toBe(true);
      expect(result.state.activatedTools).toBeUndefined();
    });

    it('подключённое активацией даёт функции модели: в этом шаге и в следующем сообщении темы', async () => {
      const engine = buildEngine();
      const manifestMap = {
        'lobe-activator': activatorManifest(engine),
        [SkillsIdentifier]: engine.getPluginManifest(SkillsIdentifier)!,
      };
      const operationToolSet = {
        enabledToolIds: ['lobe-activator'],
        manifestMap,
        sourceMap: {},
        tools: [],
      };
      const runtime = await makeRuntime(manifestMap);
      const result = await runtime.activateSkill({ name: 'Yandex Direct Guide' });

      // как RuntimeExecutors переносит state.activatedTools в activatedStepTools
      const activated = result.state.activatedTools.map((tool: { identifier: string }) => ({
        activatedAtStep: 1,
        id: tool.identifier,
        manifest: manifestMap[tool.identifier as typeof SkillsIdentifier],
        source: 'discovery' as const,
      }));
      const resolve = (activations: typeof activated) =>
        new ToolResolver().resolve(
          operationToolSet,
          buildStepToolDelta({
            enabledToolIds: operationToolSet.enabledToolIds,
            operationManifestMap: manifestMap,
          } as any),
          activations,
        );

      const now = resolve(activated);
      const names = now.tools.map((tool) => tool.function.name);
      for (const api of ['readReference', 'runCommand', 'execScript', 'exportFile']) {
        expect(
          names.some((name) => name.includes(SkillsIdentifier) && name.includes(api)),
          api,
        ).toBe(true);
      }
      expect(now.enabledToolIds).toContain(SkillsIdentifier);
      // инструкция инструментов приходит модели вместе с ними
      expect(now.manifestMap[SkillsIdentifier].systemRole).toContain('sandbox_cost');

      // следующее сообщение темы: из истории восстанавливается то же
      const history = [
        {
          plugin: { apiName: 'activateSkill', identifier: 'lobe-activator' },
          pluginState: result.state,
          role: 'tool',
        },
      ];
      const seeded = seedActivatedStepToolsFromHistory(history, operationToolSet);
      expect(seeded.map((tool) => tool.id)).toEqual([SkillsIdentifier]);
      expect(resolve(seeded as any).tools.length).toBe(now.tools.length);
    });
  });

  describe('«Мои навыки» (arckep-skills): помощник сам сохраняет навык', () => {
    const ID = 'arckep-skills';

    it('есть манифест и серверный runtime; в первом шаге не включён', () => {
      const engine = buildEngine();
      expect(engine.getPluginManifest(ID)?.api.map((api) => api.name)).toEqual([
        'saveSkillFromText',
        'saveSkillFromUrl',
        'saveSkillFromFile',
      ]);
      expect(hasServerRuntime(ID)).toBe(true);

      const result = engine.generateToolsDetailed({
        excludeDefaultToolIds: [ID],
        model: 'gpt-4',
        provider: 'openai',
        toolIds: [],
      });
      expect(result.enabledToolIds).not.toContain(ID);
      expect(JSON.stringify(result.tools ?? [])).not.toContain(ID);
    });

    it('в <available_tools> одной строкой, подключается шагом activateTools', async () => {
      const engine = buildEngine();
      const manifestMap = {
        'lobe-activator': activatorManifest(engine),
        [ID]: engine.getPluginManifest(ID)!,
        [SkillsIdentifier]: engine.getPluginManifest(SkillsIdentifier)!,
      };
      const operationToolSet = {
        enabledToolIds: ['lobe-activator'],
        manifestMap,
        sourceMap: {},
        tools: [],
      };

      const listed = buildToolDiscoveryConfig(operationToolSet as any, [
        'lobe-activator',
      ])!.availableTools;
      expect(listed).toEqual([expect.objectContaining({ identifier: ID, name: 'Мои навыки' })]);
      expect(listed[0].description).toContain('Сохранить навык');

      const runtime = await makeRuntime(manifestMap);
      const result = await runtime.activateTools({ identifiers: [ID] });
      expect(result.success).toBe(true);
      expect(result.state.activatedTools.map((tool: any) => tool.identifier)).toEqual([ID]);

      const resolved = new ToolResolver().resolve(
        operationToolSet as any,
        buildStepToolDelta({
          enabledToolIds: operationToolSet.enabledToolIds,
          operationManifestMap: manifestMap,
        } as any),
        [{ activatedAtStep: 1, id: ID, manifest: manifestMap[ID], source: 'discovery' }],
      );
      const names = resolved.tools.map((tool) => tool.function.name);
      for (const api of ['saveSkillFromText', 'saveSkillFromUrl', 'saveSkillFromFile']) {
        expect(
          names.some((name) => name.includes(ID) && name.includes(api)),
          api,
        ).toBe(true);
      }
    });

    it('подсказка в промпте активатора: сохранение навыка — только по просьбе человека', async () => {
      const { systemPromptHeadless, systemPrompt } =
        await import('@lobechat/builtin-tool-activator');
      expect(systemPromptHeadless).toContain('arckep-skills');
      expect(systemPromptHeadless).toContain('only on their request');
      // браузерный промпт про этот инструмент не знает
      expect(systemPrompt).not.toContain('arckep-skills');
    });
  });

  describe('магазин навыков в движке без интерфейса', () => {
    it('не включается, даже если id записан в плагинах помощника', () => {
      const engine = createServerAgentToolsEngine(
        { installedPlugins: [], isModelSupportToolUse: () => true },
        {
          agentConfig: { plugins: ['lobe-skill-store', 'lobe-skills'] },
          model: 'gpt-4',
          provider: 'openai',
        },
      );
      const result = engine.generateToolsDetailed({
        model: 'gpt-4',
        provider: 'openai',
        toolIds: ['lobe-skill-store', 'lobe-skills'],
      });
      expect(result.enabledToolIds).not.toContain('lobe-skill-store');
      expect(result.enabledToolIds).not.toContain(SkillsIdentifier);
    });

    it('серверный runtime магазина отказывает: импорты идут только через «Мои навыки»', async () => {
      const { skillStoreRuntime } =
        await import('@/server/services/toolExecution/serverRuntimes/skillStore');
      await expect(
        skillStoreRuntime.factory({ serverDB: {} as any, userId: 'u' } as any),
      ).rejects.toThrow('arckep-skills');
    });
  });
});
