import { describe, expect, it, vi } from 'vitest';

import { LayoutRenderError, renderLayout } from '../render';

// arckep (19.10.2026): вызов отрисовки бэкенда студии (POST /api/chat/layout-render) с подменённым fetch.

const okBody = {
  elapsed_ms: 2300,
  failed_images: [{ origin: 'external', reason: 'not_https', url: 'http://x/a.png' }],
  height: 1200,
  images: [{ h: 50, loaded: true, src: 'https://arckep.ru/chat/f/file_A/', w: 100, x: 0, y: 10 }],
  lines: [{ found: true, font_size: 20, font_weight: '400', h: 24, text: 'Привет', x: 20, y: 40 }],
  scroll_width: 600,
  screenshot_jpeg_base64: '/9j/AA==',
  width: 600,
};

const reply = (status: number, body: unknown) =>
  vi.fn(
    async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
  );

const params = {
  html: '<p>Привет</p>',
  lines: ['Привет', 'x'.repeat(100)],
  messageId: 'msg_1',
  topicId: 'tpc_1',
  userId: 15,
  width: 600,
};

describe('renderLayout: вызов бэкенда студии', () => {
  it('адрес, служебный ключ, тело запроса: user_id, html, width, строки до 60 знаков, тема и сообщение', async () => {
    const fetch = reply(200, okBody);
    const result = await renderLayout(params, {
      baseUrl: 'http://127.0.0.1:8202',
      fetch,
      token: 'secret-key',
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8202/api/chat/layout-render');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/json',
      'X-Arckep-Token': 'secret-key',
    });
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      html: '<p>Привет</p>',
      message_id: 'msg_1',
      topic_id: 'tpc_1',
      user_id: 15,
      width: 600,
    });
    expect(body.lines).toEqual(['Привет', 'x'.repeat(60)]);

    expect(result.height).toBe(1200);
    expect(result.lines[0].found).toBe(true);
    expect(result.failed_images).toHaveLength(1);
  });

  it('429 «слишком часто» и 429 «уже идут две» — разные виды ошибки', async () => {
    const rate = await renderLayout(params, {
      fetch: reply(429, { detail: 'Layout render rate limit exceeded' }),
      token: 't',
    }).catch((error) => error);
    expect(rate).toBeInstanceOf(LayoutRenderError);
    expect(rate).toMatchObject({ kind: 'rate_limit', status: 429 });
    expect(rate.message).toMatch(/60 в час/);

    const busy = await renderLayout(params, {
      fetch: reply(429, { detail: 'Too many concurrent layout renders' }),
      token: 't',
    }).catch((error) => error);
    expect(busy).toMatchObject({ kind: 'busy', status: 429 });
    expect(busy.message).toMatch(/две отрисовки/);
  });

  it('502 — «недоступна», 413 — «слишком большой», остальные коды — «ошибка»', async () => {
    await expect(
      renderLayout(params, { fetch: reply(502, { detail: 'Layout render failed' }), token: 't' }),
    ).rejects.toMatchObject({ kind: 'unavailable', status: 502 });
    await expect(
      renderLayout(params, { fetch: reply(413, { detail: 'big' }), token: 't' }),
    ).rejects.toMatchObject({ kind: 'too_large', status: 413 });
    await expect(
      renderLayout(params, { fetch: reply(422, { detail: [{ msg: 'too long' }] }), token: 't' }),
    ).rejects.toMatchObject({ kind: 'too_large', status: 422 });
    await expect(
      renderLayout(params, { fetch: reply(500, 'boom'), token: 't' }),
    ).rejects.toMatchObject({ kind: 'failed', status: 500 });
    await expect(
      renderLayout(params, { fetch: reply(403, { detail: 'no' }), token: 't' }),
    ).rejects.toMatchObject({ kind: 'failed', status: 403 });
  });

  it('сеть оборвалась или тайм-аут — «недоступна», не исключение сети', async () => {
    const fetch = vi.fn(async () => {
      throw new Error('socket hang up');
    });
    const error = await renderLayout(params, { fetch, token: 't' }).catch((e) => e);
    expect(error).toBeInstanceOf(LayoutRenderError);
    expect(error.kind).toBe('unavailable');
    expect(error.message).toContain('socket hang up');
  });

  it('битый ответ (не JSON, нет полей) — «ошибка», а не падение сравнения', async () => {
    await expect(
      renderLayout(params, { fetch: reply(200, 'не json'), token: 't' }),
    ).rejects.toMatchObject({ kind: 'failed' });
    await expect(
      renderLayout(params, { fetch: reply(200, { width: 600 }), token: 't' }),
    ).rejects.toMatchObject({ kind: 'failed' });
  });

  it('нет служебного ключа — ошибка до запроса', async () => {
    const saved = [process.env.ARCKEP_INTERNAL_TOKEN, process.env.LOBECHAT_BACKEND_KEY];
    delete process.env.ARCKEP_INTERNAL_TOKEN;
    delete process.env.LOBECHAT_BACKEND_KEY;
    try {
      const fetch = reply(200, okBody);
      await expect(renderLayout(params, { fetch })).rejects.toMatchObject({ kind: 'failed' });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      if (saved[0] !== undefined) process.env.ARCKEP_INTERNAL_TOKEN = saved[0];
      if (saved[1] !== undefined) process.env.LOBECHAT_BACKEND_KEY = saved[1];
    }
  });

  it('ключ берётся из LOBECHAT_BACKEND_KEY, адрес — из IMAGE_STUDIO_API_URL', async () => {
    const saved = {
      internal: process.env.ARCKEP_INTERNAL_TOKEN,
      key: process.env.LOBECHAT_BACKEND_KEY,
      url: process.env.IMAGE_STUDIO_API_URL,
    };
    delete process.env.ARCKEP_INTERNAL_TOKEN;
    process.env.LOBECHAT_BACKEND_KEY = 'backend-key';
    process.env.IMAGE_STUDIO_API_URL = 'http://studio.local:9000/';
    try {
      const fetch = reply(200, okBody);
      await renderLayout(params, { fetch });
      const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe('http://studio.local:9000/api/chat/layout-render');
      expect((init.headers as Record<string, string>)['X-Arckep-Token']).toBe('backend-key');
    } finally {
      for (const [name, value] of [
        ['ARCKEP_INTERNAL_TOKEN', saved.internal],
        ['LOBECHAT_BACKEND_KEY', saved.key],
        ['IMAGE_STUDIO_API_URL', saved.url],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});
