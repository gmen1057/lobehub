// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

const loadI18nNamespaceModule = vi.fn(async ({ lng, ns }: { lng: string; ns: string }) => ({
  default: {
    key: `${lng}:${ns}`,
  },
}));

vi.mock('./loadI18nNamespaceModule', () => ({
  loadI18nNamespaceModule,
}));

describe('createI18nNext', () => {
  it('initializes synchronously with bundled fallback resources and reloads the actual language in background', async () => {
    const { createI18nNext } = await import('@/locales/create');

    const i18n = createI18nNext('ru-RU');
    const reloadSpy = vi.spyOn(i18n.instance, 'reloadResources');
    const initPromise = i18n.init({ initAsync: false });

    expect(i18n.instance.isInitialized).toBe(true);
    expect(i18n.instance.getResource('ru-RU', 'common', 'copy')).toBeDefined();

    await initPromise;
    await Promise.resolve();
    await Promise.resolve();

    expect(i18n.instance.hasResourceBundle('ru-RU', 'common')).toBe(true);
    expect(i18n.instance.hasResourceBundle('ru-RU', 'chat')).toBe(true);
    expect(i18n.instance.hasResourceBundle('ru-RU', 'error')).toBe(true);

    expect(reloadSpy).toHaveBeenCalledWith(['ru-RU'], ['chat', 'common', 'error']);
    expect(loadI18nNamespaceModule).toHaveBeenCalledWith(
      expect.objectContaining({ lng: 'ru-RU', ns: 'common' }),
    );
    expect(loadI18nNamespaceModule).toHaveBeenCalledWith(
      expect.objectContaining({ lng: 'ru-RU', ns: 'chat' }),
    );
    expect(loadI18nNamespaceModule).toHaveBeenCalledWith(
      expect.objectContaining({ lng: 'ru-RU', ns: 'error' }),
    );
  });
});
