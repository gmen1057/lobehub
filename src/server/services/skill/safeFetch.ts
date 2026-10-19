import { type SSRFOptions, ssrfSafeFetch } from '@lobechat/ssrf-safe-fetch';

/** Сколько байт SKILL.md или zip можно скачать по ссылке. */
export const MAX_SKILL_DOWNLOAD_BYTES = 10 * 1024 * 1024;

/** Сколько переадресаций можно пройти по одной ссылке. */
export const MAX_SKILL_REDIRECTS = 5;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface SkillSafeFetchOptions {
  /** Чем ходить в сеть (по умолчанию ssrfSafeFetch); подменяется в тестах */
  baseFetch?: typeof ssrfSafeFetch;
  maxRedirects?: number;
  /** Адреса, разрешённые вопреки запрету внутренних (только для тестов с локальным сервером) */
  ssrf?: SSRFOptions;
}

/** Каждый шаг пути — исходная ссылка и любая переадресация: только https и без логина в адресе. */
const assertAllowedUrl = (url: URL, redirected: boolean) => {
  if (url.protocol !== 'https:') {
    throw new Error(
      redirected
        ? `Only https links are allowed (redirect to ${url.protocol}//${url.host})`
        : 'Only https links are allowed',
    );
  }
  if (url.username || url.password) {
    throw new Error('Links with a login or password are not allowed');
  }
};

/**
 * arckep (19.10.2026): ссылки на навыки приходят от людей (экран «Мои навыки», просьба к помощнику), а
 * движок стоит рядом с внутренними службами (бэкенд студии, шлюз, база). Только https, без логина в адресе,
 * внутренние и метаданные-адреса запрещены (SSRF), размер ответа ограничен. Для разрешённых личных адресов
 * переменные SSRF_ALLOW_* здесь намеренно не действуют.
 *
 * Переадресации ведём сами (`redirect: 'manual'`, не больше MAX_SKILL_REDIRECTS): на каждом шаге заново
 * проверяется «только https» (https → http отклоняется), а соединение каждого шага идёт через агент, который
 * проверяет адрес, в который разрешилось имя, — переадресация на внутренний адрес и подмена DNS не проходят.
 */
export const createSkillSafeFetch = (options: SkillSafeFetchOptions = {}): typeof fetch => {
  const baseFetch = options.baseFetch ?? ssrfSafeFetch;
  const maxRedirects = options.maxRedirects ?? MAX_SKILL_REDIRECTS;
  const ssrf: SSRFOptions = {
    allowIPAddressList: options.ssrf?.allowIPAddressList ?? [],
    allowPrivateIPAddress: options.ssrf?.allowPrivateIPAddress ?? false,
  };

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

    let current: URL;
    try {
      current = new URL(raw);
    } catch {
      throw new Error('Invalid URL');
    }

    for (let hop = 0; hop <= maxRedirects; hop++) {
      assertAllowedUrl(current, hop > 0);

      const response = await baseFetch(
        current.href,
        { ...init, redirect: 'manual', size: MAX_SKILL_DOWNLOAD_BYTES } as RequestInit,
        ssrf,
      );
      if (!REDIRECT_STATUSES.has(response.status)) return response;

      const location = response.headers.get('location');
      if (!location) throw new Error(`Redirect (${response.status}) without a location`);
      try {
        current = new URL(location, current);
      } catch {
        throw new Error('Invalid URL in a redirect');
      }
    }

    throw new Error(`Too many redirects (more than ${maxRedirects})`);
  }) as typeof fetch;
};

export const skillSafeFetch = createSkillSafeFetch();
