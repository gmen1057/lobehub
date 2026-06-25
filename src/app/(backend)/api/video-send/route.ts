/**
 * Internal server-to-server route for pushing completed videos to a Telegram chat.
 *
 * Called by the arckep FastAPI backend (video_polling_service._send_telegram_video)
 * over loopback with a SHARED INTERNAL SECRET (no cookie). The bot token never leaves
 * LobeChat — arckep passes only platform+application_id, and this route resolves the
 * encrypted token locally, then calls the Telegram Bot API sendVideo.
 */
import { timingSafeEqual } from 'node:crypto';

import { type NextRequest } from 'next/server';

import { getServerDB } from '@/database/core/db-adaptor';
import { AgentBotProviderModel } from '@/database/models/agentBotProvider';
import { KeyVaultsGateKeeper } from '@/server/modules/KeyVaultsEncrypt';
import { TelegramApi } from '@/server/services/bot/platforms/telegram/api';

const getSharedSecret = () => process.env.ARCKEP_INTERNAL_TOKEN || process.env.LOBECHAT_BACKEND_KEY;

const constantTimeEqual = (a: string, b: string): boolean => {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
};

export async function POST(req: NextRequest) {
  const secret = getSharedSecret();
  if (!secret) {
    return Response.json({ error: 'Internal token not configured' }, { status: 500 });
  }

  const provided = req.headers.get('x-arckep-token');
  if (!provided || !constantTimeEqual(provided, secret)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: {
    application_id?: unknown;
    caption?: unknown;
    chat_id?: unknown;
    platform?: unknown;
    video_url?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: 'Bad JSON' }, { status: 400 });
  }

  const { platform, application_id, chat_id, video_url, caption } = body;
  if (typeof platform !== 'string' || !platform) {
    return Response.json({ error: 'platform is required' }, { status: 400 });
  }
  if (typeof application_id !== 'string' || !application_id) {
    return Response.json({ error: 'application_id is required' }, { status: 400 });
  }
  if (typeof chat_id !== 'string' || !chat_id) {
    return Response.json({ error: 'chat_id is required' }, { status: 400 });
  }
  if (typeof video_url !== 'string' || !video_url) {
    return Response.json({ error: 'video_url is required' }, { status: 400 });
  }

  try {
    const db = await getServerDB();
    const row = await AgentBotProviderModel.findByPlatformAndAppId(db, platform, application_id);
    if (!row?.credentials) {
      return Response.json({ error: 'Bot provider not found' }, { status: 404 });
    }

    const gateKeeper = await KeyVaultsGateKeeper.initWithEnvKey();
    let credentials: Record<string, string>;
    try {
      credentials = JSON.parse((await gateKeeper.decrypt(row.credentials)).plaintext);
    } catch {
      credentials = JSON.parse(row.credentials);
    }

    if (!credentials.botToken) {
      return Response.json({ error: 'Bot token not found' }, { status: 404 });
    }

    const telegram = new TelegramApi(credentials.botToken);
    await telegram.sendVideo(chat_id, video_url, typeof caption === 'string' ? caption : undefined);

    return Response.json({ ok: true });
  } catch (error) {
    console.error('[video-send] failed:', error);
    return Response.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 502 },
    );
  }
}
