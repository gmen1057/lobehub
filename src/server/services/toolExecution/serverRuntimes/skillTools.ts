import {
  ArckepLayoutIdentifier,
  ArckepLayoutManifest,
} from '@lobechat/builtin-tool-arckep-layout';
import { SkillsIdentifier, SkillsManifestHeadless } from '@lobechat/builtin-tool-skills';
import type { LobeToolManifest } from '@lobechat/context-engine';
import type { BuiltinServerRuntimeOutput } from '@lobechat/types';

import { isLayoutCheckEnabled } from '@/server/services/arckepLayout/enable';

/**
 * arckep (19.10.2026): инструменты навыков (`lobe-skills`: readReference, runCommand, execScript, exportFile)
 * в движке без интерфейса не лежат в постоянной части запроса. `activateSkill` подключает их сам, когда у
 * включённого навыка есть справочники или скрипты: ответ несёт `state.activatedTools` (той же формы, что у
 * `activateTools`), и серверный исполнитель кладёт их в `activatedStepTools` — они остаются подключёнными
 * до конца операции, а в следующих сообщениях темы восстанавливаются из истории.
 *
 * Для навыка `Artifacts` (`lobe-artifacts`) аналогично подключается `arckep-layout` (`writeArtifact`,
 * `editArtifact`, `checkLayout`), если его манифест лежит в `toolManifestMap` операции.
 */
export const withSkillTools = (
  result: BuiltinServerRuntimeOutput,
  toolManifestMap?: Record<string, LobeToolManifest>,
): BuiltinServerRuntimeOutput => {
  const state = result.state as
    | { hasResources?: boolean; id?: string; identifier?: string; name?: string }
    | undefined;

  if (!result.success || !state) return result;

  if (
    (state.identifier === 'lobe-artifacts' || state.name === 'Artifacts') &&
    isLayoutCheckEnabled() &&
    toolManifestMap?.[ArckepLayoutIdentifier]
  ) {
    const manifest = toolManifestMap[ArckepLayoutIdentifier] ?? ArckepLayoutManifest;
    const names = manifest.api.map((api) => api.name).join(', ');
    return {
      ...result,
      content: `${result.content}\n\n[Artifact tools connected: ${names} (${ArckepLayoutIdentifier}) are now available as function calls. Use writeArtifact({ identifier, title, content }) to syntax-check and save new text/html artifacts before showing their <lobeArtifact … src="…"> tag, and editArtifact for subsequent edits.]`,
      state: {
        ...state,
        activatedTools: [
          {
            apiCount: manifest.api.length,
            avatar: manifest.meta?.avatar,
            identifier: ArckepLayoutIdentifier,
            name: manifest.meta?.title ?? ArckepLayoutIdentifier,
          },
        ],
      },
    };
  }

  if (!state.hasResources) return result;

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
