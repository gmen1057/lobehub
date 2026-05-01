import type { OperationSkillSet } from '@lobechat/context-engine';
import { SkillEngine } from '@lobechat/context-engine';

import { isBuiltinSkillAvailableInCurrentEnv } from '@/helpers/toolAvailability';
import { getToolStoreState } from '@/store/tool';

/**
 * Build a client-side OperationSkillSet via SkillEngine.
 *
 * Sources:
 * 1. Builtin skills (e.g., Artifacts) - from toolStore.builtinSkills
 * 2. DB skills (user/market) - from toolStore.agentSkills
 *
 * Uses isBuiltinSkillAvailableInCurrentEnv as the enableChecker to
 * filter platform-specific skills (e.g., agent-browser on desktop only).
 */
export const resolveClientSkills = (pluginIds?: string[]): OperationSkillSet => {
  const toolState = getToolStoreState();

  // arckep: copy `content` from builtin skill — without it, SkillResolver
  // marks the skill as activated but SkillContextProvider injects an
  // undefined string into the system prompt (push(skill.content!) at
  // packages/context-engine/src/providers/SkillContextProvider.ts:80).
  // Server path at src/server/services/aiAgent/index.ts:956 already does
  // this correctly. Without this fix, lobe-artifacts skill never delivers
  // its 205-line prompt and models output raw <svg>/<img data:...> tags.
  const builtinMetas = (toolState.builtinSkills || []).map((s) => ({
    content: s.content,
    description: s.description,
    identifier: s.identifier,
    name: s.name,
  }));

  const dbMetas = (toolState.agentSkills || []).map((s) => ({
    description: s.description ?? '',
    identifier: s.identifier,
    name: s.name,
  }));

  const skillEngine = new SkillEngine({
    enableChecker: (skill) => isBuiltinSkillAvailableInCurrentEnv(skill.identifier),
    skills: [...builtinMetas, ...dbMetas],
  });

  return skillEngine.generate(pluginIds ?? []);
};
