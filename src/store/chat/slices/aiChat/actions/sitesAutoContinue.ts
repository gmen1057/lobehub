import { INBOX_SESSION_ID, LOADING_FLAT, MESSAGE_CANCEL_FLAT } from '@lobechat/const';
import { type ConversationContext, type UIChatMessage } from '@lobechat/types';
import { nanoid } from '@lobechat/utils';

import { messageMapKey } from '@/store/chat/utils/messageMapKey';

const ARCKEP_SITES_ID = 'arckep-sites';
const USER_INTERACTION_ID = 'lobe-user-interaction';
const ASK_USER_QUESTION_API = 'askUserQuestion';

/**
 * Master switch. Owner 2026-09-08: on for helper + agents with arckep-sites.
 * Cap 150 ₽ / max 2 repairs. Env ARCKEP_SITES_AUTO_CONTINUE=1 is a spare on-switch.
 */
export const SITES_AUTO_CONTINUE_ENABLED = true;

/** RUB already charged on this topic (GET /chat/api/arckep/topic-spend). Easy to change. */
export const SITES_AUTO_CONTINUE_SPEND_CAP_RUB = 150;

export const SITES_AUTO_CONTINUE_MAX_REPAIRS = 2;

/** Live cheap Flash in our Google picker (3.6), not retired 2.5-lite. */
export const SITES_AUTO_CONTINUE_JUDGE_MODEL = 'gemini-3.6-flash';

export const SITES_AUTO_CONTINUE_JUDGE_PROVIDER = 'google';

const SITES_TOOL_APIS = new Set([
  'generateImage',
  'publish',
  'getDesignBrief',
  'listStyles',
  'editSite',
  'readSite',
  'listSites',
]);

const CAN_CONTINUE_RE =
  /ну дальше|могу продолжить|продолжить\?|сказать[, ]?когда|напишите[, ]?если|жду ваше|жду команду|ready to continue|i can continue|shall i continue|let me know if you want/i;

const PLACEHOLDER_IMG_RE =
  /placeholder|placehold\.co|picsum\.photos|lorem|dummyimage|via\.placeholder|unsplash\.it|example\.com/i;

