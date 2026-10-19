import { CronApiName, CronIdentifier, CronManifest, systemPrompt } from '@lobechat/builtin-tool-cron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { cronRuntime } from '../cron';

// arckep (19.10.2026): lobe-cron в серверном пути проверяет расписание (5 полей, не чаще раза в 30 минут)
// и ставит пояс по умолчанию Europe/Moscow.

const { mockCreate, mockUpdate } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockUpdate: vi.fn(),
}));

vi.mock('@/database/models/agentCronJob', () => ({
  AgentCronJobModel: vi.fn().mockImplementation(() => ({
    create: mockCreate,
    update: mockUpdate,
  })),
}));

const makeRuntime = () =>
  cronRuntime.factory({
    agentId: 'agt_1',
    serverDB: {} as any,
    toolManifestMap: {},
    userId: 'user-1',
  } as any);

const createArgs = (over: Record<string, unknown> = {}) => ({
  content: 'Собери новости и пришли дайджест',
  cronPattern: '0 9 * * *',
  name: 'Дайджест',
  ...over,
});

describe('cronRuntime (serverRuntimes/cron.ts)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate.mockImplementation(async (data) => ({ id: 'cron_1', ...data }));
    mockUpdate.mockImplementation(async (id, data) => ({ id, name: 'Дайджест', ...data }));
  });

  it('зарегистрирован под идентификатором lobe-cron', () => {
    expect(cronRuntime.identifier).toBe(CronIdentifier);
    expect(CronApiName.createCronJob).toBe('createCronJob');
  });

  it('create без пояса ставит Europe/Moscow', async () => {
    const result = await makeRuntime().createCronJob(createArgs());

    expect(result.success).toBe(true);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agt_1',
        cronPattern: '0 9 * * *',
        timezone: 'Europe/Moscow',
      }),
    );
    expect(result.content).toContain('Europe/Moscow');
  });

  it('после создания модель узнаёт, что задача стартует только после подтверждения человеком', async () => {
    const result = await makeRuntime().createCronJob(createArgs());

    expect(result.content).toContain('only after the person confirms it');
    expect(result.content).toContain('https://arckep.ru/chat/tasks');
    expect(systemPrompt).toContain('does not run until the person confirms it');
    expect(systemPrompt).toContain('https://arckep.ru/chat/tasks');
    const createApi = CronManifest.api.find((api) => api.name === CronApiName.createCronJob);
    expect(createApi?.description).toContain('only after the person confirms');
  });

  it('create сохраняет указанный пояс', async () => {
    await makeRuntime().createCronJob(createArgs({ timezone: 'Asia/Yekaterinburg' }));

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ timezone: 'Asia/Yekaterinburg' }),
    );
  });

  it('create разворачивает макрос в 5 полей', async () => {
    const result = await makeRuntime().createCronJob(createArgs({ cronPattern: '@daily' }));

    expect(result.success).toBe(true);
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ cronPattern: '0 0 * * *' }));
  });

  it.each(['* * * * *', '*/5 * * * *', '0,10 * * * *', '0-59 * * * *'])(
    'create отклоняет шаблон чаще раза в 30 минут: %s',
    async (cronPattern) => {
      const result = await makeRuntime().createCronJob(createArgs({ cronPattern }));

      expect(result.success).toBe(false);
      expect(result.content).toContain('Minimum interval is 30 minutes');
      expect(mockCreate).not.toHaveBeenCalled();
    },
  );

  it.each(['@every 30m', '0 0 9 * * *', '@reboot', 'not a cron'])(
    'create отклоняет не-5-полей: %s',
    async (cronPattern) => {
      const result = await makeRuntime().createCronJob(createArgs({ cronPattern }));

      expect(result.success).toBe(false);
      expect(mockCreate).not.toHaveBeenCalled();
    },
  );

  it('create отклоняет несуществующий пояс', async () => {
    const result = await makeRuntime().createCronJob(createArgs({ timezone: 'Mars/Phobos' }));

    expect(result.success).toBe(false);
    expect(result.content).toContain('Unknown timezone');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('update проверяет новый шаблон и пояс', async () => {
    const bad = await makeRuntime().updateCronJob({ cronPattern: '*/10 * * * *', id: 'cron_1' });
    expect(bad.success).toBe(false);
    expect(bad.content).toContain('Minimum interval is 30 minutes');

    const badZone = await makeRuntime().updateCronJob({ id: 'cron_1', timezone: 'Nowhere/City' });
    expect(badZone.success).toBe(false);
    expect(mockUpdate).not.toHaveBeenCalled();

    const ok = await makeRuntime().updateCronJob({
      cronPattern: '@hourly',
      id: 'cron_1',
      timezone: 'europe/moscow',
    });
    expect(ok.success).toBe(true);
    expect(mockUpdate).toHaveBeenCalledWith('cron_1', {
      cronPattern: '0 * * * *',
      timezone: 'Europe/Moscow',
    });
  });

  it('update без расписания не трогает шаблон и пояс', async () => {
    await makeRuntime().updateCronJob({ enabled: false, id: 'cron_1' });

    expect(mockUpdate).toHaveBeenCalledWith('cron_1', { enabled: false });
  });
});
