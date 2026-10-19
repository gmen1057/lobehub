// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { skillsRuntime } from '../skills';

const mockFindTopic = vi.hoisted(() => vi.fn());
const mockResolveArckepUserId = vi.hoisted(() => vi.fn());

vi.mock('@/database/models/topic', () => ({
  TopicModel: vi.fn(() => ({ findById: mockFindTopic })),
}));
vi.mock('../arckepStudio', () => ({ resolveArckepUserId: mockResolveArckepUserId }));
vi.mock('@/server/services/file/impls', () => ({
  createFileServiceModule: vi.fn().mockImplementation(() => ({})),
}));
vi.mock('@/database/models/user', () => ({
  UserModel: vi.fn(() => ({ getUserSettings: async () => ({}) })),
}));

// arckep (19.10.2026): номер темы приходит от клиента; команды навыков идут в песочницу только своей темы.

const GATEWAY_REPLY = `\u0001ARCKEP_RESULT\u0001${JSON.stringify({ exit: 0, stderr: '', stdout: 'ok' })}`;

const makeRuntime = (topicId = 'tpc_1') =>
  skillsRuntime.factory({ serverDB: {} as any, topicId, userId: 'user_1' } as any) as Promise<any>;

describe('runtime lobe-skills в движке без интерфейса: песочница только своей темы', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('ARCKEP_HEADLESS_TOOLS', '1');
    mockResolveArckepUserId.mockResolvedValue(15);
    mockFindTopic.mockResolvedValue({ id: 'tpc_1' });
    fetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({ jsonrpc: '2.0', result: { content: [{ text: GATEWAY_REPLY }] } }),
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('своя тема: команда идёт в шлюз с темой и номером человека', async () => {
    const runtime = await makeRuntime();
    const result = await runtime.runCommand({ command: 'echo ok' });

    expect(result.success).toBe(true);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.headers).toMatchObject({ 'X-Arckep-Topic': 'tpc_1', 'X-Arckep-User': '15' });
    expect(mockFindTopic).toHaveBeenCalledWith('tpc_1');
  });

  it('чужая тема: шлюз не вызывается, модель получает понятный отказ', async () => {
    mockFindTopic.mockResolvedValue(undefined);
    const runtime = await makeRuntime('tpc_victim');

    const run = await runtime.runCommand({ command: 'ls' });
    const exported = await runtime.exportFile({ filename: 'a.txt', path: 'a.txt' });

    expect(run.success).toBe(false);
    expect(run.content).toContain('only inside your own chat');
    expect(exported.success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('аккаунт не из студии: шлюз не вызывается', async () => {
    mockResolveArckepUserId.mockRejectedValue(new Error('not studio'));
    const result = await (await makeRuntime()).runCommand({ command: 'ls' });
    expect(result.success).toBe(false);
    expect(result.content).toContain('only to Arckep accounts');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