const CONTACT_RE =
  /tel:|mailto:|t\.me\/|telegram|whatsapp|@\w+|type=["']email["']|name=["']phone["']|\+?\d[\d\s\-()]{8,}/i;

const PUBLISHED_RE = /jhunterpro\.ru|опубликован|уже на сайте/i;

const HTML_ARTIFACT_RE =
  /<lobeArtifact[^>]*type=["']text\/html["'][^>]*>([\s\S]*?)<\/lobeArtifact>/i;

export type SitesAutoContinueAction = 'skip' | 'judge' | 'continue' | 'repair' | 'ask';

export interface SitesAutoContinueDecision {
  action: SitesAutoContinueAction;
  ask?: SitesAskPayload;
  issues?: string[];
  prompt?: string;
  reason: string;
}

export interface SitesAskPayload {
  description?: string;
  options: Array<{ label: string; value: string }>;
  prompt: string;
}

export interface SitesAutoContinueResult {
  action: SitesAutoContinueAction;
  reason: string;
}

export interface SitesJudgeResult {
  issues: string[];
  pass: boolean;
}

export interface SitesTopicSpend {
  cost_rub: number | null;
  labeled: boolean;
}

export interface SitesAutoContinueDeps {
  chatConfig?: { enableSitesAutoContinue?: boolean };
  enabled?: boolean;
  fetchSpend?: (sessionId: string, topicId: string) => Promise<SitesTopicSpend>;
  inboxAgentId?: string;
  judge?: (html: string, assistantText: string) => Promise<SitesJudgeResult>;
  plugins?: string[];
  sessionId?: string;
  slug?: string;
}

export interface SitesAutoContinueHost {
  completeOperation?: (operationId: string) => void;
  dbMessagesMap?: Record<string, UIChatMessage[]>;
  // Compatible with ChatStore; keep loose so the lifecycle hook needs no cast.
  internal_execAgentRuntime: (params: {
    context: ConversationContext;
    messages: UIChatMessage[];
    parentMessageId: string;
    parentMessageType: 'assistant' | 'tool' | 'user';
    [key: string]: unknown;
  }) => Promise<unknown>;
  messagesMap?: Record<string, UIChatMessage[]>;
  optimisticCreateMessage?: (message: any) => Promise<unknown>;
  startOperation?: (params: {
    context?: Partial<ConversationContext>;
    label?: string;
    metadata?: Record<string, unknown>;
    type: string;
  }) => { abortController: AbortController; operationId: string };
  updateOperationMetadata?: (operationId: string, metadata: Record<string, unknown>) => void;
}

interface TopicRunState {
  asked: boolean;
  repairCount: number;
  unfinishedCount: number;
}

const topicRuns = new Map<string, TopicRunState>();

export const topicRunKey = (agentId: string, topicId: string) => `${agentId}:${topicId}`;

export const getTopicRunState = (key: string): TopicRunState => {
  const existing = topicRuns.get(key);
  if (existing) return existing;
  const created: TopicRunState = { asked: false, repairCount: 0, unfinishedCount: 0 };
  topicRuns.set(key, created);
  return created;
};

export const resetSitesAutoContinueState = (key?: string) => {
  if (key) topicRuns.delete(key);
  else topicRuns.clear();
};

export const isSitesAutoContinueEnabled = (chatConfig?: {
  enableSitesAutoContinue?: boolean;
}): boolean => {
  if (chatConfig?.enableSitesAutoContinue === true) return true;
  if (chatConfig?.enableSitesAutoContinue === false) return false;
  if (typeof process !== 'undefined' && process.env?.ARCKEP_SITES_AUTO_CONTINUE === '1') {
    return true;
  }
  return SITES_AUTO_CONTINUE_ENABLED;
};

export const isEligibleSitesAgent = ({
  agentId,
  inboxAgentId,
  plugins,
  slug,
}: {
  agentId: string;
  inboxAgentId?: string;
  plugins?: string[];
  slug?: string;
}): boolean => {
  const isInbox =
    agentId === INBOX_SESSION_ID ||
    (!!inboxAgentId && agentId === inboxAgentId) ||
    slug === INBOX_SESSION_ID;
  const hasPlugin = (plugins || []).includes(ARCKEP_SITES_ID);
  return isInbox || hasPlugin;
};

export const collectMessageTools = (messages: UIChatMessage[]) => {
  const tools: Array<{
    apiName: string;
    identifier: string;
    result?: string | null;
  }> = [];

  const push = (identifier?: string, apiName?: string, result?: string | null) => {
    if (!identifier && !apiName) return;
    tools.push({
      apiName: apiName || '',
      identifier: identifier || '',
      result,
    });
  };

  for (const message of messages) {
    if (message.tools) {
      for (const tool of message.tools) {
        push(tool.identifier, tool.apiName);
      }
    }
    if (message.children) {
      for (const child of message.children) {
        if (!child.tools) continue;
        for (const tool of child.tools) {
          push(tool.identifier, tool.apiName, tool.result?.content ?? null);
        }
      }
    }
    if (message.role === 'tool' && message.plugin) {
      push(message.plugin.identifier, message.plugin.apiName, message.content);
    }
  }

  return tools;
};

const isArckepSitesTool = (tool: { apiName: string; identifier: string }) =>
  tool.identifier === ARCKEP_SITES_ID ||
  tool.identifier.includes(ARCKEP_SITES_ID) ||
  SITES_TOOL_APIS.has(tool.apiName);

export const extractHtmlArtifact = (messages: UIChatMessage[]): string => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    const chunks = [message.content];
    if (message.children) {
      for (const child of message.children) chunks.push(child.content || '');
    }
    for (const chunk of chunks) {
      if (!chunk) continue;
      const tagged = chunk.match(HTML_ARTIFACT_RE);
      if (tagged?.[1]) return tagged[1].trim();
      if (/<html[\s>]/i.test(chunk) && chunk.length > 80) return chunk;
    }
  }
  return '';
};

export const detectSiteRun = (messages: UIChatMessage[]): boolean => {
  const recent = messages.slice(-12);
  if (extractHtmlArtifact(recent)) return true;
  return collectMessageTools(recent).some(isArckepSitesTool);
};

export const hasPendingIntervention = (messages: UIChatMessage[]): boolean => {
  for (const message of messages) {
    if (message.role === 'tool' && message.pluginIntervention?.status === 'pending') return true;
    if (message.children) {
      for (const child of message.children) {
        if (child.tools?.some((tool) => tool.intervention?.status === 'pending')) return true;
      }
    }
  }
  return false;
};

