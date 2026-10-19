export const LobeActivatorIdentifier = 'lobe-activator';

export const ActivatorApiName = {
  activateSkill: 'activateSkill',
  activateTools: 'activateTools',
};

export interface ActivateToolsParams {
  identifiers: string[];
}

export interface ActivatedToolInfo {
  apiCount: number;
  avatar?: string;
  identifier: string;
  name: string;
}

export interface ActivateToolsState {
  activatedTools: ActivatedToolInfo[];
  alreadyActive: string[];
  notFound: string[];
}

export interface ActivateSkillParams {
  name: string;
}

export interface ActivateSkillState {
  /**
   * arckep: инструменты, которые `activateSkill` подключает вместе с навыком (у него есть справочники
   * или скрипты). Той же формы, что `activateTools`: серверный исполнитель добавляет их в
   * `activatedStepTools`, и они остаются подключёнными в пределах темы.
   */
  activatedTools?: ActivatedToolInfo[];
  description?: string;
  hasResources: boolean;
  id: string;
  name: string;
}
