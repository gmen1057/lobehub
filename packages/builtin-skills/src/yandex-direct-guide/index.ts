import type { BuiltinSkill } from '@lobechat/types';

import { toResourceMeta } from '../lobehub/helpers';
import { systemPrompt } from './content';
import structure from './references/structure.md';

export const YandexDirectGuideIdentifier = 'yandex-direct-guide';

export const YandexDirectGuideSkill: BuiltinSkill = {
  avatar: '📢',
  content: systemPrompt,
  description:
    'Как устроен Яндекс Директ и какие РК, ключи и структуру запускать. Без доступа к кабинету — только методика и Wordstat. Включай при вопросах про рекламу, Директ, РСЯ.',
  identifier: YandexDirectGuideIdentifier,
  name: 'Yandex Direct Guide',
  resources: toResourceMeta({
    'references/structure': structure,
  }),
  source: 'builtin',
};