export const looksUnfinished = (
  messages: UIChatMessage[],
): { reason?: string; unfinished: boolean } => {
  const last = [...messages].reverse().find((m) => m.role === 'assistant');
  if (!last) return { unfinished: false };

  const text = [last.content, ...(last.children?.map((c) => c.content || '') ?? [])].join('\n');
  if (text === LOADING_FLAT || text === MESSAGE_CANCEL_FLAT) {
    return { unfinished: false };
  }

  if (CAN_CONTINUE_RE.test(text)) {
    return { reason: 'can_continue', unfinished: true };
  }

  const html = extractHtmlArtifact(messages);
  const published =
    PUBLISHED_RE.test(text) ||
    collectMessageTools(messages).some((tool) => tool.apiName === 'editSite' && Boolean(tool.result));
  // Incomplete landing HTML (no heading / placeholder images) — keep going instead of «ну дальше».
  if (
    html &&
    !published &&
    (!/<h[12][\s>]/i.test(html) || PLACEHOLDER_IMG_RE.test(html) || !CONTACT_RE.test(html))
  ) {
    return { reason: 'html_without_publish', unfinished: true };
  }

  return { unfinished: false };
};

export const parseJudgeResult = (text: string): SitesJudgeResult => {
  const trimmed = text.trim();
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as { issues?: unknown; pass?: unknown };
      const issues = Array.isArray(parsed.issues)
        ? parsed.issues.filter((item): item is string => typeof item === 'string')
        : [];
      if (typeof parsed.pass === 'boolean') return { issues, pass: parsed.pass };
    } catch {
      // fall through
    }
  }
  if (/\bpass["']?\s*:\s*true\b/i.test(trimmed) || /^pass\b/i.test(trimmed)) {
    return { issues: [], pass: true };
  }
  return { issues: ['не разобрал ответ проверки'], pass: false };
};

export const buildAskPayload = (
  reason: 'spend_cap' | 'max_repairs' | 'stuck_unfinished',
  issues?: string[],
): SitesAskPayload => {
  if (reason === 'spend_cap') {
    return {
      description: 'Дальше снова спишутся деньги. Продолжить или остановиться?',
      options: [
        { label: 'Продолжить', value: 'continue' },
        { label: 'Остановить', value: 'stop' },
      ],
      prompt: `По этой сборке уже больше ${SITES_AUTO_CONTINUE_SPEND_CAP_RUB} ₽`,
    };
  }
  if (reason === 'max_repairs') {
    return {
      description: issues?.length
        ? issues.join(' ')
        : 'Проверка дважды не прошла — дальше без вас не лезу.',
      options: [
        { label: 'Попробовать ещё', value: 'continue' },
        { label: 'Оставить как есть', value: 'stop' },
      ],
      prompt: 'Сайт сам не довёл',
    };
  }
  return {
    description: 'Могу продолжить, если скажете что важнее.',
    options: [
      { label: 'Продолжить', value: 'continue' },
      { label: 'Оставить как есть', value: 'stop' },
    ],
    prompt: 'Застрял на сайте',
  };
};

export const buildContinuePrompt = (reason?: string, issues?: string[]) => {
  if (issues?.length) {
    return [
      '[Автопродолжение] Короткая проверка не прошла:',
      ...issues.map((issue) => `- ${issue}`),
      'Почини сайт (editSite или новый HTML) и закончи. Не пиши «ну дальше» и не спрашивай разрешения.',
    ].join('\n');
  }
  if (reason === 'html_without_publish') {
    return '[Автопродолжение] HTML лендинга уже есть, но до публикации не дошёл. Доведи: заголовок, контакты, живые картинки, публикация. Не пиши «ну дальше».';
  }
  return '[Автопродолжение] Не останавливайся и не спрашивай «ну дальше». Доведи лендинг: заголовок, контакты, живые картинки (не заглушки). Если HTML готов — опубликуй.';
};

