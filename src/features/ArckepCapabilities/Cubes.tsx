'use client';

import { Block, Flexbox, Text } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo } from 'react';

import { type CapabilityCube } from './catalog';

const styles = createStaticStyles(({ css, cssVar }) => ({
  card: css`
    cursor: pointer;
    height: 100%;
    border-radius: ${cssVar.borderRadiusLG};
  `,
  grid: css`
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
    width: 100%;
  `,
}));

export interface CapabilityCubesProps {
  cubes: CapabilityCube[];
  onSelect: (prompt: string) => void;
}

const CapabilityCubes = memo<CapabilityCubesProps>(({ cubes, onSelect }) => {
  if (cubes.length === 0) return null;

  return (
    <div className={styles.grid}>
      {cubes.map((cube) => (
        <Block
          clickable
          className={styles.card}
          key={cube.id}
          variant={'outlined'}
          onClick={() => onSelect(cube.prompt)}
        >
          <Flexbox gap={4} paddingBlock={12} paddingInline={14}>
            <Text fontSize={14} style={{ fontWeight: 500 }}>
              {cube.title}
            </Text>
            <Text color={cssVar.colorTextTertiary} ellipsis={{ rows: 2 }} fontSize={12}>
              {cube.description}
            </Text>
          </Flexbox>
        </Block>
      ))}
    </div>
  );
});

CapabilityCubes.displayName = 'CapabilityCubes';

export default CapabilityCubes;
