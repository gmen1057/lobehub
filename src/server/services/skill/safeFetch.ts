import { ssrfSafeFetch } from '@lobechat/ssrf-safe-fetch';

/** Сколько байт SKILL.md или zip можно скачать по ссылке. */
export const MAX_SKILL_DOWNLOAD_BYTES = 10 * 1024 * 1024;

/**
 * arckep (19.10.2026): ссылки на навыки приходят от людей (экран «Мои навыки», просьба к помощнику), а
 * движок стоит рядом с внутренними службами (бэкенд студии, шлюз, база). Только https, без логина в адресе,
 * внутренние и метаданные-адреса запрещены (SSRF, в том числе после переадресаций), размер ответа
 * ограничен. Для разрешённых личных адресов переменные SSRF_ALLOW_* здесь намеренно не действуют.
 */
export const skillSafeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Invalid URL');
  }
  if (url.protocol !== 'https:') throw new Error('Only https links are allowed');
  if (url.username || url.password)
    throw new Error('Links with a login or password are not allowed');

  return ssrfSafeFetch(url.href, { ...init, size: MAX_SKILL_DOWNLOAD_BYTES } as RequestInit, {
    allowIPAddressList: [],
    allowPrivateIPAddress: false,
  });
}) as typeof fetch;