export const decideSitesAutoContinue = (input: {
  eligible: boolean;
  enabled: boolean;
  hasPendingIntervention: boolean;
  hasTopic: boolean;
  isGroup: boolean;
  isSiteRun: boolean;
  judge?: SitesJudgeResult | null;
  maxRepairs: number;
  repairCount: number;
  spendCapRub: number;
  spendLabeled: boolean;
  spendRub: number | null;
  unfinished: boolean;
  unfinishedCount: number;
  unfinishedReason?: string;
}): SitesAutoContinueDecision => {
  if (!input.enabled) return { action: 'skip', reason: 'flag_off' };
  if (!input.eligible) return { action: 'skip', reason: 'not_eligible' };
  if (input.isGroup) return { action: 'skip', reason: 'group' };
  if (!input.hasTopic) return { action: 'skip', reason: 'no_topic' };
  if (input.hasPendingIntervention) return { action: 'skip', reason: 'pending_intervention' };
  if (!input.isSiteRun) return { action: 'skip', reason: 'not_site_run' };

  if (input.spendLabeled && input.spendRub != null && input.spendRub > input.spendCapRub) {
    return {
      action: 'ask',
      ask: buildAskPayload('spend_cap'),
      reason: 'spend_cap',
    };
  }

  if (input.repairCount >= input.maxRepairs) {
    return {
      action: 'ask',
      ask: buildAskPayload('max_repairs', input.judge?.issues),
      issues: input.judge?.issues,
      reason: 'max_repairs',
    };
  }

  if (input.unfinished) {
    if (input.unfinishedCount >= 2) {
      return {
        action: 'ask',
        ask: buildAskPayload('stuck_unfinished'),
        reason: 'stuck_unfinished',
      };
    }
    return {
      action: 'continue',
      prompt: buildContinuePrompt(input.unfinishedReason),
      reason: input.unfinishedReason || 'unfinished',
    };
  }

  if (input.judge == null) return { action: 'judge', reason: 'need_judge' };

  if (!input.judge.pass) {
    return {
      action: 'repair',
      issues: input.judge.issues,
      prompt: buildContinuePrompt('judge_fail', input.judge.issues),
      reason: 'judge_fail',
    };
  }

  return { action: 'skip', reason: 'judge_pass' };
};

const getMessages = (host: SitesAutoContinueHost, context: ConversationContext): UIChatMessage[] => {
  const key = messageMapKey(context);
  return host.messagesMap?.[key] || host.dbMessagesMap?.[key] || [];
};

const lastAssistant = (messages: UIChatMessage[]) =>
  [...messages].reverse().find((message) => message.role === 'assistant');

const readAgentBits = async (agentId: string, deps?: SitesAutoContinueDeps) => {
  if (deps?.plugins || deps?.chatConfig || deps?.inboxAgentId || deps?.slug) {
    return {
      chatConfig: deps.chatConfig,
      inboxAgentId: deps.inboxAgentId,
      plugins: deps.plugins || [],
      slug: deps.slug,
    };
  }
  try {
    const { getAgentStoreState } = await import('@/store/agent');
    const { agentSelectors, builtinAgentSelectors } = await import('@/store/agent/selectors');
    const state = getAgentStoreState();
    const config = agentSelectors.getAgentConfigById(agentId)(state);
    return {
      chatConfig: config?.chatConfig,
      inboxAgentId: builtinAgentSelectors.inboxAgentId(state),
      plugins: config?.plugins || [],
      slug: agentSelectors.getAgentSlugById(agentId)(state),
    };
  } catch {
    return { chatConfig: undefined, inboxAgentId: undefined, plugins: [] as string[], slug: undefined };
  }
};

export const defaultFetchTopicSpend = async (
  sessionId: string,
  topicId: string,
): Promise<SitesTopicSpend> => {
  const res = await fetch(
    `/chat/api/arckep/topic-spend?session_id=${encodeURIComponent(sessionId)}&topic_id=${encodeURIComponent(topicId)}`,
    { cache: 'no-store' },
  );
  if (!res.ok) throw new Error(`topic-spend ${res.status}`);
  return (await res.json()) as SitesTopicSpend;
};

