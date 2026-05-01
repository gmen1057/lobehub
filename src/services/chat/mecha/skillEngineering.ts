import type { OperationSkillSet, SkillMeta } from '@lobechat/context-engine';
import { buildStepSkillDelta, SkillEngine, SkillResolver } from '@lobechat/context-engine';

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

/**
 * arckep: client-side equivalent of the server's RuntimeExecutors skill flow.
 * Builds the OperationSkillSet AND runs SkillResolver, so skills whose
 * identifier appears in `pluginIds` are returned with `activated: true`.
 *
 * Without this, contextEngineering would pass un-activated skills into
 * SkillContextProvider — which only injects content for activated ones —
 * so plugins like `lobe-artifacts` never delivered their system prompt
 * even when enabled on the agent. Server path at
 * src/server/modules/AgentRuntime/RuntimeExecutors.ts:299 was correct;
 * mecha (single-agent client flow) used by chat.arckep.ru wasn't.
 */
export const resolveActivatedClientSkills = (pluginIds?: string[]): SkillMeta[] => {
  const operationSkillSet = resolveClientSkills(pluginIds);
  const resolved = new SkillResolver().resolve(operationSkillSet, buildStepSkillDelta(), []);
  return resolved.enabledSkills;
};
