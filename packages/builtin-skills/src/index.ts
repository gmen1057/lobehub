import type { BuiltinSkill } from '@lobechat/types';

import { AgentBrowserSkill } from './agent-browser';
import { ArtifactsSkill } from './artifacts';
import { ContentArticlesSkill } from './content-articles';
import { LobeHubSkill } from './lobehub';
import { SeoDemandSkill } from './seo-demand';
import { TaskSkill } from './task';
import { YandexDirectGuideSkill } from './yandex-direct-guide';

export { AgentBrowserIdentifier } from './agent-browser';
export { ArtifactsIdentifier } from './artifacts';
export { ContentArticlesIdentifier } from './content-articles';
export { LobeHubIdentifier } from './lobehub';
export { SeoDemandIdentifier } from './seo-demand';
export { TaskIdentifier } from './task';
export { YandexDirectGuideIdentifier } from './yandex-direct-guide';

export const builtinSkills: BuiltinSkill[] = [
  AgentBrowserSkill,
  ArtifactsSkill,
  LobeHubSkill,
  TaskSkill,
  // arckep (19.10.2026): наши SEO-навыки (Wordstat подключается по требованию)
  SeoDemandSkill,
  ContentArticlesSkill,
  YandexDirectGuideSkill,
  // FindSkillsSkill
];
