import { ConfigProvider } from 'antd';
import dayjs from 'dayjs';
import { memo, type PropsWithChildren, useEffect, useState } from 'react';
import { isRtlLang } from 'rtl-detect';

import Editor from '@/layout/GlobalProvider/Editor';
import { createI18nNext } from '@/locales/create';
import { getAntdLocale } from '@/utils/locale';

const dayjsLocaleLoaders = import.meta.glob<{ default: ILocale }>(
  '/node_modules/dayjs/esm/locale/{ar,bg,de,en,es,fa,fr,it,ja,ko,nl,pl,pt-br,ru,tr,vi,zh-cn,zh-tw}.js',
);

/** BCP-47 / short codes → dayjs file stem (matches glob keys above). */
const dayjsLocaleAliases: Record<string, string> = {
  'en-us': 'en',
  'pt-br': 'pt-br',
  'ru-ru': 'ru',
  'zh': 'zh-cn',
  'zh-cn': 'zh-cn',
  'zh-tw': 'zh-tw',
};

const dayjsLocaleKey = (stem: string) => `/node_modules/dayjs/esm/locale/${stem}.js`;

/**
 * Map app language (e.g. ru-RU) to a dayjs locale stem that exists in the glob.
 * Prefer explicit aliases, then full lowercased tag, then primary subtag (ru-RU → ru).
 */
const resolveDayjsLocaleStem = (lang: string): string => {
  const lower = lang.toLowerCase();
  const aliased = dayjsLocaleAliases[lower];
  if (aliased) return aliased;
  if (dayjsLocaleLoaders[dayjsLocaleKey(lower)]) return lower;

  const primary = lower.split('-')[0] ?? lower;
  const primaryAliased = dayjsLocaleAliases[primary];
  if (primaryAliased) return primaryAliased;
  if (dayjsLocaleLoaders[dayjsLocaleKey(primary)]) return primary;

  return 'en';
};

const updateDayjs = async (lang: string) => {
  const stem = resolveDayjsLocaleStem(lang);

  // English is built into dayjs — skip dynamic import (Safari/Yandex flaked on en chunk
  // + .default access → LOBECHAT-1 unhandledrejection).
  if (stem === 'en') {
    dayjs.locale('en');
    return;
  }

  const loader = dayjsLocaleLoaders[dayjsLocaleKey(stem)];
  if (!loader) {
    dayjs.locale('en');
    return;
  }

  try {
    const mod = await loader();
    const data = mod?.default;
    if (data) {
      dayjs.locale(data);
      return;
    }
    console.error(
      `dayjs locale module for ${lang} (${stem}) has no default export, fallback to en`,
    );
    dayjs.locale('en');
  } catch (error) {
    console.error('error', error);
    console.error(`dayjs locale for ${lang} not found, fallback to en`);
    // Never re-throw / never touch undefined.default — unhandledrejection was LOBECHAT-1.
    dayjs.locale('en');
  }
};

interface LocaleLayoutProps extends PropsWithChildren {
  antdLocale?: any;
  defaultLang?: string;
}

const Locale = memo<LocaleLayoutProps>(({ children, defaultLang, antdLocale }) => {
  const [i18n] = useState(() => createI18nNext(defaultLang));
  const [lang, setLang] = useState(defaultLang);
  const [locale, setLocale] = useState(antdLocale);

  // Set dayjs locale immediately on mount (don't wait for i18n init) to avoid
  // "a few seconds ago" showing in English when UI is already in Chinese
  useEffect(() => {
    if (defaultLang) updateDayjs(defaultLang);
  }, [defaultLang]);

  if (!i18n.instance.isInitialized)
    i18n.init().then(async () => {
      const resolvedLang = i18n.instance.language || defaultLang;
      if (resolvedLang) await updateDayjs(resolvedLang);
    });

  useEffect(() => {
    const handleLang = async (lng: string) => {
      setLang(lng);
      const newLocale = await getAntdLocale(lng);
      setLocale(newLocale);
      await updateDayjs(lng);
    };

    i18n.instance.on('languageChanged', handleLang);
    return () => {
      i18n.instance.off('languageChanged', handleLang);
    };
  }, [i18n]);

  const documentDir = isRtlLang(lang!) ? 'rtl' : 'ltr';

  return (
    <ConfigProvider
      direction={documentDir}
      locale={locale}
      theme={{
        components: {
          Button: {
            contentFontSizeSM: 12,
          },
        },
      }}
    >
      <Editor>{children}</Editor>
    </ConfigProvider>
  );
});

Locale.displayName = 'Locale';

export default Locale;
