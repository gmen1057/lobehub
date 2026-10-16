import { type BuiltinServerRuntimeOutput } from '@lobechat/types';

import {
  type BalanceResult,
  type CreateImageParams,
  type CreateSpeechParams,
  type EstimateImageParams,
  type EstimateImageResult,
  type GetImageParams,
  type ImageJobResult,
  type ListImageModelsResult,
  type SpeechResult,
} from '../types';

interface ArckepStudioRuntimeDeps {
  createImage: (params: CreateImageParams) => Promise<ImageJobResult>;
  createSpeech: (params: CreateSpeechParams) => Promise<SpeechResult>;
  estimateImage: (params: EstimateImageParams) => Promise<EstimateImageResult>;
  getBalance: () => Promise<BalanceResult>;
  getImage: (generationId: number) => Promise<ImageJobResult>;
  listImageModels: () => Promise<ListImageModelsResult>;
}

const rub = (value: number) => `${Number(value.toFixed(2))} ₽`;

/**
 * The backend's own message is Russian and says what to do (insufficient balance with the amounts, banned
 * account, unknown model...), so it is passed to the model as is.
 */
const failure = (action: string, error: unknown): BuiltinServerRuntimeOutput => ({
  content: `${action}: ${(error as Error).message}`,
  success: false,
});

/**
 * ArcKep Studio Execution Runtime (server-side only).
 *
 * Data access is injected by src/server/services/toolExecution/serverRuntimes/arckepStudio.ts, which
 * resolves the LobeChat user to an arckep user_id and talks to the image-studio backend over the
 * internal channel (/api/chat/studio-tool/*). Money, history and refunds are the backend's: this class
 * only shapes what the model reads.
 */
export class ArckepStudioExecutionRuntime {
  private deps: ArckepStudioRuntimeDeps;

  constructor(deps: ArckepStudioRuntimeDeps) {
    this.deps = deps;
  }

  async estimateImage(args: EstimateImageParams): Promise<BuiltinServerRuntimeOutput> {
    try {
      const r = await this.deps.estimateImage(args ?? {});
      const discount =
        r.list_price_rub !== null && r.discount_pct > 0
          ? ` (по прайсу ${rub(r.list_price_rub)}, ваша скидка ${r.discount_pct}%)`
          : '';
      const upper = r.is_upper_bound ? ' Это верхняя оценка: итог может быть ниже.' : '';
      const issues =
        r.issues.length > 0
          ? ` Параметры приняты не полностью: ${r.issues.join('; ')}. Студия применит: ${JSON.stringify(r.params)}.`
          : '';
      const balance = r.enough_balance
        ? `Баланс ${rub(r.balance_rub)} — хватает.`
        : `Баланс ${rub(r.balance_rub)} — НЕ хватает, пополнить: https://arckep.ru/settings.`;
      return {
        content:
          `Цена картинки (модель ${r.model}): ${rub(r.price_rub)}${discount}.${upper} ${balance}${issues}\n` +
          `Это только оценка, ничего не списано. Создавать — createImage с теми же параметрами.`,
        state: r,
        success: true,
      };
    } catch (error) {
      return failure('Не удалось посчитать цену', error);
    }
  }

  async createImage(args: CreateImageParams): Promise<BuiltinServerRuntimeOutput> {
    try {
      if (!args?.prompt || !args.prompt.trim()) {
        return { content: 'createImage: нужен непустой prompt.', success: false };
      }
      const r = await this.deps.createImage(args);
      return this.imageOutput(r);
    } catch (error) {
      return failure('Не удалось создать картинку', error);
    }
  }

  async getImage(args: GetImageParams): Promise<BuiltinServerRuntimeOutput> {
    try {
      if (!args?.generation_id) {
        return { content: 'getImage: нужен generation_id из createImage.', success: false };
      }
      const r = await this.deps.getImage(args.generation_id);
      return this.imageOutput(r);
    } catch (error) {
      return failure('Не удалось получить картинку', error);
    }
  }

