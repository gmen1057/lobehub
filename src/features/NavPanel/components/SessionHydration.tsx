'use client';

import { BUILTIN_AGENT_SLUGS } from '@lobechat/builtin-agents';
import { memo, useEffect } from 'react';
import { createStoreUpdater } from 'zustand-utils';

import { parseAsString, useQueryParam } from '@/hooks/useQueryParam';
import { useChatStore } from '@/store/chat';
import { useSessionStore } from '@/store/session';

const THROTTLE_DELAY = 50;
const BOT_CONFIGURATOR_SESSION_KEY = 'arckep:bot-configurator:botId';

// sync outside state to useSessionStore
const SessionHydration = memo(() => {
  const useStoreUpdater = createStoreUpdater(useSessionStore);
  const useChatStoreUpdater = createStoreUpdater(useChatStore);
  const [switchTopic] = useChatStore((s) => [s.switchTopic]);

  // two-way bindings the url and session store
  const [session, setSession] = useQueryParam('session', parseAsString.withDefault('inbox'), {
    history: 'replace',
    throttleMs: THROTTLE_DELAY,
  });

  // Read ?bot=<id> for deep-link to bot-configurator
  const [botId] = useQueryParam('bot', parseAsString);

  useStoreUpdater('activeId', session);
  useChatStoreUpdater('activeAgentId', session);

  // When ?bot=<id> is present, switch to bot-configurator and store botId
  useEffect(() => {
    if (botId) {
      // Store botId for resolveAgentConfig to pick up
      sessionStorage.setItem(BOT_CONFIGURATOR_SESSION_KEY, botId);
      // Switch active session to bot-configurator
      setSession(BUILTIN_AGENT_SLUGS.botConfigurator);
    }
  }, [botId]);

  useEffect(() => {
    const unsubscribe = useSessionStore.subscribe(
      (s) => s.activeId,
      (state) => {
        switchTopic();
        setSession(state);
      },
    );

    return () => {
      unsubscribe();
    };
  }, []);

  return null;
});

export default SessionHydration;