const defaultJudge = async (html: string, assistantText: string): Promise<SitesJudgeResult> => {
  const clippedHtml = html.slice(0, 8000);
  const clippedText = assistantText.slice(0, 1500);
  const userContent = [
    'Проверь черновик лендинга по короткому списку. Ответь ТОЛЬКО JSON вида {"pass":true,"issues":[]} или {"pass":false,"issues":["..."]}.',
    'issues — по-русски, коротко, по делу.',
    'Чеклист:',
    '1. Страница открывается: есть html или body, не пусто.',
    '2. Есть заголовок (h1 или h2).',
    '3. Есть контакты (телефон, почта, форма, telegram или адрес).',
    '4. Картинки не заглушки (нет placeholder, lorem, пустой src).',
    '',
    'HTML:',
    clippedHtml,
    '',
    'Текст агента:',
    clippedText,
  ].join('\n');

  let text = '';
  const { chatService } = await import('@/services/chat');
  await chatService.fetchPresetTaskResult({
    onFinish: async (full) => {
      if (full) text = full;
    },
    onMessageHandle: (chunk) => {
      if (chunk.type === 'text') text += chunk.text || '';
    },
    params: {
      messages: [{ content: userContent, role: 'user' }],
      model: SITES_AUTO_CONTINUE_JUDGE_MODEL,
      provider: SITES_AUTO_CONTINUE_JUDGE_PROVIDER,
      stream: false,
      temperature: 0,
    },
  });

  return parseJudgeResult(text);
};

