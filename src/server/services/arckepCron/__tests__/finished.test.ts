import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type ArckepCronFinishedPayload,
  notifyCronFinished,
  resolveFinishStatus,
} from '../finished';

// arckep (19.10.2026, задачи помощника по расписанию): сообщение студии об окончании запуска.

const payload: ArckepCronFinishedPayload = {
  cronJobId: 'cron_1',
  operationId: 'op_1',
  runId: 'run-1',
  status: 'done',
  topicId: 'tpc_1',
};

describe('resolveFinishStatus', () => {
  it('done', () => {
    expect(resolveFinishStatus({ reason: 'done', status: 'done' })).toEqual({ status: 'done' });
  });

  it('error — с текстом из события', () => {
    expect(
      resolveFinishStatus({ errorMessage: 'Rate limit exceeded', reason: 'error', status: 'error' }),
    ).toEqual({ error: 'Rate limit exceeded', status: 'error' });
  });

  it('error без текста — общий текст; объект errorDetail превращается в строку', () => {
    expect(resolveFinishStatus({ reason: 'error' })).toEqual({
      error: 'Agent run failed',
      status: 'error',
    });
    expect(
      resolveFinishStatus({ errorDetail: { code: 429 }, errorMessage: '', reason: 'error' }),
    ).toEqual({ error: '{"code":429}', status: 'error' });
  });

  it('длинная ошибка обрезается до 1000 знаков', () => {
    const { error } = resolveFinishStatus({ errorMessage: 'x'.repeat(5000), reason: 'error' });
    expect(error).toHaveLength(1000);
  });

  it('interrupted — без текста', () => {
    expect(resolveFinishStatus({ reason: 'interrupted' })).toEqual({ status: 'interrupted' });
  });

  it.each(['max_steps', 'cost_limit', 'waiting_for_human'])(
    '%s — interrupted с причиной в error',
    (reason) => {
      expect(resolveFinishStatus({ reason })).toEqual({
        error: `Stopped: ${reason}`,
        status: 'interrupted',
      });
    },
  );

  it('без reason берёт status', () => {
    expect(resolveFinishStatus({ status: 'error', errorMessage: 'boom' })).toEqual({
      error: 'boom',
      status: 'error',
    });
  });
});

describe('notifyCronFinished', () => {
  const ok = () => new Response('{}', { status: 200 });

  beforeEach(() => {
    vi.stubEnv('IMAGE_STUDIO_API_URL', '');
    vi.stubEnv('ARCKEP_INTERNAL_TOKEN', 'tok-internal');
    vi.stubEnv('LOBECHAT_BACKEND_KEY', '');
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('POST в студию с ключом и телом по контракту', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok());

    const delivered = await notifyCronFinished(payload, { fetchImpl });

    expect(delivered).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8202/api/internal/chat-tasks/finished');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json', 'X-Arckep-Token': 'tok-internal' });
    expect(JSON.parse(init.body)).toEqual({
      cronJobId: 'cron_1',
      operationId: 'op_1',
      runId: 'run-1',
      status: 'done',
      topicId: 'tpc_1',
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('адрес студии из IMAGE_STUDIO_API_URL, ключ запасной — LOBECHAT_BACKEND_KEY', async () => {
    vi.stubEnv('IMAGE_STUDIO_API_URL', 'http://studio.internal:9000/');
    vi.stubEnv('ARCKEP_INTERNAL_TOKEN', '');
    vi.stubEnv('LOBECHAT_BACKEND_KEY', 'tok-backend');
    const fetchImpl = vi.fn().mockResolvedValue(ok());

    await notifyCronFinished({ ...payload, error: 'boom', status: 'error' }, { fetchImpl });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://studio.internal:9000/api/internal/chat-tasks/finished');
    expect(init.headers['X-Arckep-Token']).toBe('tok-backend');
    expect(JSON.parse(init.body)).toMatchObject({ error: 'boom', status: 'error' });
  });

  it('5xx и сетевая ошибка повторяются, потом успех', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 502 }))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(ok());

    const delivered = await notifyCronFinished(payload, { fetchImpl, retryPauseMs: 0 });

    expect(delivered).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('три неудачи — сдаётся, не бросает и возвращает false', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('timeout'));

    await expect(notifyCronFinished(payload, { fetchImpl, retryPauseMs: 0 })).resolves.toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('4xx (кроме 408 и 429) не повторяется', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status: 404 }));

    await expect(notifyCronFinished(payload, { fetchImpl, retryPauseMs: 0 })).resolves.toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('429 повторяется', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockResolvedValueOnce(ok());

    await expect(notifyCronFinished(payload, { fetchImpl, retryPauseMs: 0 })).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('без ключа не ходит в студию', async () => {
    vi.stubEnv('ARCKEP_INTERNAL_TOKEN', '');
    const fetchImpl = vi.fn();

    await expect(notifyCronFinished(payload, { fetchImpl })).resolves.toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
