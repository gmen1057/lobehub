import type { BuiltinSkill } from '@lobechat/types';

import { toResourceMeta } from '../lobehub/helpers';
import { systemPrompt } from './content';
import { remotionResources } from './resources';

export const RemotionVideoIdentifier = 'remotion-video';

export const RemotionVideoSkill: BuiltinSkill = {
  avatar: '🎬',
  content: systemPrompt,
  description:
    'Анимационные ролики, моушн-графика, титры, инфографика, карты и монтаж в Remotion (React + FFmpeg) с интерактивным плеером и рендером в MP4.',
  identifier: RemotionVideoIdentifier,
  name: 'Remotion Video',
  resources: toResourceMeta(remotionResources),
  source: 'builtin',
};
