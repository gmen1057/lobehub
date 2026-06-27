import dayjs from 'dayjs';
import isToday from 'dayjs/plugin/isToday';
import isYesterday from 'dayjs/plugin/isYesterday';
import relativeTime from 'dayjs/plugin/relativeTime';
import utc from 'dayjs/plugin/utc';
import { enableMapSet, enablePatches } from 'immer';
import { scan } from 'react-scan';

import { isChunkLoadError, notifyChunkError } from '@/utils/chunkError';

enablePatches();
enableMapSet();

// Dayjs plugins - extend once at app init to avoid duplicate extensions in components
dayjs.extend(relativeTime);
dayjs.extend(utc);
dayjs.extend(isToday);
dayjs.extend(isYesterday);

// arckep: deep link «Править с агентом» (/chat/?site=<slug>). The SPA router
// has no /chat/ route — its catch-all does Navigate replace to '/', dropping
// the query string before ChatInput mounts. Capture the slug HERE (initialize
// runs before the router) and hand it to useSiteDeepLink via sessionStorage.
if (typeof window !== 'undefined') {
  const params = new URLSearchParams(window.location.search);
  const slug = params.get('site');
  if (slug && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug)) {
    sessionStorage.setItem('arckep-site-deeplink', slug);
  }
  // arckep: deep link «Собрать сайт» (/chat/?create=<templateId>) — start a NEW
  // site from a template prompt. Same capture-before-router trick as site=.
  const tpl = params.get('create');
  if (tpl && /^[a-z]{1,20}$/.test(tpl)) {
    sessionStorage.setItem('arckep-create-deeplink', tpl);
  }
  // arckep: deep link «Подключить бота» (/chat/?botidea=<templateId>) — start a
  // chat about a Telegram bot of that kind. Same capture-before-router trick.
  const botTpl = params.get('botidea');
  if (botTpl && /^[a-z]{1,20}$/.test(botTpl)) {
    sessionStorage.setItem('arckep-botidea-deeplink', botTpl);
  }
}

// Global fallback: catch async chunk-load failures that escape Error Boundaries
if (typeof window !== 'undefined') {
  window.addEventListener('vite:preloadError', (event) => {
    event.preventDefault();
    notifyChunkError();
  });

  window.addEventListener('unhandledrejection', (event) => {
    if (isChunkLoadError(event.reason)) {
      event.preventDefault();
      notifyChunkError();
    }
  });
}

if (__DEV__) {
  scan({ enabled: true });
}
