import { DEFAULT_AGENT_CONFIG } from '@lobechat/const';

/** Initial inbox selection only. Existing assistants and per-message exclusions are never changed. */
export const defaultInboxPlugins = (): string[] => {
  const raw = process.env.ARCKEP_DEFAULT_INBOX_PLUGINS;
  const plugins =
    raw === undefined
      ? [
          ...(DEFAULT_AGENT_CONFIG.plugins ?? []),
          'mcp-arckep-wordstat',
          'mcp-arckep-studio-images',
          'mcp-arckep-studio-documents',
          'mcp-arckep-e2b-sandbox',
          'mcp-arckep-studio-video',
          'mcp-arckep-studio-higgsfield',
          'mcp-arckep-studio-3d',
          'mcp-arckep-studio-speech',
          'mcp-arckep-studio-presentations',
          'mcp-arckep-studio-models',
          'mcp-arckep-studio-account',
        ]
      : raw
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean);

  return [...new Set(plugins)];
};
