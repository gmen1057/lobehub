import { builtinSkills } from '@lobechat/builtin-skills';
import { LobeActivatorIdentifier } from '@lobechat/builtin-tool-activator';
import {
  ActivatorExecutionRuntime,
  type ActivatorRuntimeService,
  type ToolManifestInfo,
} from '@lobechat/builtin-tool-activator/executionRuntime';
import { SkillsExecutionRuntime } from '@lobechat/builtin-tool-skills/executionRuntime';

import { AgentSkillModel } from '@/database/models/agentSkill';
import { filterBuiltinSkills, filterUserSkills, isHeadlessSkillMode } from '@/helpers/skillFilters';

import { markTopicIfUserMcp } from '../topicTrust';
import { withSkillTools } from './skillTools';
import { type ServerRuntimeRegistration } from './types';

/**
 * Tools Activator Server Runtime
 * Resolves tool manifests from context.toolManifestMap (populated by the agent state).
 */
export const activatorRuntime: ServerRuntimeRegistration = {
  factory: async (context) => {
    const activatedIds: string[] = [];

    // Create SkillsExecutionRuntime for activateSkill delegation
    let skillsRuntime: SkillsExecutionRuntime | undefined;
    if (context.serverDB && context.userId) {
      const skillModel = new AgentSkillModel(context.serverDB, context.userId);
      skillsRuntime = new SkillsExecutionRuntime({
        builtinSkills: filterBuiltinSkills(builtinSkills),
        service: {
          findAll: async () => {
            const res = await skillModel.findAll();
            const data = filterUserSkills(res.data);
            return { data, total: data.length };
          },
          findById: (id) => skillModel.findById(id),
          findByName: (name) => skillModel.findByName(name),
          readResource: async () => {
            throw new Error('readResource not available in tools runtime');
          },
        },
      });
    }

    const service: ActivatorRuntimeService = {
      // arckep (19.10.2026): в движке без интерфейса навык со справочниками или скриптами подключает и
      // инструменты навыков (readReference, runCommand, execScript, exportFile) — в постоянной части их нет.
      activateSkill: skillsRuntime
        ? async (args) => {
            const result = await skillsRuntime!.activateSkill(args);
            return isHeadlessSkillMode() ? withSkillTools(result) : result;
          }
        : undefined,
      getActivatedToolIds: () => [...activatedIds],
      getToolManifests: async (identifiers: string[]): Promise<ToolManifestInfo[]> => {
        // Note: context.toolManifestMap should only contain discoverable tools.
        // The caller is responsible for scoping this map to exclude hidden/internal tools.
        const results: ToolManifestInfo[] = [];

        for (const id of identifiers) {
          const manifest = context.toolManifestMap[id];
          if (!manifest) continue;

          results.push({
            apiDescriptions: manifest.api.map((a) => ({
              description: a.description,
              name: a.name,
            })),
            identifier: manifest.identifier,
            name: manifest.meta?.title ?? manifest.identifier,
            systemRole: manifest.systemRole,
          });
        }

        // arckep (19.10.2026, этап 3, п. 3.Д): описания инструментов чужого сервера (`umcp-*`) идут модели
        // с этим ответом — с этого момента платные запуски студии в теме ждут подтверждения человеком.
        await markTopicIfUserMcp(
          context.serverDB,
          context.userId,
          context.topicId,
          results.map((item) => item.identifier),
        );

        return results;
      },
      markActivated: (identifiers: string[]) => {
        for (const id of identifiers) {
          if (!activatedIds.includes(id)) {
            activatedIds.push(id);
          }
        }
      },
    };

    return new ActivatorExecutionRuntime({ service });
  },
  identifier: LobeActivatorIdentifier,
};
