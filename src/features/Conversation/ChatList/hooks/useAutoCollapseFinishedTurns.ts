import { useEffect, useRef } from 'react';

import { dataSelectors, useConversationStore } from '../../store';

const FOLDABLE_ROLES = new Set(['assistant', 'assistantGroup']);

/**
 * When a new assistant turn starts, fold the previous one so a long agent
 * run stays readable. Manual expand still works; topic switch resets.
 */
export const useAutoCollapseFinishedTurns = () => {
  const topicId = useConversationStore((s) => s.context.topicId);
  const topicShareId = useConversationStore((s) => s.context.topicShareId);
  const displayMessages = useConversationStore(dataSelectors.displayMessages);
  const toggleMessageCollapsed = useConversationStore((s) => s.toggleMessageCollapsed);
  const latestIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    latestIdRef.current = undefined;
  }, [topicId]);

  useEffect(() => {
    const assistantIds = displayMessages
      .filter((message) => FOLDABLE_ROLES.has(message.role))
      .map((message) => message.id);
    const latestId = assistantIds.at(-1);
    if (!latestId || topicShareId) return;

    const previousId = latestIdRef.current;
    if (previousId === latestId) return;
    latestIdRef.current = latestId;

    if (previousId && assistantIds.includes(previousId)) {
      void toggleMessageCollapsed(previousId, true);
    }
  }, [displayMessages, toggleMessageCollapsed, topicShareId]);
};
