import { SkillsIdentifier, SkillsManifestHeadless } from '@lobechat/builtin-tool-skills';
import type { BuiltinServerRuntimeOutput } from '@lobechat/types';

/**
 * arckep (19.10.2026): инструменты навыков (`lobe-skills`: readReference, runCommand, execScript, exportFile)
 * в движке без интерфейса не лежат в постоянной части запроса. `activateSkill` подключает их сам, когда у
 * включённого навыка есть справочники или скрипты: ответ несёт `state.activatedTools` (той же формы, что у
 * `activateTools`), и серверный исполнитель кладёт их в `activatedStepTools` — они остаются подключёнными
 * до конца операции, а в следующих сообщениях темы восстанавливаются из истории.
 */
export const withSkillTools = (result: BuiltinServerRuntimeOutput): BuiltinServerRuntimeOutput => {
  const state = result.state as { hasResources?: boolean; id?: string; name?: string } | undefined;

  if (!result.success || !state?.hasResources) return result;

  const names = SkillsManifestHeadless.api.map((api) => api.name).join(', ');

  return {
    ...result,
    content: `${result.content}\n\n[Skill tools connected: ${names} (${SkillsIdentifier}) are now available as function calls, their instructions are in your system context. Use "${state.name}" as the skill name.]`,
    state: {
      ...state,
      activatedTools: [
        {
          apiCount: SkillsManifestHeadless.api.length,
          avatar: SkillsManifestHeadless.meta?.avatar,
          identifier: SkillsIdentifier,
          name: SkillsManifestHeadless.meta?.title ?? SkillsIdentifier,
        },
      ],
    },
  };
};
