import type { BuiltinSkill } from '@lobechat/types';

import { toResourceMeta } from '../lobehub/helpers';
import { systemPrompt } from './content';
import articleBrief from './references/article-brief.md';

export const ContentArticlesIdentifier = 'content-articles';

export const ContentArticlesSkill: BuiltinSkill = {
  avatar: '✍️',
  content: systemPrompt,
  description:
    'Темы статей, title/H1, структура, LSI и ТЗ автору на базе спроса. Включай при запросах «о чём писать», контент-план, SEO-текст.',
  identifier: ContentArticlesIdentifier,
  name: 'Content Articles',
  resources: toResourceMeta({
    'references/article-brief': articleBrief,
  }),
  source: 'builtin',
};
