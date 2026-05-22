import { DEFAULT_LANG } from '@/const/locale';

import type resources from './default';

export const locales = ['en-US', 'ru-RU'] as const;

export type DefaultResources = typeof resources;
export type NS = keyof DefaultResources;
export type Locales = (typeof locales)[number] | (string & {});

export const normalizeLocale = (locale?: string): Locales => {
  if (!locale) return DEFAULT_LANG;

  for (const l of locales) {
    if (l.startsWith(locale)) {
      return l;
    }
  }

  return DEFAULT_LANG;
};

type LocaleOptions = {
  label: string;
  value: Locales;
}[];

export const localeOptions: LocaleOptions = [
  {
    label: 'English',
    value: 'en-US',
  },
  {
    label: 'Русский',
    value: 'ru-RU',
  },
] as LocaleOptions;

export const supportLocales: string[] = [...locales, 'en'];
