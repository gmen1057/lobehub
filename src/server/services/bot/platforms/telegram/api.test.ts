import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TelegramApi } from './api';

// Mock global fetch — TelegramApi.call() POSTs to https://api.telegram.org/bot<token>/<method>.
const okResponse = (messageId = 1) => ({
  ok: true,
  status: 200,
  json: async () => ({ ok: true, result: { message_id: messageId } }),
});

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(okResponse());
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const lastCall = () => {
  const [url, init] = fetchMock.mock.calls.at(-1)!;
  return { body: JSON.parse((init as { body: string }).body), url: url as string };
};

describe('TelegramApi media methods', () => {
  it('sendPhoto targets sendPhoto with chat_id + photo + HTML caption', async () => {
    const api = new TelegramApi('TOKEN');
    const r = await api.sendPhoto('chat-1', 'https://x/y.png', 'hi');
    const { url, body } = lastCall();
    expect(url).toContain('/sendPhoto');
    expect(body).toMatchObject({
      caption: 'hi',
      chat_id: 'chat-1',
      parse_mode: 'HTML',
      photo: 'https://x/y.png',
    });
    expect(r.message_id).toBe(1);
  });

  it('sendVideo uses the video field, never photo (guards copy-paste)', async () => {
    const api = new TelegramApi('TOKEN');
    await api.sendVideo('chat-1', 'https://x/v.mp4', 'cap');
    const { url, body } = lastCall();
    expect(url).toContain('/sendVideo');
    expect(body.video).toBe('https://x/v.mp4');
    expect(body.photo).toBeUndefined();
  });

  it('sendDocument uses the document field', async () => {
    const api = new TelegramApi('TOKEN');
    await api.sendDocument('chat-1', 'https://x/d.pdf');
    const { url, body } = lastCall();
    expect(url).toContain('/sendDocument');
    expect(body.document).toBe('https://x/d.pdf');
  });

  it('omits caption fields when no caption is given', async () => {
    const api = new TelegramApi('TOKEN');
    await api.sendPhoto('chat-1', 'https://x/y.png');
    const { body } = lastCall();
    expect(body.caption).toBeUndefined();
    expect(body.parse_mode).toBeUndefined();
  });

  it('keeps the bot token out of the request body (token lives in the URL path)', async () => {
    const api = new TelegramApi('SECRET-TOKEN');
    await api.sendPhoto('chat-1', 'https://x/y.png', 'hi');
    const { url, body } = lastCall();
    expect(url).toContain('/botSECRET-TOKEN/');
    expect(JSON.stringify(body)).not.toContain('SECRET-TOKEN');
  });
});
