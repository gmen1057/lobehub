import debug from 'debug';

import type { RenderResult } from './types';

const log = debug('lobe-server:arckep-layout:render');

/**
 * arckep (19.10.2026): отрисовка письма бэкендом студии — `POST /api/chat/layout-render` (PR студии #695):
 * HTML рисуется в одноразовой песочнице, ответ — места строк макета в письме, места картинок, размер документа и
 * снимок страницы JPEG. Бесплатно для человека; у бэкенда пределы 60 вызовов в час и 2 одновременных на человека.
 * Адрес и служебный ключ — как у остальных `arckep`-инструментов (IMAGE_STUDIO_API_URL, ARCKEP_INTERNAL_TOKEN /
 * LOBECHAT_BACKEND_KEY).
 */

const DEFAULT_BACKEND = 'http://127.0.0.1:8202';
/** Одна отрисовка: песочница поднимается, браузер качает картинки — с запасом, но не дольше этого */
export const RENDER_TIMEOUT_MS = 120_000;

export type RenderErrorKind =
  /** 429 «слишком часто» (60 в час) */
  | 'rate_limit'
  /** 429 «уже идут две отрисовки» */
  | 'busy'
  /** 413 снимок слишком большой */
  | 'too_large'
  /** 502, сеть, тайм-аут */
  | 'unavailable'
  /** остальное: 4xx/5xx, битый ответ, нет ключа */
  | 'failed';

/** Ошибка отрисовки: тип и честный текст для модели. */
export class LayoutRenderError extends Error {
  constructor(
    readonly kind: RenderErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'LayoutRenderError';
  }
}

export interface RenderParams {
  html: string;
  /** Начала строк макета: бэкенд режет каждую до 60 знаков и ищет в письме */
  lines: string[];
  messageId?: string;
  topicId?: string;
  /** Номер человека в студии (не id движка) */
  userId: number;
  /** Ширина окна, px */
  width: number;
}

export interface RenderDeps {
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  token?: string;
}

const backendUrl = () => (process.env.IMAGE_STUDIO_API_URL || DEFAULT_BACKEND).replace(/\/$/, '');
const internalToken = () => process.env.ARCKEP_INTERNAL_TOKEN || process.env.LOBECHAT_BACKEND_KEY;

const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** Ответ бэкенда → проверенная форма (чужого кода тут нет, но битый ответ не должен ронять сравнение). */
const parseResult = (data: unknown): RenderResult | undefined => {
  const value = data as Partial<RenderResult> | null;
  if (!value || typeof value !== 'object') return undefined;
  if (!isNumber(value.width) || !isNumber(value.height) || !isNumber(value.scroll_width)) {
    return undefined;
  }
  if (!Array.isArray(value.lines) || !Array.isArray(value.images)) return undefined;
  return {
    elapsed_ms: isNumber(value.elapsed_ms) ? value.elapsed_ms : undefined,
    failed_images: Array.isArray(value.failed_images) ? value.failed_images : [],
    height: value.height,
    images: value.images,
    lines: value.lines,
    scroll_width: value.scroll_width,
    screenshot_jpeg_base64:
      typeof value.screenshot_jpeg_base64 === 'string' ? value.screenshot_jpeg_base64 : '',
    width: value.width,
  };
};

/** Отрисовать HTML; все сбои — `LayoutRenderError` с понятным типом. Ни один не глотается: журнал с темой и человеком. */
export const renderLayout = async (
  params: RenderParams,
  deps: RenderDeps = {},
): Promise<RenderResult> => {
  const token = deps.token ?? internalToken();
  const context = { topicId: params.topicId, userId: params.userId };
  if (!token) {
    log('render: internal token is not configured %o', context);
    throw new LayoutRenderError('failed', 'не настроен служебный ключ студии');
  }

  let response: Response;
  try {
    response = await (deps.fetch ?? fetch)(
      `${deps.baseUrl ?? backendUrl()}/api/chat/layout-render`,
      {
        body: JSON.stringify({
          html: params.html,
          lines: params.lines.map((line) => line.slice(0, 60)),
          message_id: params.messageId,
          topic_id: params.topicId,
          user_id: params.userId,
          width: params.width,
        }),
        headers: { 'Content-Type': 'application/json', 'X-Arckep-Token': token },
        method: 'POST',
        signal: AbortSignal.timeout(deps.timeoutMs ?? RENDER_TIMEOUT_MS),
      },
    );
  } catch (error) {
    log('render: request failed %o: %s', context, (error as Error).message);
    throw new LayoutRenderError(
      'unavailable',
      `отрисовка не отвечает (${(error as Error).message})`,
    );
  }

  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 200);
    log('render: backend answered %d %o: %s', response.status, context, detail);
    if (response.status === 429) {
      const concurrent = /concurrent/i.test(detail);
      throw new LayoutRenderError(
        concurrent ? 'busy' : 'rate_limit',
        concurrent
          ? 'уже идут две отрисовки, нужно подождать'
          : 'лимит отрисовок исчерпан (60 в час)',
        429,
      );
    }
    if (response.status === 422) {
      throw new LayoutRenderError(
        'too_large',
        'письмо не принято к отрисовке: длиннее 500 000 знаков или окно вне 320–1600 px',
        422,
      );
    }
    if (response.status === 413) {
      throw new LayoutRenderError('too_large', 'снимок страницы слишком большой', 413);
    }
    if (response.status === 502 || response.status === 503 || response.status === 504) {
      throw new LayoutRenderError('unavailable', 'отрисовка сейчас недоступна', response.status);
    }
    throw new LayoutRenderError(
      'failed',
      `отрисовка вернула ошибку ${response.status}`,
      response.status,
    );
  }

  let result: RenderResult | undefined;
  try {
    result = parseResult(await response.json());
  } catch {
    result = undefined;
  }
  if (!result) {
    log('render: unreadable answer %o', context);
    throw new LayoutRenderError('failed', 'ответ отрисовки не разобран');
  }
  return result;
};
