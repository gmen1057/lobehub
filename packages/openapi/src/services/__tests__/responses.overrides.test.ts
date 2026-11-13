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

  it('reasoning.effort — ступень в chatConfig, перевод в параметр модели делает серверный вызов', () => {
    const out = buildExecOverrides({ ...base, reasoning: { effort: 'xhigh' } });
    expect(out).toEqual({ chatConfigOverride: { arckepReasoningLevel: 'xhigh' } });
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

describe('DeepSeek opt-in response controls', () => {
  it('keeps explicit false values and opaque owned document handles', () => {
    expect(
      buildExecOverrides({
        ...base,
        read_url: true,
        safety_check: false,
        data_guard_protected: true,
        deepseek_document_ids: ['arkdoc_owned'],
      }),
    ).toEqual({
      chatConfigOverride: {
        deepseekReadUrl: true,
        deepseekSafetyCheck: false,
        deepseekDataGuardProtected: true,
      },
      deepseekDocumentIds: ['arkdoc_owned'],
    });
  });
});

it('keeps parsed document display metadata beside replay handles', () => {
  const deepseek_documents = [
    {
      id: 'arkdoc_owned',
      filename: 'report.pdf',
      purpose: 'rich_layout_recognition' as const,
      expires_at: 1800000000,
    },
  ];
  expect(
    buildExecOverrides({ ...base, deepseek_document_ids: ['arkdoc_owned'], deepseek_documents }),
  ).toMatchObject({ deepseekDocumentIds: ['arkdoc_owned'], deepseekDocuments: deepseek_documents });
});
