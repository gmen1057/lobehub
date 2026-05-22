'use client';

import { ActionIcon, Flexbox } from '@lobehub/ui';
import { ArrowLeftIcon } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import SideBarHeaderLayout from '@/features/NavPanel/SideBarHeaderLayout';

import AddButton from './components/AddButton';
import InboxButton from './components/InboxButton';
import Nav from './components/Nav';
import User from './components/User';

const Header = memo(() => {
  const { t } = useTranslation('common');

  return (
    <>
      <SideBarHeaderLayout
        showBack={false}
        left={
          <Flexbox horizontal align="center" gap={8}>
            <ActionIcon
              icon={ArrowLeftIcon}
              title="Вернуться в студию"
              style={{
                borderRadius: '8px',
                border: '1px solid var(--color-border)',
              }}
              onClick={() => {
                if (typeof window !== 'undefined') {
                  window.open('https://arckep.ru/studio', '_top');
                }
              }}
            />
            <User />
          </Flexbox>
        }
        right={
          <>
            <InboxButton />
            <AddButton />
          </>
        }
      />
      <Nav />
    </>
  );
});

export default Header;
