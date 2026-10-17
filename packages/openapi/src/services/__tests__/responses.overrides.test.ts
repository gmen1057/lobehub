import { describe, expect, it, vi } from 'vitest';

import { buildExecOverrides } from '../responses.service';

// Stub external dependencies so ResponsesService can be imported in isolation
vi.mock('@/server/modules/AgentRuntime/InMemoryStreamEventManager', () => ({
  InMemoryStreamEventManager: class {},
}));
vi.mock('@/server/modules/AgentRuntime/StreamEventManager', () => ({}));
vi.mock('@/server/services/agentRuntime', () => ({ AgentRuntimeService: class {} }));
vi.mock('@/server/services/aiAgent', () => ({ AiAgentService: class {} }));
vi.mock('@/database/models/file', () => ({ FileModel: class {} }));
vi.mock('@/server/services/file', () => ({ FileService: class {} }));
vi.mock('../../common/base.service', () => ({
  BaseService: class {
    db: any;
    userId = '';
    constructor() {}
    log() {}
  },
}));

const base = { input: 'привет', model: 'agt_1' } as any;

describe('buildExecOverrides (arckep: настройки одного запроса /responses)', () => {
  it('обычный запрос — без оверрайдов', () => {
    expect(buildExecOverrides(base)).toEqual({});
    expect(buildExecOverrides({ ...base, disabled_tools: [], reasoning: {} })).toEqual({});
  });

  it('модель и провайдер на одно сообщение', () => {
    expect(
      buildExecOverrides({
        ...base,
        model_override: 'gemini-3.6-pro',
        provider_override: 'google',
      }),
    ).toEqual({ model: 'gemini-3.6-pro', provider: 'google' });
  });

  it('reasoning.effort раскладывается по полям chatConfig под все семейства моделей', () => {
    const out = buildExecOverrides({ ...base, reasoning: { effort: 'high' } });
    expect(out.chatConfigOverride).toMatchObject({
      effort: 'high',
      enableReasoning: true,
      enableReasoningEffort: true,
      reasoningBudgetToken: 24_000,
      reasoningEffort: 'high',
      thinking: 'enabled',
      thinkingBudget: 24_000,
      thinkingLevel: 'high',
      thinkingLevel3: 'high',
    });
    expect(out.model).toBeUndefined();
  });

  it('search → searchMode в chatConfig', () => {
    expect(buildExecOverrides({ ...base, search: 'off' })).toEqual({
      chatConfigOverride: { searchMode: 'off' },
    });
  });

  it('temperature и top_p → параметры вызова; ноль тоже значение', () => {
    expect(buildExecOverrides({ ...base, temperature: 0, top_p: 0.9 })).toEqual({
      paramsOverride: { temperature: 0, top_p: 0.9 },
    });
  });

  it('disabled_tools → исключаемые инструменты, пустые строки отбрасываются', () => {
    expect(buildExecOverrides({ ...base, disabled_tools: ['arckep-sites', ''] })).toEqual({
      excludePluginIds: ['arckep-sites'],
    });
  });
});
