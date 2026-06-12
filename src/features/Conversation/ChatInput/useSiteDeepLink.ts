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
 *
 * The slug comes from sessionStorage, NOT window.location: the SPA router's
 * catch-all rewrites /chat/?site=X to / (query dropped) before this hook
 * runs. src/initialize.ts captures the param at boot, before the router.
 *
 * Insertion is retried: mainInputEditor lands in the store before its inner
 * lexical `instance` is ready, and late editor init can wipe an early
 * setDocument. CONSUMED is only marked after a write actually happened, and
 * one re-assert fires if the input is empty again shortly after.
 */
const DEEPLINK_KEY = 'arckep-site-deeplink';
const CONSUMED_KEY = 'arckep-site-deeplink-consumed';
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const useSiteDeepLink = () => {
  const mainInputEditor = useChatStore((s) => s.mainInputEditor);

  useEffect(() => {
    if (!mainInputEditor) return;
    const slug =
      sessionStorage.getItem(DEEPLINK_KEY) ||
      new URLSearchParams(window.location.search).get('site');
    if (!slug || !SLUG_RE.test(slug)) return;
    // One prefill per tab — remounts and topic switches must not re-trigger it.
    if (sessionStorage.getItem(CONSUMED_KEY) === slug) return;

    const text = `Открой мой сайт ${slug}.jhunterpro.ru (прочитай его текущую версию навыком «Мои сайты») и помоги его отредактировать. Что нужно поменять, я напишу дальше: `;

    const write = () => {
      const instance = mainInputEditor.instance;
      if (!instance) return false;
      instance.setDocument('markdown', text);
      mainInputEditor.focus();
      return true;
    };

    let attempts = 0;
    let reassert: ReturnType<typeof setTimeout> | undefined;
    const timer = setInterval(() => {
      attempts += 1;
      if (write()) {
        sessionStorage.setItem(CONSUMED_KEY, slug);
        clearInterval(timer);
        // Late editor init may reset the document — re-assert once if the
        // input went empty again (inputMessage mirrors editor content).
        reassert = setTimeout(() => {
          if (!useChatStore.getState().inputMessage) write();
        }, 800);
      } else if (attempts >= 25) {
        clearInterval(timer);
      }
    }, 200);

    return () => {
      clearInterval(timer);
      if (reassert) clearTimeout(reassert);
    };
  }, [mainInputEditor]);
};
