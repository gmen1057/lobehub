'use client';

import type { BuiltinRenderProps } from '@lobechat/types';
import { Flexbox } from '@lobehub/ui';
import { createStaticStyles } from 'antd-style';
import { memo } from 'react';

import type { ListStylesParams, ListStylesResult, SiteStyleOption } from '../../types';
import StyleCard from './StyleCard';
import { usePickStyle } from './usePickStyle';

const styles = createStaticStyles(({ css }) => ({
  grid: css`
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 8px;
    width: 100%;
  `,
}));

/**
 * listStyles result: the full 18-style catalog as an interactive gallery.
 * Picking a card prefills a build request with that style_id.
 */
const ListStylesRender = memo<BuiltinRenderProps<ListStylesParams, ListStylesResult>>(
  ({ pluginState }) => {
    const pick = usePickStyle();
    if (!pluginState?.styles?.length) return null;

    const onPick = (s: SiteStyleOption) =>
      pick(
        `Хочу стиль «${s.name}» (style_id="${s.id}") — используй его для лендинга: получи бриф через getDesignBrief и строго следуй ему.`,
      );

    return (
      <div className={styles.grid}>
        {pluginState.styles.map((s) => (
          <StyleCard key={s.id} onPick={onPick} style={s} />
        ))}
      </div>
    );
  },
);

ListStylesRender.displayName = 'ArckepListStylesRender';

export default ListStylesRender;
