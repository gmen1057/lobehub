'use client';

import { useEffect } from 'react';

import { useChatStore } from '@/store/chat';

/**
 * arckep: deep link «Править с агентом» (plan user-sites-publishing Phase 7).
 *
 * The site card on arckep.ru opens /chat/?embed=1&site=<slug>. Prefill the
 * chat input with an edit request for that site — the agent then pulls the
 * real published HTML through the arckep-sites builtin tool. Prefill only,
 * never auto-send: the user stays in control of spending a message.
 */
const CONSUMED_KEY = 'arckep-site-deeplink-consumed';
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const useSiteDeepLink = () => {
  const mainInputEditor = useChatStore((s) => s.mainInputEditor);

  useEffect(() => {
    if (!mainInputEditor) return;
    const slug = new URLSearchParams(window.location.search).get('site');
    if (!slug || !SLUG_RE.test(slug)) return;
    // One prefill per tab — remounts and topic switches must not re-trigger it.
    if (sessionStorage.getItem(CONSUMED_KEY) === slug) return;
    sessionStorage.setItem(CONSUMED_KEY, slug);

    mainInputEditor.instance?.setDocument(
      'markdown',
      `Открой мой сайт ${slug}.jhunterpro.ru (прочитай его текущую версию навыком «Мои сайты») и помоги его отредактировать. Что нужно поменять, я напишу дальше: `,
    );
    mainInputEditor.focus();
  }, [mainInputEditor]);
};
