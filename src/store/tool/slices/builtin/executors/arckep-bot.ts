/**
 * ArcKep Bot configurator executor (client side, 1-on-1 chat).
 *
 * Plain 1-on-1 chat executes builtin tools in the browser — without this
 * executor the «Мои боты» configurator skill would return «No executor found»
 * (cf. arckep-sites incident 2026-06-12). Delegates to /chat/api/bot-config-tool,
 * which authenticates via the BetterAuth session and reads agent_bot_providers.
 * The server agent loop (group chats) uses serverRuntimes/arckepBot.ts.
 *
 * Result formatting is shared with the server path through
 * ArckepBotExecutionRuntime, so models see identical tool output.
 */
import { ArckepBotApiName, ArckepBotIdentifier } from '@lobechat/builtin-tool-arckep-bot';
import { ArckepBotExecutionRuntime } from '@lobechat/builtin-tool-arckep-bot/executionRuntime';
import type { BuiltinToolContext, BuiltinToolResult } from '@lobechat/types';
import { BaseExecutor } from '@lobechat/types';

const callBotTool = async (body: Record<string, unknown>) => {
  const res = await fetch('/chat/api/bot-config-tool', {
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`bot-config-tool ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
};

const runtime = new ArckepBotExecutionRuntime({
  getBotConfig: async (botId: string) => callBotTool({ action: 'config', bot_id: botId }),
  listMyBots: async () => {
    const data = await callBotTool({ action: 'list' });
    return data.bots;
  },
});

class ArckepBotExecutor extends BaseExecutor<typeof ArckepBotApiName> {
  readonly identifier = ArckepBotIdentifier;
  protected readonly apiEnum = ArckepBotApiName;

  listMyBots = async (_params: any, _ctx: BuiltinToolContext): Promise<BuiltinToolResult> => {
    return runtime.listMyBots();
  };

  getBotConfig = async (
    params: { bot_id: string },
    _ctx: BuiltinToolContext,
  ): Promise<BuiltinToolResult> => {
    return runtime.getBotConfig(params);
  };
}

export const arckepBotExecutor = new ArckepBotExecutor();
