import { afterEach, describe, expect, it, vi } from 'vitest';

import { filterBuiltinSkills, filterUserSkills, shouldEnableBuiltinSkill } from './skillFilters';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('skillFilters', () => {
  it('should disable agent-browser on web environment', () => {
    expect(shouldEnableBuiltinSkill('lobe-agent-browser', { isDesktop: false })).toBe(false);
  });

  it('should enable agent-browser on desktop (non-Windows) environment', () => {
    expect(shouldEnableBuiltinSkill('lobe-agent-browser', { isDesktop: true })).toBe(true);
  });

  it('should enable agent-browser on desktop Windows', () => {
    expect(shouldEnableBuiltinSkill('lobe-agent-browser', { isDesktop: true })).toBe(true);
  });

  it('should not be affected by Windows platform detection when desktop is enabled', async () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    vi.resetModules();

    const { shouldEnableBuiltinSkill } = await import('./skillFilters');

    expect(shouldEnableBuiltinSkill('lobe-agent-browser', { isDesktop: true })).toBe(true);
  });

  it('should keep non-desktop-only skills enabled', () => {
    expect(shouldEnableBuiltinSkill('lobe-artifacts', { isDesktop: false })).toBe(true);
  });

  it('should filter builtin skills by platform context', () => {
    const skills = [
      {
        content: 'agent-browser',
        description: 'agent-browser',
        identifier: 'lobe-agent-browser',
        name: 'Agent Browser',
        source: 'builtin' as const,
      },
      {
        content: 'artifacts',
        description: 'artifacts',
        identifier: 'lobe-artifacts',
        name: 'Artifacts',
        source: 'builtin' as const,
      },
    ];

    const filtered = filterBuiltinSkills(skills, { isDesktop: false });

    expect(filtered).toHaveLength(1);
    expect(filtered[0].identifier).toBe('lobe-artifacts');
  });

  describe('движок без интерфейса (arckep, 19.10.2026)', () => {
    it('прячет LobeHub и Task, оставляет Artifacts', () => {
      expect(shouldEnableBuiltinSkill('lobehub', { isDesktop: false, isHeadless: true })).toBe(
        false,
      );
      expect(shouldEnableBuiltinSkill('task', { isDesktop: false, isHeadless: true })).toBe(false);
      expect(
        shouldEnableBuiltinSkill('lobe-artifacts', { isDesktop: false, isHeadless: true }),
      ).toBe(true);
    });

    it('в браузерном движке LobeHub и Task остаются', () => {
      expect(shouldEnableBuiltinSkill('lobehub', { isDesktop: false, isHeadless: false })).toBe(
        true,
      );
      expect(shouldEnableBuiltinSkill('task', { isDesktop: false, isHeadless: false })).toBe(true);
    });

    it('признак берётся из ARCKEP_HEADLESS_TOOLS=1, пока не задан явно', () => {
      vi.stubEnv('ARCKEP_HEADLESS_TOOLS', '1');
      expect(shouldEnableBuiltinSkill('lobehub', { isDesktop: false })).toBe(false);

      vi.stubEnv('ARCKEP_HEADLESS_TOOLS', '');
      expect(shouldEnableBuiltinSkill('lobehub', { isDesktop: false })).toBe(true);
    });

    it('filterBuiltinSkills убирает их из списка', () => {
      const make = (identifier: string) => ({
        content: identifier,
        description: identifier,
        identifier,
        name: identifier,
        source: 'builtin' as const,
      });

      const filtered = filterBuiltinSkills(
        [make('lobe-artifacts'), make('lobehub'), make('task'), make('seo-demand')],
        { isDesktop: false, isHeadless: true },
      );

      expect(filtered.map((skill) => skill.identifier)).toEqual(['lobe-artifacts', 'seo-demand']);
    });

    it('filterUserSkills скрывает навыки из магазина LobeHub (source=market) в режиме без интерфейса', () => {
      const items = [
        { identifier: 'seo-demand', source: 'user' },
        { identifier: 'anthropics-skills-pdf', source: 'market' },
      ];
      expect(
        filterUserSkills(items, { isDesktop: false, isHeadless: true }).map((s) => s.identifier),
      ).toEqual(['seo-demand']);
      expect(
        filterUserSkills(items, { isDesktop: false, isHeadless: false }).map((s) => s.identifier),
      ).toEqual(['seo-demand', 'anthropics-skills-pdf']);
    });
  });
});
