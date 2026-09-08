import { type ConversationContext, type UIChatMessage } from '@lobechat/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { messageMapKey } from '@/store/chat/utils/messageMapKey';

import {
  decideSitesAutoContinue,
  defaultFetchTopicSpend,
  detectSiteRun,
  isEligibleSitesAgent,
  isSitesAutoContinueEnabled,
  maybeSitesAutoContinue,
  parseJudgeResult,
  resetSitesAutoContinueState,
  SITES_AUTO_CONTINUE_MAX_REPAIRS,
  SITES_AUTO_CONTINUE_SPEND_CAP_RUB,
  type SitesAutoContinueHost,
  topicRunKey,
} from './sitesAutoContinue';

const AGENT_ID = 'agent-sites-1';
const TOPIC_ID = 'topic-sites-1';
const SESSION_ID = 'session-sites-1';

const context: ConversationContext = {
  agentId: AGENT_ID,
  topicId: TOPIC_ID,
  threadId: undefined,
};

const htmlLanding = `
<html><body>
  <h1>Кофейня на Садовой</h1>
  <p>Звоните <a href="tel:+79990001122">+7 999 000-11-22</a></p>
  <img src="https://cdn.arckep.ru/img/hero.jpg" alt="кофе" />
</body></html>
`;

const assistantWithHtml = (overrides: Partial<UIChatMessage> = {}): UIChatMessage =>
  ({
    content: `<lobeArtifact identifier="landing" type="text/html">${htmlLanding}</lobeArtifact>`,
    createdAt: Date.now(),
    id: 'asst-1',
    role: 'assistant',
    tools: [
      {
        apiName: 'generateImage',
        arguments: '{}',
        id: 'tc-1',
        identifier: 'arckep-sites',
        type: 'builtin',
      },
    ],
    updatedAt: Date.now(),
    ...overrides,
  }) as UIChatMessage;

const createHost = (messages: UIChatMessage[], exec = vi.fn().mockResolvedValue(undefined)) => {
  const key = messageMapKey(context);
  const optimisticCreateMessage = vi.fn().mockResolvedValue({ id: 'tool-ask-1' });
  const host: SitesAutoContinueHost = {
    completeOperation: vi.fn(),
    dbMessagesMap: { [key]: messages },
    internal_execAgentRuntime: exec,
    messagesMap: { [key]: messages },
    optimisticCreateMessage,
    startOperation: vi.fn(() => ({
      abortController: new AbortController(),
      operationId: 'op-tray-1',
    })),
    updateOperationMetadata: vi.fn(),
  };
  return { exec, host, optimisticCreateMessage };
};

beforeEach(() => {
  resetSitesAutoContinueState();
});

