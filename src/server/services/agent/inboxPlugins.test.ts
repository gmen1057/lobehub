import { DEFAULT_AGENT_CONFIG } from '@lobechat/const';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseAgentConfig } from '@/server/globalConfig/parseDefaultAgent';

import { defaultInboxPlugins } from './inboxPlugins';

afterEach(() => vi.unstubAllEnvs());

describe('new inbox plugin defaults', () => {
  it('extends the real nonempty builtin seed with image editing, native documents and sandbox', () => {
    vi.stubEnv('ARCKEP_DEFAULT_INBOX_PLUGINS', undefined);
    const plugins = defaultInboxPlugins();
    expect(DEFAULT_AGENT_CONFIG.plugins?.length ?? 0).toBeGreaterThan(0);
    expect(plugins).toEqual(
      expect.arrayContaining([
        ...(DEFAULT_AGENT_CONFIG.plugins ?? []),
        'mcp-arckep-studio-images',
        'mcp-arckep-studio-documents',
        'mcp-arckep-e2b-sandbox',
      ]),
    );
    expect(new Set(plugins).size).toBe(plugins.length);
  });

  it('respects and deduplicates the explicit environment selection', () => {
    vi.stubEnv('ARCKEP_DEFAULT_INBOX_PLUGINS', ' custom-tool , lobe-artifacts, custom-tool, ');
    expect(defaultInboxPlugins()).toEqual(['custom-tool', 'lobe-artifacts']);
  });

  it('preserves an explicitly empty environment selection', () => {
    vi.stubEnv('ARCKEP_DEFAULT_INBOX_PLUGINS', '');
    expect(defaultInboxPlugins()).toEqual([]);
  });
  it('keeps plugins absent in a real server env parse so creation still chooses defaults', () => {
    const config = parseAgentConfig(
      'model=server-model;provider=server-provider;params.temperature=0.7',
    );
    expect(config).not.toHaveProperty('plugins');
    expect(config).toMatchObject({ model: 'server-model', provider: 'server-provider' });
  });
});
