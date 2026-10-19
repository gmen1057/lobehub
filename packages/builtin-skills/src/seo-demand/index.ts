import type { BuiltinSkill } from '@lobechat/types';

import { toResourceMeta } from '../lobehub/helpers';
import { systemPrompt } from './content';
import workflow from './references/workflow.md';

export const SeoDemandIdentifier = 'seo-demand';

export const SeoDemandSkill: BuiltinSkill = {
  avatar: '📊',
  content: systemPrompt,
  description:
    'Спрос и семантика через Wordstat: частоты, похожие запросы, сезон, гео. Включай при вопросах про ключи, спрос, «сколько ищут».',
  identifier: SeoDemandIdentifier,
  name: 'SEO Demand',
  resources: toResourceMeta({
    'references/workflow': workflow,
  }),
  source: 'builtin',
};
