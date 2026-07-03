'use client';

import { Flexbox } from '@lobehub/ui';
import { createStaticStyles, cx } from 'antd-style';
import { memo } from 'react';

import type { SiteStyleOption } from '../../types';

const styles = createStaticStyles(({ css, cssVar }) => ({
  card: css`
    cursor: pointer;

    min-width: 180px;
    padding: 10px 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 10px;

    background: ${cssVar.colorBgContainer};

    transition:
      border-color 0.15s,
      background 0.15s;

    &:hover {
      border-color: ${cssVar.colorPrimary};
      background: ${cssVar.colorFillTertiary};
    }
  `,
  cardStatic: css`
    cursor: default;

    &:hover {
      border-color: ${cssVar.colorBorderSecondary};
      background: ${cssVar.colorBgContainer};
    }
  `,
  dot: css`
    width: 14px;
    height: 14px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 50%;
  `,
  name: css`
    font-size: 13px;
    font-weight: 600;
    color: ${cssVar.colorText};
  `,
  pick: css`
    font-size: 12px;
    color: ${cssVar.colorPrimary};
  `,
  tagline: css`
    font-size: 12px;
    line-height: 1.4;
    color: ${cssVar.colorTextSecondary};
  `,
}));

interface StyleCardProps {
  onPick?: (style: SiteStyleOption) => void;
  pickLabel?: string;
  style: SiteStyleOption;
}

/**
 * One design style as a compact card: emoji + name, live palette swatches,
 * tagline. Clicking prefills the chat input (never auto-sends — spending a
 * message stays the user's explicit action, same invariant as deep-links).
 */
const StyleCard = memo<StyleCardProps>(({ style, onPick, pickLabel }) => {
  const clickable = Boolean(onPick);
  return (
    <Flexbox
      className={cx(styles.card, !clickable && styles.cardStatic)}
      gap={6}
      onClick={onPick ? () => onPick(style) : undefined}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
    >
      <Flexbox align={'center'} gap={8} horizontal>
        <span className={styles.name}>
          {style.emoji} {style.name}
        </span>
        <Flexbox gap={4} horizontal>
          {(style.palette || []).slice(0, 5).map((hex) => (
            <span className={styles.dot} key={hex} style={{ background: hex }} title={hex} />
          ))}
        </Flexbox>
      </Flexbox>
      <span className={styles.tagline}>{style.tagline}</span>
      {clickable && <span className={styles.pick}>{pickLabel || 'Выбрать этот стиль →'}</span>}
    </Flexbox>
  );
});

StyleCard.displayName = 'ArckepSiteStyleCard';

export default StyleCard;