  async listImageModels(): Promise<BuiltinServerRuntimeOutput> {
    try {
      const r = await this.deps.listImageModels();
      const lines = r.models.map((m) => {
        const extra = [
          m.aspect_ratios?.length ? `форматы: ${m.aspect_ratios.join(', ')}` : null,
          m.resolutions?.length ? `размеры: ${m.resolutions.join(', ')}` : null,
          m.quality_levels?.length ? `качество: ${m.quality_levels.join(', ')}` : null,
          m.max_images && m.max_images > 1 ? `до ${m.max_images} шт.` : null,
        ]
          .filter(Boolean)
          .join('; ');
        return `- ${m.id}${m.is_default ? ' (по умолчанию)' : ''} — от ${rub(m.price_rub)} за картинку${extra ? ` [${extra}]` : ''}`;
      });
      return {
        content:
          `Модели для картинок, от дешёвой к дорогой (цены по прайсу при настройках по умолчанию; ` +
          `точную цену для пользователя даёт estimateImage):\n${lines.join('\n')}`,
        state: r,
        success: true,
      };
    } catch (error) {
      return failure('Не удалось получить список моделей', error);
    }
  }

  async createSpeech(args: CreateSpeechParams): Promise<BuiltinServerRuntimeOutput> {
    try {
      if (!args?.text || !args.text.trim()) {
        return { content: 'createSpeech: нужен непустой text.', success: false };
      }
      const r = await this.deps.createSpeech(args);
      return {
        content:
          `Озвучка готова (голос ${r.voice_id}).\n\n` +
          `Аудио (WAV): ${r.audio_url}\n` +
          `Списано ${rub(r.price_rub)}. Ссылка временная; файл сохранён в «Истории» студии (звук).\n` +
          `Пользователю: дайте ссылку и цену одной фразой.`,
        state: r,
        success: true,
      };
    } catch (error) {
      return failure('Не удалось озвучить текст', error);
    }
  }

  async getBalance(): Promise<BuiltinServerRuntimeOutput> {
    try {
      const r = await this.deps.getBalance();
      const owner = r.is_corporate
        ? ` (счёт организации${r.corporate_name ? ` «${r.corporate_name}»` : ''})`
        : '';
      return {
        content: `Баланс: ${rub(r.balance_rub)}${owner}. Пополнить: https://arckep.ru/settings`,
        state: r,
        success: true,
      };
    } catch (error) {
      return failure('Не удалось получить баланс', error);
    }
  }

  private imageOutput(r: ImageJobResult): BuiltinServerRuntimeOutput {
    if (r.status === 'completed') {
      const pictures = r.urls.map((url) => `![generated](${url})`).join('\n\n');
      return {
        content:
          `Картинка готова (модель ${r.model}, generation_id=${r.generation_id}).\n\n${pictures}\n\n` +
          `URL: ${r.urls.join(' , ')}\n` +
          `Списано ${rub(r.price_rub)}. Картинка сохранена в «Истории» студии.\n` +
          `Пользователю: покажите картинку и назовите цену одной фразой.`,
        state: r,
        success: true,
      };
    }
    if (r.status === 'failed') {
      return {
        content:
          `Картинку сделать не удалось${r.error ? `: ${r.error}` : ''}. Деньги не списаны (удержание возвращено). ` +
          `Скажите об этом пользователю; повторять только если он попросит.`,
        state: r,
        success: false,
      };
    }
    return {
      content:
        `Картинка ещё создаётся (generation_id=${r.generation_id}, статус ${r.status}, ` +
        `удержано ${rub(r.price_rub)}). Скажите пользователю, что она в работе, и через несколько секунд ` +
        `вызовите getImage с этим же generation_id. НЕ вызывайте createImage повторно — это спишет деньги второй раз.`,
      state: r,
      success: true,
    };
  }
}
