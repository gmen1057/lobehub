import { ArckepStudioApiName, ArckepStudioIdentifier } from '@lobechat/builtin-tool-arckep-studio';
import { arckepLazyToolIds, builtinTools } from '@lobechat/builtin-tools';
import { builtinToolIdentifiers } from '@lobechat/builtin-tools/identifiers';
import { RECOMMENDED_SKILLS } from '@lobechat/const';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type ToolExecutionContext } from '../../types';
import { arckepStudioRuntime, backendErrorMessage } from '../arckepStudio';

const BASE = 'http://127.0.0.1:8202';

/** serverDB stand-in: `select().from().where().limit()` resolves to one users row. */
const dbWithEmail = (email: string | null) =>
  ({
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => (email ? [{ email }] : []) }) }),
    }),
  }) as any;

const makeContext = (email: string | null = 'user42@arckep.ru'): ToolExecutionContext => ({
  serverDB: dbWithEmail(email),
  toolManifestMap: {},
  topicId: 'topic-1',
  userId: 'lobe-user-1',
});

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' }, status });

const completedJob = {
  error: null,
  generation_id: 7,
  model: 'runway-muse-image',
  price_rub: 1.15,
  status: 'completed',
  url: 'https://arckep.ru/api/images/gen/42/a.png',
  urls: ['https://arckep.ru/api/images/gen/42/a.png'],
};

