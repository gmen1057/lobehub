'use client';

import { Flexbox } from '@lobehub/ui';
import { ChatHeader } from '@lobehub/ui/mobile';
import { memo, useState } from 'react';

import { INBOX_SESSION_ID } from '@/const/session';
import ArckepBalance from '@/features/User/ArckepBalance';
import { useQueryRoute } from '@/hooks/useQueryRoute';
import ShareButton from '@/routes/(main)/agent/features/Conversation/Header/ShareButton';

import ChatHeaderTitle from './ChatHeaderTitle';

const MobileHeader = memo(() => {
  const router = useQueryRoute();
  const [open, setOpen] = useState(false);

  return (
    <ChatHeader
      showBackButton
      center={<ChatHeaderTitle />}
      style={{ width: '100%' }}
      right={
        <Flexbox horizontal align="center" gap={8}>
          <ArckepBalance mobile />
          <ShareButton mobile open={open} setOpen={setOpen} />
        </Flexbox>
      }
      onBackClick={() =>
        router.push('/agent', { query: { session: INBOX_SESSION_ID }, replace: true })
      }
    />
  );
});

export default MobileHeader;