const heuristicJudge = (html: string): SitesJudgeResult => {
  const issues: string[] = [];
  if (!/<html[\s>]|<body[\s>]/i.test(html) && html.length < 80) {
    issues.push('Страница пустая — нет нормальной вёрстки.');
  }
  if (!/<h[12][\s>]/i.test(html)) issues.push('Нет заголовка.');
  if (!CONTACT_RE.test(html)) issues.push('Нет контактов.');
  if (PLACEHOLDER_IMG_RE.test(html) || /src=["']\s*["']/i.test(html)) {
    issues.push('Картинки похожи на заглушки.');
  }
  return { issues, pass: issues.length === 0 };
};

const runHiddenContinue = async (
  host: SitesAutoContinueHost,
  context: ConversationContext,
  messages: UIChatMessage[],
  prompt: string,
) => {
  const parent = lastAssistant(messages);
  if (!parent) return;

  const synthetic: UIChatMessage = {
    content: prompt,
    createdAt: Date.now(),
    id: `tmp_sites_cont_${nanoid()}`,
    metadata: { arckepSitesAutoContinue: true, hidden: true },
    role: 'user',
    updatedAt: Date.now(),
  } as UIChatMessage;

  await host.internal_execAgentRuntime({
    context,
    messages: [...messages, synthetic],
    parentMessageId: parent.id,
    parentMessageType: 'assistant',
  });
};

const runAskUserQuestion = async (
  host: SitesAutoContinueHost,
  context: ConversationContext,
  messages: UIChatMessage[],
  ask: SitesAskPayload,
) => {
  if (!host.optimisticCreateMessage) return;
  const parent = lastAssistant(messages);
  if (!parent) return;

  const questionId = nanoid();
  const args = {
    question: {
      description: ask.description,
      fields: [
        {
          key: 'next',
          kind: 'select' as const,
          label: 'Что делаем',
          options: ask.options,
          required: true,
        },
      ],
      id: questionId,
      mode: 'form' as const,
      prompt: ask.prompt,
    },
  };

  await host.optimisticCreateMessage({
    agentId: context.agentId,
    content: '',
    parentId: parent.id,
    plugin: {
      apiName: ASK_USER_QUESTION_API,
      arguments: JSON.stringify(args),
      identifier: USER_INTERACTION_ID,
      intervention: { status: 'pending' },
      type: 'builtin',
    },
    pluginIntervention: { status: 'pending' },
    role: 'tool',
    threadId: context.threadId ?? undefined,
    tool_call_id: `call_${nanoid()}`,
    topicId: context.topicId ?? undefined,
  });
};

const withTrayHint = async <T>(
  host: SitesAutoContinueHost,
  context: ConversationContext,
  hint: string,
  run: () => Promise<T>,
): Promise<T> => {
  const started = host.startOperation?.({
    context: {
      agentId: context.agentId,
      threadId: context.threadId,
      topicId: context.topicId ?? undefined,
    },
    label: hint,
    metadata: { trayHint: hint },
    type: 'continue',
  });
  try {
    return await run();
  } finally {
    if (started?.operationId) host.completeOperation?.(started.operationId);
  }
};

/**
 * After a successful site-building turn: cheap self-check and hidden continue.
 * Does not resend the original user message.
 */
export const maybeSitesAutoContinue = async (
  get: () => SitesAutoContinueHost,
  context: ConversationContext,
  deps?: SitesAutoContinueDeps,
): Promise<SitesAutoContinueResult> => {
  const bits = await readAgentBits(context.agentId, deps);
  const enabled =
    typeof deps?.enabled === 'boolean' ? deps.enabled : isSitesAutoContinueEnabled(bits.chatConfig);

  if (!enabled) return { action: 'skip', reason: 'flag_off' };
  if (context.groupId) return { action: 'skip', reason: 'group' };
  const topicId = context.topicId;
  if (!topicId) return { action: 'skip', reason: 'no_topic' };

  const eligible = isEligibleSitesAgent({
    agentId: context.agentId,
    inboxAgentId: bits.inboxAgentId,
    plugins: bits.plugins,
    slug: bits.slug,
  });
  if (!eligible) return { action: 'skip', reason: 'not_eligible' };

  const key = topicRunKey(context.agentId, topicId);
  const state = getTopicRunState(key);
  if (state.asked) return { action: 'skip', reason: 'already_asked' };

  const sessionId =
    deps?.sessionId ?? (await import('@/store/session')).getSessionStoreState().activeId;
  if (!sessionId) return { action: 'skip', reason: 'no_session' };

  const fetchSpend = deps?.fetchSpend ?? defaultFetchTopicSpend;
  const judgeFn = deps?.judge ?? defaultJudge;

  for (let round = 0; round < 6; round += 1) {
    const host = get();
    const messages = getMessages(host, context);
    const last = lastAssistant(messages);
    if (!last || last.content === LOADING_FLAT || last.content === MESSAGE_CANCEL_FLAT) {
      return { action: 'skip', reason: 'no_assistant' };
    }

    let spend: SitesTopicSpend;
    try {
      spend = await fetchSpend(sessionId, topicId);
    } catch {
      return { action: 'skip', reason: 'spend_unknown' };
    }

    const unfinishedInfo = looksUnfinished(messages);
    const facts = {
      eligible: true,
      enabled: true,
      hasPendingIntervention: hasPendingIntervention(messages),
      hasTopic: true,
      isGroup: false,
      isSiteRun: detectSiteRun(messages),
      judge: null as SitesJudgeResult | null,
      maxRepairs: SITES_AUTO_CONTINUE_MAX_REPAIRS,
      repairCount: state.repairCount,
      spendCapRub: SITES_AUTO_CONTINUE_SPEND_CAP_RUB,
      spendLabeled: spend.labeled,
      spendRub: spend.cost_rub,
      unfinished: unfinishedInfo.unfinished,
      unfinishedCount: state.unfinishedCount,
      unfinishedReason: unfinishedInfo.reason,
    };

    let decision = decideSitesAutoContinue(facts);

    if (decision.action === 'judge') {
      const html = extractHtmlArtifact(messages);
      if (!html) return { action: 'skip', reason: 'no_html' };

      const assistantText = [last.content, ...(last.children?.map((c) => c.content || '') ?? [])].join(
        '\n',
      );
      try {
        facts.judge = await withTrayHint(host, context, 'проверка сайта…', () =>
          judgeFn(html, assistantText),
        );
      } catch {
        facts.judge = heuristicJudge(html);
      }
      decision = decideSitesAutoContinue(facts);
    }

    if (decision.action === 'skip') return { action: 'skip', reason: decision.reason };

    if (decision.action === 'ask' && decision.ask) {
      state.asked = true;
      await runAskUserQuestion(host, context, messages, decision.ask);
      return { action: 'ask', reason: decision.reason };
    }

    if (decision.action === 'continue' || decision.action === 'repair') {
      if (decision.action === 'repair') state.repairCount += 1;
      else state.unfinishedCount += 1;

      const prompt = decision.prompt || buildContinuePrompt(decision.reason, decision.issues);
      await withTrayHint(host, context, 'доделываю сайт…', () =>
        runHiddenContinue(host, context, messages, prompt),
      );
      continue;
    }

    return { action: 'skip', reason: decision.reason };
  }

  return { action: 'skip', reason: 'max_rounds' };
};
