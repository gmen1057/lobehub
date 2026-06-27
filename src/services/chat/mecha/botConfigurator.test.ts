import * as builtinAgents from '@lobechat/builtin-agents';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as agentStore from '@/store/agent';
import * as agentSelectors from '@/store/agent/selectors';

import { resolveAgentConfig } from './agentConfigResolver';

// BRIEF-04: «Конфигуратор ботов» как отдельный встроенный агент + deep-link ?bot=<id>.
// Part A — реестр встроенных агентов содержит bot-configurator с инструментом arckep-bot.
// Part B — botId доезжает до systemRole (через ctx и sessionStorage fallback).

const BOT_CONTEXT_MARKER = 'КОНТЕКСТ ТЕКУЩЕГО БОТА';

describe('bot-configurator builtin agent (BRIEF-04 Part A)', () => {
  it('is registered in BUILTIN_AGENTS under the bot-configurator slug', () => {
    expect(builtinAgents.BUILTIN_AGENT_SLUGS.botConfigurator).toBe('bot-configurator');
    expect(builtinAgents.BUILTIN_AGENTS['bot-configurator']).toBeDefined();
  });

  it('exposes the arckep-bot tool via runtime plugins', () => {
    const runtime = builtinAgents.getAgentRuntimeConfig('bot-configurator', { plugins: [] });

    expect(runtime?.plugins).toContain('arckep-bot');
    expect(runtime?.systemRole).toBeTruthy();
  });

  it('keeps arckep-bot first and appends caller-provided plugins', () => {
    const runtime = builtinAgents.getAgentRuntimeConfig('bot-configurator', {
      plugins: ['user-plugin'],
    });

    expect(runtime?.plugins).toEqual(['arckep-bot', 'user-plugin']);
  });
});

describe('bot-configurator deep-link context (BRIEF-04 Part B — runtime)', () => {
  it('injects the bot id into systemRole when botId is provided', () => {
    const runtime = builtinAgents.getAgentRuntimeConfig('bot-configurator', { botId: 'bot-42' });

    expect(runtime?.systemRole).toContain('bot-42');
    expect(runtime?.systemRole).toContain(BOT_CONTEXT_MARKER);
  });

  it('omits the bot context block when no botId is provided', () => {
    const runtime = builtinAgents.getAgentRuntimeConfig('bot-configurator', {});

    expect(runtime?.systemRole).not.toContain(BOT_CONTEXT_MARKER);
  });
});

describe('resolveAgentConfig threads botId to bot-configurator (BRIEF-04 Part B — glue)', () => {
  const mockAgentStoreState = { someState: true };
  const mockAgentConfig = {
    model: 'gpt-4',
    plugins: ['plugin-a', 'plugin-b'],
    systemRole: 'You are a helpful assistant',
  };
  const mockChatConfig = { enableStreaming: true };

  beforeEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();

    vi.spyOn(agentStore, 'getAgentStoreState').mockReturnValue(mockAgentStoreState as any);
    vi.spyOn(agentSelectors.agentSelectors, 'getAgentConfigById').mockReturnValue(
      () => mockAgentConfig as any,
    );
    vi.spyOn(agentSelectors.chatConfigByIdSelectors, 'getChatConfigById').mockReturnValue(
      () => mockChatConfig as any,
    );
    vi.spyOn(agentSelectors.agentSelectors, 'getAgentSlugById').mockReturnValue(
      () => 'bot-configurator',
    );
  });

  it('passes ctx.botId into the resolved systemRole and keeps the arckep-bot tool', () => {
    const result = resolveAgentConfig({ agentId: 'cfg-agent', botId: 'bot-77' });

    expect(result.slug).toBe('bot-configurator');
    expect(result.isBuiltinAgent).toBe(true);
    expect(result.plugins).toContain('arckep-bot');
    expect(result.agentConfig.systemRole).toContain('bot-77');
  });

  it('falls back to the sessionStorage botId when ctx.botId is absent', () => {
    sessionStorage.setItem('arckep:bot-configurator:botId', 'bot-from-storage');

    const result = resolveAgentConfig({ agentId: 'cfg-agent' });

    expect(result.agentConfig.systemRole).toContain('bot-from-storage');
  });

  it('does not inject bot context for a non-configurator agent even if a stale botId is set', () => {
    vi.spyOn(agentSelectors.agentSelectors, 'getAgentSlugById').mockReturnValue(() => undefined);
    sessionStorage.setItem('arckep:bot-configurator:botId', 'bot-stale');

    const result = resolveAgentConfig({ agentId: 'plain-agent', botId: 'bot-stale' });

    expect(result.isBuiltinAgent).toBe(false);
    expect(result.agentConfig.systemRole).not.toContain('bot-stale');
  });
});
