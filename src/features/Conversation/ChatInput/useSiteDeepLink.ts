'use client';

import { useEffect } from 'react';

import { useChatStore } from '@/store/chat';

/**
 * arckep: deep links that prefill the chat input. Two modes:
 *   ?site=<slug>    — «Править с агентом»: edit an existing published site;
 *                     the agent pulls the live HTML via the arckep-sites tool.
 *   ?create=<tplId> — «Собрать сайт»: start a NEW site from a template prompt
 *                     (CREATE_PROMPTS below). Powers the tiles on /sites.
 * Prefill only, never auto-send: the user stays in control of spending a message.
 *
 * The param comes from sessionStorage, NOT window.location: the SPA router's
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

// «Собрать сайт» mode: /chat/?create=<templateId> opens the chat with a ready
// starter prompt for that kind of site. Prompts live here (short id travels in
// the URL); unknown ids are ignored. Prefill only — the user finishes the brief.
const CREATE_KEY = 'arckep-create-deeplink';
const CREATE_CONSUMED_KEY = 'arckep-create-deeplink-consumed';
const CREATE_RE = /^[a-z]{1,20}$/;
const CREATE_PROMPTS: Record<string, string> = {
  service:
    'Собери одностраничный лендинг для моей услуги или бизнеса. Сделай структуру: первый экран с заголовком и кнопкой, выгоды, как это работает, отзывы, цены, форма заявки и контакты. Вот мои детали (чем занимаюсь, для кого, как связаться): ',
  portfolio:
    'Собери сайт-портфолио, чтобы показать мои работы. Сделай обложку обо мне, галерею работ с описаниями, блок «обо мне» и контакты для заказа. Расскажу о себе и что вынести вперёд: ',
  event:
    'Собери лендинг-афишу для моего события с кнопкой записи. Сделай первый экран с названием, датой и местом, программу, спикеров/участников и форму регистрации. Детали события: ',
  game: 'Собери простую браузерную мини-игру прямо на странице — играбельную, с управлением и подсчётом очков. Моя идея игры: ',
};

export const useSiteDeepLink = () => {
  const mainInputEditor = useChatStore((s) => s.mainInputEditor);

  useEffect(() => {
    if (!mainInputEditor) return;
    const params = new URLSearchParams(window.location.search);

    // Two deep-link modes share the same prefill+retry machinery below.
    let text: string;
    let consumedKey: string;
    let marker: string;

    const slug = sessionStorage.getItem(DEEPLINK_KEY) || params.get('site');
    const tpl = sessionStorage.getItem(CREATE_KEY) || params.get('create');

    if (slug && SLUG_RE.test(slug)) {
      // One prefill per tab — remounts and topic switches must not re-trigger it.
      if (sessionStorage.getItem(CONSUMED_KEY) === slug) return;
      text = `Открой мой сайт ${slug}.jhunterpro.ru (прочитай его текущую версию навыком «Мои сайты») и помоги его отредактировать. Что нужно поменять, я напишу дальше: `;
      consumedKey = CONSUMED_KEY;
      marker = slug;
    } else if (tpl && CREATE_RE.test(tpl) && CREATE_PROMPTS[tpl]) {
      if (sessionStorage.getItem(CREATE_CONSUMED_KEY) === tpl) return;
      text = CREATE_PROMPTS[tpl];
      consumedKey = CREATE_CONSUMED_KEY;
      marker = tpl;
    } else {
      return;
    }

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
        sessionStorage.setItem(consumedKey, marker);
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