afterEach(() => {
  resetSitesAutoContinueState();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('sites auto-continue flags', () => {
  it('is off by default', () => {
    expect(isSitesAutoContinueEnabled()).toBe(false);
    expect(isSitesAutoContinueEnabled({ enableSitesAutoContinue: false })).toBe(false);
  });

  it('opts in via chatConfig', () => {
    expect(isSitesAutoContinueEnabled({ enableSitesAutoContinue: true })).toBe(true);
  });
});

describe('eligibility', () => {
  it('allows inbox helper and arckep-sites agents only', () => {
    expect(isEligibleSitesAgent({ agentId: 'inbox', plugins: [] })).toBe(true);
    expect(isEligibleSitesAgent({ agentId: 'other', inboxAgentId: 'inbox-uuid', plugins: [] })).toBe(
      false,
    );
    expect(
      isEligibleSitesAgent({ agentId: 'inbox-uuid', inboxAgentId: 'inbox-uuid', plugins: [] }),
    ).toBe(true);
    expect(isEligibleSitesAgent({ agentId: 'custom', plugins: ['arckep-sites'] })).toBe(true);
    expect(isEligibleSitesAgent({ agentId: 'custom', plugins: ['lobe-web-browsing'] })).toBe(false);
  });
});

describe('detectSiteRun', () => {
  it('detects arckep-sites tools and HTML artifacts', () => {
    expect(detectSiteRun([assistantWithHtml()])).toBe(true);
    expect(
      detectSiteRun([
        {
          content: 'курс доллара 90',
          createdAt: 1,
          id: 'a2',
          role: 'assistant',
          updatedAt: 1,
        } as UIChatMessage,
      ]),
    ).toBe(false);
  });
});

describe('decideSitesAutoContinue', () => {
  const base = {
    eligible: true,
    enabled: true,
    hasPendingIntervention: false,
    hasTopic: true,
    isGroup: false,
    isSiteRun: true,
    judge: null as null,
    maxRepairs: SITES_AUTO_CONTINUE_MAX_REPAIRS,
    repairCount: 0,
    spendCapRub: SITES_AUTO_CONTINUE_SPEND_CAP_RUB,
    spendLabeled: true,
    spendRub: 12,
    unfinished: false,
    unfinishedCount: 0,
  };

  it('skips when flag is off', () => {
    expect(decideSitesAutoContinue({ ...base, enabled: false }).reason).toBe('flag_off');
  });

  it('asks when spend cap exceeded', () => {
    const decision = decideSitesAutoContinue({
      ...base,
      spendRub: SITES_AUTO_CONTINUE_SPEND_CAP_RUB + 1,
    });
    expect(decision.action).toBe('ask');
    expect(decision.reason).toBe('spend_cap');
    expect(decision.ask?.prompt).toContain(String(SITES_AUTO_CONTINUE_SPEND_CAP_RUB));
  });

  it('asks after 2 repairs', () => {
    const decision = decideSitesAutoContinue({
      ...base,
      judge: { issues: ['нет контактов'], pass: false },
      repairCount: 2,
    });
    expect(decision.action).toBe('ask');
    expect(decision.reason).toBe('max_repairs');
  });
});

describe('parseJudgeResult', () => {
  it('parses JSON from the cheap judge', () => {
    expect(parseJudgeResult('{"pass":true,"issues":[]}')).toEqual({ issues: [], pass: true });
    expect(parseJudgeResult('ok\n{"pass":false,"issues":["нет заголовка"]}')).toEqual({
      issues: ['нет заголовка'],
      pass: false,
    });
  });
});

describe('maybeSitesAutoContinue', () => {
  it('flag off → no continue and no topic-spend fetch', async () => {
    const fetchSpend = vi.fn();
    const { exec, host } = createHost([assistantWithHtml()]);

    const result = await maybeSitesAutoContinue(() => host, context, {
      enabled: false,
      fetchSpend,
      plugins: ['arckep-sites'],
      sessionId: SESSION_ID,
    });

    expect(result).toEqual({ action: 'skip', reason: 'flag_off' });
    expect(fetchSpend).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });

  it('cap exceeded → ask, no hidden continue', async () => {
    const fetchSpend = vi.fn().mockResolvedValue({
      cost_rub: SITES_AUTO_CONTINUE_SPEND_CAP_RUB + 30,
      labeled: true,
    });
    const { exec, host, optimisticCreateMessage } = createHost([assistantWithHtml()]);

    const result = await maybeSitesAutoContinue(() => host, context, {
      enabled: true,
      fetchSpend,
      plugins: ['arckep-sites'],
      sessionId: SESSION_ID,
    });

    expect(result.action).toBe('ask');
    expect(result.reason).toBe('spend_cap');
    expect(exec).not.toHaveBeenCalled();
    expect(optimisticCreateMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        plugin: expect.objectContaining({
          apiName: 'askUserQuestion',
          identifier: 'lobe-user-interaction',
        }),
        role: 'tool',
      }),
    );
    expect(fetchSpend).toHaveBeenCalledWith(SESSION_ID, TOPIC_ID);
  });

  it('2 repairs then ask', async () => {
    const fetchSpend = vi.fn().mockResolvedValue({ cost_rub: 20, labeled: true });
    const judge = vi.fn().mockResolvedValue({ issues: ['нет контактов'], pass: false });
    const { exec, host, optimisticCreateMessage } = createHost([assistantWithHtml()]);

    const result = await maybeSitesAutoContinue(() => host, context, {
      enabled: true,
      fetchSpend,
      judge,
      plugins: ['arckep-sites'],
      sessionId: SESSION_ID,
    });

    expect(exec).toHaveBeenCalledTimes(2);
    expect(judge).toHaveBeenCalledTimes(2);
    expect(result.action).toBe('ask');
    expect(result.reason).toBe('max_repairs');
    expect(optimisticCreateMessage).toHaveBeenCalledTimes(1);
    expect(topicRunKey(AGENT_ID, TOPIC_ID)).toContain(TOPIC_ID);
  });

  it('does not continue a short Q&A without site tools', async () => {
    const fetchSpend = vi.fn().mockResolvedValue({ cost_rub: 1, labeled: true });
    const qa: UIChatMessage = {
      content: 'Курс доллара около 90 ₽.',
      createdAt: 1,
      id: 'asst-qa',
      role: 'assistant',
      updatedAt: 1,
    };
    const { exec, host } = createHost([qa]);

    const result = await maybeSitesAutoContinue(() => host, context, {
      enabled: true,
      fetchSpend,
      plugins: ['arckep-sites'],
      sessionId: SESSION_ID,
    });

    expect(result.reason).toBe('not_site_run');
    expect(exec).not.toHaveBeenCalled();
  });

  it('reads already-charged ₽ from topic-spend', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({ cost_rub: 42.5, labeled: true }),
      ok: true,
    });
    vi.stubGlobal('fetch', fetchMock);

    const spend = await defaultFetchTopicSpend('sess-a', 'topic-b');

    expect(spend).toEqual({ cost_rub: 42.5, labeled: true });
    expect(fetchMock).toHaveBeenCalledWith(
      '/chat/api/arckep/topic-spend?session_id=sess-a&topic_id=topic-b',
      { cache: 'no-store' },
    );
  });

  it('does not continue for agents without arckep-sites', async () => {
    const fetchSpend = vi.fn();
    const { exec, host } = createHost([assistantWithHtml()]);

    const result = await maybeSitesAutoContinue(() => host, context, {
      enabled: true,
      fetchSpend,
      plugins: ['lobe-web-browsing'],
      sessionId: SESSION_ID,
    });

    expect(result.reason).toBe('not_eligible');
    expect(fetchSpend).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });
});
