'use client';

import type { BuiltinRenderProps } from '@lobechat/types';
import { Flexbox } from '@lobehub/ui';
import { createStaticStyles } from 'antd-style';
import { memo } from 'react';

import type { DesignBriefState, GetDesignBriefParams, SiteStyleOption } from '../../types';
import StyleCard from './StyleCard';
import { usePickStyle } from './usePickStyle';

const styles = createStaticStyles(({ css, cssVar }) => ({
  label: css`
    font-size: 12px;
    font-weight: 500;
    color: ${cssVar.colorTextTertiary};
  `,
  row: css`
    flex-wrap: wrap;
  `,
}));

/**
 * getDesignBrief result: the chosen style as a card plus clickable
 * alternatives. Picking one prefills a rebuild request — the agent re-runs
 * getDesignBrief with that style_id and rebuilds the landing.
 */
const GetDesignBriefRender = memo<BuiltinRenderProps<GetDesignBriefParams, DesignBriefState>>(
  ({ pluginState }) => {
    const pick = usePickStyle();
    if (!pluginState?.style_id) return null;

    const chosen: SiteStyleOption = {
      emoji: pluginState.emoji,
      id: pluginState.style_id,
      name: pluginState.name,
      palette: pluginState.palette || [],
      tagline: pluginState.tagline,
    };

    const onPick = (s: SiteStyleOption) =>
      pick(
        `Пересобери лендинг в стиле «${s.name}» (style_id="${s.id}") — получи новый бриф через getDesignBrief и строго следуй ему.`,
      );

    return (
      <Flexbox gap={10}>
        <span className={styles.label}>Стиль лендинга</span>
        <StyleCard style={chosen} />
        {pluginState.alternatives?.length > 0 && (
          <>
            <span className={styles.label}>Хотите иначе? Клик — и агент пересоберёт</span>
            <Flexbox className={styles.row} gap={8} horizontal>
              {pluginState.alternatives.map((s) => (
                <StyleCard key={s.id} onPick={onPick} pickLabel={'Пересобрать в этом →'} style={s} />
              ))}
            </Flexbox>
          </>
        )}
      </Flexbox>
    );
  },
);

GetDesignBriefRender.displayName = 'ArckepGetDesignBriefRender';

export default GetDesignBriefRender;
