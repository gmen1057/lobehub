'use client';

import { Avatar, Flexbox, Markdown, Text } from '@lobehub/ui';
import { cssVar } from 'antd-style';
import isEqual from 'fast-deep-equal';
import React, { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { DEFAULT_AVATAR, DEFAULT_INBOX_AVATAR } from '@/const/meta';
import {
  AlsoCan,
  ARCKEP_EMPTY_INTRO,
  CapabilityCubes,
  cubesForAgent,
} from '@/features/ArckepCapabilities';
import { useConversationStore } from '@/features/Conversation';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useAgentStore } from '@/store/agent';
import { agentSelectors, builtinAgentSelectors } from '@/store/agent/selectors';
import { useUserStore } from '@/store/user';
import { userGeneralSettingsSelectors } from '@/store/user/selectors';

import OpeningQuestions from './OpeningQuestions';
import ToolAuthAlert from './ToolAuthAlert';

const InboxWelcome = memo(() => {
  const { t } = useTranslation(['welcome', 'chat']);
  const mobile = useIsMobile();
  const isInbox = useAgentStore(builtinAgentSelectors.isInboxAgent);
  const openingQuestions = useAgentStore(agentSelectors.openingQuestions, isEqual);
  const fontSize = useUserStore(userGeneralSettingsSelectors.fontSize);
  const meta = useAgentStore(agentSelectors.currentAgentMeta, isEqual);
  const openingMessage = useAgentStore(agentSelectors.openingMessage);
  const sendMessage = useConversationStore((s) => s.sendMessage);
  const cubes = useMemo(() => cubesForAgent(meta.marketIdentifier), [meta.marketIdentifier]);

  const message = openingMessage || ARCKEP_EMPTY_INTRO;

  const inboxTitle = meta.title || 'Lobe AI';
  const displayTitle = isInbox ? inboxTitle : meta.title || t('defaultSession', { ns: 'common' });

  return (
    <>
      <Flexbox flex={1} />
      <Flexbox
        gap={12}
        width={'100%'}
        style={{
          paddingBottom: 'max(10vh, 32px)',
        }}
      >
        <Avatar
          avatar={isInbox ? meta.avatar || DEFAULT_INBOX_AVATAR : meta.avatar || DEFAULT_AVATAR}
          background={meta.backgroundColor}
          shape={'square'}
          size={78}
        />
        <Text fontSize={32} weight={'bold'}>
          {displayTitle}
        </Text>
        <Flexbox gap={16} width={'min(100%, 640px)'}>
          <Markdown fontSize={fontSize} variant={'chat'}>
            {message}
          </Markdown>
          {openingQuestions.length > 0 && (
            <OpeningQuestions mobile={mobile} questions={openingQuestions} />
          )}
          {cubes.length > 0 && (
            <Flexbox gap={8}>
              <Text color={cssVar.colorTextDescription} fontSize={12}>
                Что умею
              </Text>
              <CapabilityCubes
                cubes={cubes}
                onSelect={(prompt) => {
                  void sendMessage({ message: prompt });
                }}
              />
            </Flexbox>
          )}
          <AlsoCan />
        </Flexbox>
        <ToolAuthAlert />
      </Flexbox>
    </>
  );
});

export default InboxWelcome;
