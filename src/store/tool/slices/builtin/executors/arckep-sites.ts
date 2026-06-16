/**
 * ArcKep Sites Executor (client side).
 *
 * Plain 1-on-1 chat executes builtin tools in the browser — without this
 * executor the «Мои сайты» skill silently returned «No executor found»
 * (incident 2026-06-12: model called listSites, got nothing). Delegates to
 * /chat/api/sites-tool, which authenticates via the arckep_token cookie and
 * forwards to the image-studio backend. The server agent loop (group chats)
 * keeps using services/toolExecution/serverRuntimes/arckepSites.ts.
 *
 * Result formatting is shared with the server path through
 * ArckepSitesExecutionRuntime, so models see identical tool output.
 */
import {
  ArckepSitesApiName,
  ArckepSitesIdentifier,
  type GenerateImageParams,
} from '@lobechat/builtin-tool-arckep-sites';
import { ArckepSitesExecutionRuntime } from '@lobechat/builtin-tool-arckep-sites/executionRuntime';
import type { BuiltinToolContext, BuiltinToolResult } from '@lobechat/types';
import { BaseExecutor } from '@lobechat/types';

const callSitesTool = async (body: Record<string, unknown>) => {
  const res = await fetch('/chat/api/sites-tool', {
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`sites-tool ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
};

const runtime = new ArckepSitesExecutionRuntime({
  generateImage: async (params) =>
    callSitesTool({
      action: 'generate-image',
      aspect_ratio: params.aspect_ratio,
      prompt: params.prompt,
      quality: params.quality,
    }),
  listSites: async () => {
    const data = await callSitesTool({ action: 'list' });
    return data.sites;
  },
  readSite: async (siteId: number) => callSitesTool({ action: 'read', site_id: siteId }),
  connectTelegram: async () => callSitesTool({ action: 'telegram-connect-link' }),
});

class ArckepSitesExecutor extends BaseExecutor<typeof ArckepSitesApiName> {
  readonly identifier = ArckepSitesIdentifier;
  protected readonly apiEnum = ArckepSitesApiName;

  listSites = async (_params: any, _ctx: BuiltinToolContext): Promise<BuiltinToolResult> => {
    return runtime.listSites();
  };

  readSite = async (
    params: { site_id: number },
    _ctx: BuiltinToolContext,
  ): Promise<BuiltinToolResult> => {
    return runtime.readSite(params);
  };

  generateImage = async (
    params: GenerateImageParams,
    _ctx: BuiltinToolContext,
  ): Promise<BuiltinToolResult> => {
    return runtime.generateImage(params);
  };

  connectTelegram = async (_params: any, _ctx: BuiltinToolContext): Promise<BuiltinToolResult> => {
    return runtime.connectTelegram();
  };
}

export const arckepSitesExecutor = new ArckepSitesExecutor();
