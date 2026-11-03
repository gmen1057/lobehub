import { describe, expect, it, vi } from 'vitest';

import { getUILocaleAndResources } from './getUILocaleAndResources';

describe('getUILocaleAndResources', () => {
  it('should fallback to en-US locale for unsupported zh-CN', async () => {
    const result = await getUILocaleAndResources('zh-CN');
    expect(result.locale).toBe('en-US');
    expect(result.resources).toBeDefined();
  });

  it('should fallback to en-US locale for unsupported zh-TW', async () => {
    const result = await getUILocaleAndResources('zh-TW');
    expect(result.locale).toBe('en-US');
    expect(result.resources).toBeDefined();
  });

  it('should return en-US locale and en resources for en-US', async () => {
    const result = await getUILocaleAndResources('en-US');
    expect(result.locale).toBe('en-US');
    expect(result.resources).toBeDefined();
  });

  it('should return en-US locale and en resources for en', async () => {
    const result = await getUILocaleAndResources('en');
    expect(result.locale).toBe('en-US');
    expect(result.resources).toBeDefined();
  });

  it('should return en-US locale and en resources for auto', async () => {
    const result = await getUILocaleAndResources('auto');
    expect(result.locale).toBe('en-US');
    expect(result.resources).toBeDefined();
  });

  it('should return ru-RU locale and custom resources for ru-RU', async () => {
    const result = await getUILocaleAndResources('ru-RU');
    expect(result.locale).toBe('ru-RU');
    expect(result.resources).toBeDefined();
  });

  it('should return ru-RU locale and custom resources for ru', async () => {
    const result = await getUILocaleAndResources('ru');
    expect(result.locale).toBe('ru-RU');
    expect(result.resources).toBeDefined();
  });

  it('should fallback to en-US locale for unsupported es-ES', async () => {
    const result = await getUILocaleAndResources('es-ES');
    expect(result.locale).toBe('en-US');
    expect(result.resources).toBeDefined();
  });

  it('should fallback to @lobehub/ui builtin resources if business ui.json is missing', async () => {
    vi.resetModules();
    vi.doMock('@/../locales/en-US/ui.json', () => ({ default: null }));

    const { getUILocaleAndResources: getWithFallback } = await import('./getUILocaleAndResources');
    const result = await getWithFallback('unknown-locale');
    expect(result.locale).toBe('en-US');
    expect(result.resources).toBeDefined();
  });
});
