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
  disableBot: async (botId: string) => callBotTool({ action: 'disable', bot_id: botId }),
  enableBot: async (botId: string) => callBotTool({ action: 'enable', bot_id: botId }),
  getBotConfig: async (botId: string) => callBotTool({ action: 'config', bot_id: botId }),
  listMyBots: async () => {
    const data = await callBotTool({ action: 'list' });
    return data.bots;
  },
  setAccessRule: async (botId: string, dmPolicy?: string, charLimit?: number) =>
    callBotTool({ action: 'setAccessRule', bot_id: botId, dmPolicy, charLimit }),
  setCommands: async (
    botId: string,
    commands: Array<{ description: string; name: string; response: string }>,
  ) => callBotTool({ action: 'setCommands', bot_id: botId, commands }),
  setGreeting: async (botId: string, greeting: string) =>
    callBotTool({ action: 'setGreeting', bot_id: botId, greeting }),
  setModel: async (botId: string, model: string, provider: string) =>
    callBotTool({ action: 'setModel', bot_id: botId, model, provider }),
});

class ArckepBotExecutor extends BaseExecutor<typeof ArckepBotApiName> {
  readonly identifier = ArckepBotIdentifier;
  protected readonly apiEnum = ArckepBotApiName;

  disableBot = async (_params: { bot_id: string }, _ctx: BuiltinToolContext): Promise<BuiltinToolResult> => {
    return runtime.disableBot(_params);
  };

  enableBot = async (_params: { bot_id: string }, _ctx: BuiltinToolContext): Promise<BuiltinToolResult> => {
    return runtime.enableBot(_params);
  };

  getBotConfig = async (params: { bot_id: string }, _ctx: BuiltinToolContext): Promise<BuiltinToolResult> => {
    return runtime.getBotConfig(params);
  };

  listMyBots = async (_params: any, _ctx: BuiltinToolContext): Promise<BuiltinToolResult> => {
    return runtime.listMyBots();
  };

  setAccessRule = async (params: { bot_id: string; dm_policy?: string; char_limit?: number }, _ctx: BuiltinToolContext): Promise<BuiltinToolResult> => {
    return runtime.setAccessRule(params);
  };

  setCommands = async (
    params: { bot_id: string; commands: Array<{ description: string; name: string; response: string }> },
    _ctx: BuiltinToolContext,
  ): Promise<BuiltinToolResult> => {
    return runtime.setCommands(params);
  };

  setGreeting = async (params: { bot_id: string; greeting: string }, _ctx: BuiltinToolContext): Promise<BuiltinToolResult> => {
    return runtime.setGreeting(params);
  };

  setModel = async (params: { bot_id: string; model: string; provider: string }, _ctx: BuiltinToolContext): Promise<BuiltinToolResult> => {
    return runtime.setModel(params);
  };
}

export const arckepBotExecutor = new ArckepBotExecutor();
