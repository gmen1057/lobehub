'use client';

import { Flexbox } from '@lobehub/ui';
import { cssVar } from 'antd-style';
import { memo } from 'react';

import NavHeader from '@/features/NavHeader';
import ArckepBalance from '@/features/User/ArckepBalance';

import HeaderActions from './HeaderActions';
import ShareButton from './ShareButton';
import Tags from './Tags';

const Header = memo(() => {
  return (
    <NavHeader
      left={
        <Flexbox style={{ backgroundColor: cssVar.colorBgContainer }}>
          <Tags />
        </Flexbox>
      }
      right={
        <Flexbox
          horizontal
          align={'center'}
          gap={8}
          style={{ backgroundColor: cssVar.colorBgContainer }}
        >
          <ArckepBalance />
          <ShareButton />
          <HeaderActions />
        </Flexbox>
      }
    />
  );
});

export default Header;