describe('arckepStudioRuntime', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('LOBECHAT_BACKEND_KEY', 'secret-key');
    vi.stubEnv('ARCKEP_INTERNAL_TOKEN', '');
    vi.stubEnv('IMAGE_STUDIO_API_URL', '');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  const runtime = (context = makeContext()) => arckepStudioRuntime.factory(context) as any;
  const sentBody = (call = 0) => JSON.parse(fetchMock.mock.calls[call][1].body);

  describe('registration', () => {
    it('has the identifier and needs a user and a database', () => {
      expect(arckepStudioRuntime.identifier).toBe(ArckepStudioIdentifier);
      expect(ArckepStudioIdentifier).toBe('arckep-studio');
      expect(() => arckepStudioRuntime.factory({ toolManifestMap: {}, userId: 'u' })).toThrow(
        'userId and serverDB are required',
      );
      expect(() =>
        arckepStudioRuntime.factory({ serverDB: {} as any, toolManifestMap: {} }),
      ).toThrow('userId and serverDB are required');
    });

    it('is a lazy builtin tool, installed by default, titled for people', () => {
      const tool = builtinTools.find((t) => t.identifier === ArckepStudioIdentifier);
      expect(tool?.manifest.meta?.title).toBe('Студия Arckep');
      expect(tool?.manifest.api.map((a) => a.name).sort()).toEqual(
        Object.values(ArckepStudioApiName).sort(),
      );
      expect(arckepLazyToolIds).toContain(ArckepStudioIdentifier);
      expect(builtinToolIdentifiers).toContain(ArckepStudioIdentifier);
      expect(RECOMMENDED_SKILLS).toContainEqual({ id: ArckepStudioIdentifier, type: 'builtin' });
    });

    it('never offers the model a user id', () => {
      const tool = builtinTools.find((t) => t.identifier === ArckepStudioIdentifier)!;
      for (const api of tool.manifest.api) {
        expect(Object.keys((api.parameters as any).properties ?? {})).not.toContain('user_id');
      }
    });
  });

  describe('createImage', () => {
    it('calls the studio with the user from the bridge email, never from the model', async () => {
      fetchMock.mockResolvedValue(jsonResponse(completedJob));

      // a model that tries to pass someone else's user_id
      const out = await runtime().createImage({ prompt: 'a red cat', user_id: 7 } as any);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(`${BASE}/api/chat/studio-tool/create-image`);
      expect(init.method).toBe('POST');
      expect(init.headers['X-Arckep-Token']).toBe('secret-key');
      expect(sentBody()).toMatchObject({ prompt: 'a red cat', topic_id: 'topic-1', user_id: 42 });
      expect(out.success).toBe(true);
      expect(out.content).toContain('![generated](https://arckep.ru/api/images/gen/42/a.png)');
      expect(out.content).toContain('1.15 ₽');
      expect(out.state).toMatchObject({ generation_id: 7, status: 'completed' });
    });

    it('waits long enough for the backend (it holds a picture up to ~75 s)', async () => {
      fetchMock.mockResolvedValue(jsonResponse(completedJob));
      const timeout = vi.spyOn(AbortSignal, 'timeout');
      await runtime().createImage({ prompt: 'x' });
      expect(timeout).toHaveBeenCalledWith(120_000);
      timeout.mockRestore();
    });

    it('tells the model a slow job is in progress and must not be created again', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ ...completedJob, status: 'processing', url: null, urls: [] }),
      );
      const out = await runtime().createImage({ prompt: 'sea' });
      expect(out.success).toBe(true);
      expect(out.content).toContain('getImage');
      expect(out.content).toContain('НЕ вызывайте createImage повторно');
      expect(out.content).toContain('generation_id=7');
    });

    it('reports a failed job as unpaid', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          ...completedJob,
          error: 'provider boom',
          price_rub: 0,
          status: 'failed',
          url: null,
          urls: [],
        }),
      );
      const out = await runtime().createImage({ prompt: 'cat' });
      expect(out.success).toBe(false);
      expect(out.content).toContain('provider boom');
      expect(out.content).toContain('Деньги не списаны');
    });

    it('passes the studio message on insufficient balance (402) as is', async () => {
      const message =
        'Недостаточно средств на балансе: нужно 1.15 ₽, доступно 0.00 ₽. Пополнить баланс: https://arckep.ru/settings';
      fetchMock.mockResolvedValue(
        jsonResponse({ detail: { details: {}, error_code: 'INSUFFICIENT_BALANCE', message } }, 402),
      );
      const out = await runtime().createImage({ prompt: 'cat' });
      expect(out.success).toBe(false);
      expect(out.content).toContain(message);
    });

    it('refuses an empty prompt without calling the backend', async () => {
      const out = await runtime().createImage({ prompt: '   ' });
      expect(out.success).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('refuses an account that is not bridged from arckep.ru and calls nothing', async () => {
      const out = await runtime(makeContext('someone@example.com')).createImage({ prompt: 'cat' });
      expect(out.success).toBe(false);
      expect(out.content).toContain('Аккаунт не связан с arckep.ru');
      expect(fetchMock).not.toHaveBeenCalled();

      const none = await runtime(makeContext(null)).createImage({ prompt: 'cat' });
      expect(none.success).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('fails clearly when the internal token is not configured', async () => {
      vi.stubEnv('LOBECHAT_BACKEND_KEY', '');
      const out = await runtime().createImage({ prompt: 'cat' });
      expect(out.success).toBe(false);
      expect(out.content).toContain('Internal token not configured');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('the other actions', () => {
    it('estimateImage asks for the personal price and says when the balance is short', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          allowed: true,
          balance_rub: 0.5,
          discount_pct: 20,
          enough_balance: false,
          is_upper_bound: false,
          issues: [],
          list_price_rub: 2,
          model: 'runway-muse-image',
          params: {},
          price_rub: 1.6,
        }),
      );
      const out = await runtime().estimateImage({ model: 'runway-muse-image', num_images: 1 });
      expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/api/chat/studio-tool/estimate-image`);
      expect(sentBody()).toMatchObject({ model: 'runway-muse-image', user_id: 42 });
      expect(out.success).toBe(true);
      expect(out.content).toContain('1.6 ₽');
      expect(out.content).toContain('скидка 20%');
      expect(out.content).toContain('НЕ хватает');
    });

    it('getImage sends the generation id and shows the finished picture', async () => {
      fetchMock.mockResolvedValue(jsonResponse(completedJob));
      const out = await runtime().getImage({ generation_id: 7 });
      expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/api/chat/studio-tool/get-image`);
      expect(sentBody()).toEqual({ generation_id: 7, user_id: 42 });
      expect(out.success).toBe(true);
      expect(out.content).toContain('![generated]');
      expect((await runtime().getImage({} as any)).success).toBe(false);
    });

    it('listImageModels prints the catalog with the default flagged', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          default_model: 'runway-muse-image',
          models: [
            {
              aspect_ratios: ['1:1', '16:9'],
              id: 'runway-muse-image',
              is_default: true,
              max_images: 1,
              name: 'Muse',
              price_rub: 1.15,
              quality_levels: null,
              resolutions: null,
              supports_thinking: false,
            },
          ],
        }),
      );
      const out = await runtime().listImageModels();
      expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/api/chat/studio-tool/list-models`);
      expect(out.content).toContain('runway-muse-image (по умолчанию)');
      expect(out.content).toContain('1:1, 16:9');
    });

    it('createSpeech waits for the synchronous backend and hands over the link', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          audio_url: 'https://files.example/tts/a.wav',
          charged_from: 'personal',
          model: 'gemini-3.8-flash-lite-tts',
          price_rub: 0.04,
          speech_id: 3,
          status: 'completed',
          voice_id: 'Puck',
        }),
      );
      const timeout = vi.spyOn(AbortSignal, 'timeout');
      const out = await runtime().createSpeech({ text: 'Привет', voice_id: 'Puck' });
      expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/api/chat/studio-tool/create-speech`);
      expect(sentBody()).toMatchObject({
        text: 'Привет',
        topic_id: 'topic-1',
        user_id: 42,
        voice_id: 'Puck',
      });
      expect(timeout).toHaveBeenCalledWith(250_000);
      expect(out.success).toBe(true);
      expect(out.content).toContain('https://files.example/tts/a.wav');
      expect(out.content).toContain('0.04 ₽');
      expect((await runtime().createSpeech({ text: '' })).success).toBe(false);
      timeout.mockRestore();
    });

    it('getBalance reports the balance', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ balance_rub: 42.5, corporate_name: null, is_corporate: false }),
      );
      const out = await runtime().getBalance();
      expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/api/chat/studio-tool/get-balance`);
      expect(sentBody()).toEqual({ user_id: 42 });
      expect(out.content).toContain('42.5 ₽');
    });

    it('honours IMAGE_STUDIO_API_URL', async () => {
      vi.stubEnv('IMAGE_STUDIO_API_URL', 'http://studio.internal:9000/');
      fetchMock.mockResolvedValue(
        jsonResponse({ balance_rub: 1, corporate_name: null, is_corporate: false }),
      );
      await runtime().getBalance();
      expect(fetchMock.mock.calls[0][0]).toBe(
        'http://studio.internal:9000/api/chat/studio-tool/get-balance',
      );
    });
  });
});

describe('backendErrorMessage', () => {
  it('pulls the sentence out of every envelope the studio uses', () => {
    expect(backendErrorMessage(402, JSON.stringify({ detail: { message: 'Мало денег' } }))).toBe(
      'Мало денег',
    );
    expect(backendErrorMessage(400, JSON.stringify({ message: 'Плохая модель' }))).toBe(
      'Плохая модель',
    );
    expect(backendErrorMessage(404, JSON.stringify({ detail: 'Не найдено' }))).toBe('Не найдено');
    expect(
      backendErrorMessage(
        422,
        JSON.stringify({ detail: [{ msg: 'field required' }, { msg: 'bad' }] }),
      ),
    ).toBe('field required; bad');
  });

  it('falls back to a clipped body for anything else', () => {
    expect(backendErrorMessage(502, '<html>bad gateway</html>')).toBe(
      'backend 502: <html>bad gateway</html>',
    );
    expect(backendErrorMessage(500, 'x'.repeat(500))).toBe(`backend 500: ${'x'.repeat(200)}`);
    expect(backendErrorMessage(500, JSON.stringify({ detail: {} }))).toContain('backend 500:');
  });
});
