import { type BuiltinServerRuntimeOutput } from '@lobechat/types';

import {
  type ConnectTelegramResult,
  type DesignBriefResult,
  type GenerateImageParams,
  type GenerateImageResult,
  type GetDesignBriefParams,
  type ReadSiteParams,
  type SiteSummary,
} from '../types';

interface ArckepSitesRuntimeDeps {
  connectTelegram: () => Promise<ConnectTelegramResult>;
  generateImage: (params: GenerateImageParams) => Promise<GenerateImageResult>;
  getDesignBrief: (params: GetDesignBriefParams) => Promise<DesignBriefResult>;
  listSites: () => Promise<SiteSummary[]>;
  readSite: (siteId: number) => Promise<{ html: string; site_id: number; slug: string }>;
}

/**
 * ArcKep Sites Execution Runtime (server-side only).
 *
 * Data access is injected by src/server/services/toolExecution/serverRuntimes/
 * arckepSites.ts, which resolves the LobeChat user to an arckep user_id and
 * talks to the image-studio backend over the internal channel.
 */
export class ArckepSitesExecutionRuntime {
  private deps: ArckepSitesRuntimeDeps;

  constructor(deps: ArckepSitesRuntimeDeps) {
    this.deps = deps;
  }

  async listSites(): Promise<BuiltinServerRuntimeOutput> {
    try {
      const sites = await this.deps.listSites();
      const content =
        sites.length === 0
          ? 'У пользователя пока нет опубликованных сайтов. Предложите собрать лендинг прямо в чате и опубликовать кнопкой на панели артефактов.'
          : JSON.stringify({ sites }, null, 2);
      return { content, state: { sites }, success: true };
    } catch (error) {
      return {
        content: `Не удалось получить список сайтов: ${(error as Error).message}`,
        success: false,
      };
    }
  }

  async readSite(args: ReadSiteParams): Promise<BuiltinServerRuntimeOutput> {
    try {
      const result = await this.deps.readSite(args.site_id);
      return {
        content:
          `Текущий HTML сайта ${result.slug} (site_id=${result.site_id}). ` +
          `Правки делайте на основе ЭТОГО документа, футер data-arckep-footer сохраняйте:\n\n` +
          '```html\n' +
          result.html +
          '\n```',
        state: { site_id: result.site_id, slug: result.slug },
        success: true,
      };
    } catch (error) {
      return {
        content: `Не удалось прочитать сайт: ${(error as Error).message}`,
        success: false,
      };
    }
  }

  async generateImage(args: GenerateImageParams): Promise<BuiltinServerRuntimeOutput> {
    try {
      const result = await this.deps.generateImage(args);
      return {
        content:
          `Изображение сгенерировано. URL: ${result.url}\n` +
          `Стоимость: ${result.cost} ₽. Баланс: ${result.balance} ₽.\n` +
          `Вставьте этот URL в атрибут src тега <img> или в CSS background-image.`,
        state: { balance: result.balance, cost: result.cost, url: result.url },
        success: true,
      };
    } catch (error) {
      const msg = (error as Error).message;
      // Surface insufficient-balance as a clear user-facing message
      if (msg.includes('INSUFFICIENT_BALANCE') || msg.includes('402')) {
        return {
          content:
            `Недостаточно баланса для генерации изображения. Пополните баланс на arckep.ru и повторите. ` +
            `Пока используйте CSS-решение: градиент или цветной блок вместо фото.`,
          success: false,
        };
      }
      return {
        content: `Не удалось сгенерировать изображение: ${msg}`,
        success: false,
      };
    }
  }

  async getDesignBrief(args: GetDesignBriefParams): Promise<BuiltinServerRuntimeOutput> {
    try {
      const result = await this.deps.getDesignBrief(args);
      const alts = result.alternatives
        .map((a) => `${a.emoji} «${a.name}» (style_id="${a.id}") — ${a.tagline}`)
        .join('; ');
      return {
        content:
          `Дизайн-бриф выдан. Стиль: «${result.name}» — ${result.tagline}.\n` +
          `Стройте лендинг СТРОГО по брифу ниже. После артефакта назовите пользователю стиль ` +
          `одной фразой и предложите альтернативы: ${alts}.\n\n${result.brief}`,
        state: {
          alternatives: result.alternatives,
          name: result.name,
          style_id: result.style_id,
          tagline: result.tagline,
        },
        success: true,
      };
    } catch (error) {
      return {
        content:
          `Не удалось получить дизайн-бриф: ${(error as Error).message}. ` +
          `Выберите выразительное направление сами (НЕ дефолтный ИИ-лендинг с фиолетовым ` +
          `градиентом и тремя карточками) и скажите пользователю, какой стиль применили.`,
        success: false,
      };
    }
  }

  async connectTelegram(): Promise<BuiltinServerRuntimeOutput> {
    try {
      const result = await this.deps.connectTelegram();
      const content = result.connected
        ? 'Пользователь уже получает заявки в Telegram.'
        : `Чтобы получать заявки в Telegram, откройте ссылку и нажмите Старт: ${result.url}`;
      return { content, state: result, success: true };
    } catch (error) {
      return {
        content: `Не удалось настроить уведомления в Telegram: ${(error as Error).message}`,
        success: false,
      };
    }
  }
}
