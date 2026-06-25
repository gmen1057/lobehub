import { beforeEach, describe, expect, it, vi } from 'vitest';

import { POST } from './route';

const findByPlatformAndAppId = vi.fn();
const sendVideo = vi.fn();
const decrypt = vi.fn();

vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: vi.fn().mockResolvedValue({}),
}));

vi.mock('@/database/models/agentBotProvider', () => ({
  AgentBotProviderModel: {
    findByPlatformAndAppId: (...a: unknown[]) => findByPlatformAndAppId(...a),
  },
}));

vi.mock('@/server/modules/KeyVaultsEncrypt', () => ({
  KeyVaultsGateKeeper: {
    initWithEnvKey: vi.fn().mockResolvedValue({ decrypt: (...a: unknown[]) => decrypt(...a) }),
  },
}));

vi.mock('@/server/services/bot/platforms/telegram/api', () => ({
  TelegramApi: vi
    .fn()
    .mockImplementation(() => ({ sendVideo: (...a: unknown[]) => sendVideo(...a) })),
}));

const SECRET = 'shared-internal-secret';

const VALID_BODY = {
  application_id: 'app-1',
  chat_id: '372730771',
  platform: 'telegram',
  video_url: 'https://s3/v.mp4',
};

const makeReq = (opts: { body?: unknown; secret?: string | null } = {}) => {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (opts.secret) headers.set('x-arckep-token', opts.secret);
  return new Request('http://localhost/chat/api/video-send/', {
    body: JSON.stringify(opts.body ?? VALID_BODY),
    headers,
    method: 'POST',
  }) as never;
};

beforeEach(() => {
  findByPlatformAndAppId.mockReset().mockResolvedValue({ credentials: 'encrypted-blob' });
  sendVideo.mockReset().mockResolvedValue({ message_id: 1 });
  decrypt.mockReset().mockResolvedValue({ plaintext: JSON.stringify({ botToken: 'TKN' }) });
  process.env.LOBECHAT_BACKEND_KEY = SECRET;
  delete process.env.ARCKEP_INTERNAL_TOKEN;
});

describe('video-send POST', () => {
  it('401 when the secret header is missing — no DB lookup', async () => {
    const res = await POST(makeReq({ secret: null }));
    expect(res.status).toBe(401);
    expect(findByPlatformAndAppId).not.toHaveBeenCalled();
  });

  it('401 when the secret is wrong', async () => {
    const res = await POST(makeReq({ secret: 'nope' }));
    expect(res.status).toBe(401);
    expect(findByPlatformAndAppId).not.toHaveBeenCalled();
  });

  it('400 when a required field is missing', async () => {
    const { video_url: _omit, ...noUrl } = VALID_BODY;
    const res = await POST(makeReq({ body: noUrl, secret: SECRET }));
    expect(res.status).toBe(400);
    expect(sendVideo).not.toHaveBeenCalled();
  });

  it('404 when the bot provider is not found', async () => {
    findByPlatformAndAppId.mockResolvedValue(null);
    const res = await POST(makeReq({ secret: SECRET }));
    expect(res.status).toBe(404);
    expect(sendVideo).not.toHaveBeenCalled();
  });

  it('200 and sends the video on a valid authenticated request', async () => {
    const res = await POST(makeReq({ secret: SECRET }));
    expect(res.status).toBe(200);
    expect(findByPlatformAndAppId).toHaveBeenCalledWith({}, 'telegram', 'app-1');
    expect(sendVideo).toHaveBeenCalledWith('372730771', 'https://s3/v.mp4', undefined);
  });
});
