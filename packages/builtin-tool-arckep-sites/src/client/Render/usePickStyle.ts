'use client';

import { useCallback } from 'react';

import { useChatStore } from '@/store/chat';

/**
 * Prefill the chat input with a style-pick phrase and focus it.
 *
 * Same editor plumbing as useSiteDeepLink: write through mainInputEditor's
 * lexical instance. Prefill only, never auto-send — the user explicitly spends
 * the message. Falls back to no-op when the editor isn't mounted (e.g. history
 * view); the card is then informational.
 */
export const usePickStyle = () => {
  const mainInputEditor = useChatStore((s) => s.mainInputEditor);

  return useCallback(
    (text: string) => {
      const instance = mainInputEditor?.instance;
      if (!instance) return;
      instance.setDocument('markdown', text);
      mainInputEditor.focus();
    },
    [mainInputEditor],
  );
};
