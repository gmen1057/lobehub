'use client';

import { Block, Flexbox, Text } from '@lobehub/ui';
import { cssVar } from 'antd-style';
import { memo } from 'react';

import { ARCKEP_ALSO_CAN } from './catalog';

const AlsoCan = memo(() => {
  return (
    <Flexbox gap={8} width={'100%'}>
      <Text color={cssVar.colorTextDescription} fontSize={12}>
        Ещё умеет
      </Text>
      <Flexbox horizontal gap={8} wrap={'wrap'}>
        {ARCKEP_ALSO_CAN.map((item) => (
          <Block
            key={item}
            paddingBlock={6}
            paddingInline={10}
            style={{ borderRadius: 48 }}
            variant={'filled'}
          >
            <Text color={cssVar.colorTextSecondary} fontSize={12}>
              {item}
            </Text>
          </Block>
        ))}
      </Flexbox>
    </Flexbox>
  );
});

AlsoCan.displayName = 'AlsoCan';

export default AlsoCan;
