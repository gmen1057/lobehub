import { type BuiltinServerRuntimeOutput } from '@lobechat/types';

import {
  type ConnectTelegramResult,
  type DesignBriefResult,
  type EditSiteParams,
  type EditSiteResult,
  type GenerateImageParams,
  type GenerateImageResult,
  type GetDesignBriefParams,
  type ListStylesResult,
  type ReadSiteParams,
  type SiteSummary,
} from '../types';

interface ArckepSitesRuntimeDeps {
  connectTelegram: () => Promise<ConnectTelegramResult>;
  editSite: (params: EditSiteParams) => Promise<EditSiteResult>;
  generateImage: (params: GenerateImageParams) => Promise<GenerateImageResult>;
  getDesignBrief: (params: GetDesignBriefParams) => Promise<DesignBriefResult>;
  listSites: () => Promise<SiteSummary[]>;
  listStyles: () => Promise<ListStylesResult>;
  readSite: (siteId: number) => Promise<{
    data_contract?: Record<string, any> | null;
    html: string;
    http_auth_enabled?: boolean;
    site_id: number;
    site_kind?: string | null;
    slug: string;
  }>;
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
      // Surface data_contract/http_auth so the model can act on them — without
      // this, the dashboard columns-diff-before-republish flow in <dashboard>
      // has nothing to compare against (the HTML alone doesn't carry it).
      const extraNote = [
        result.data_contract
          ? `data-contract сайта (site_kind="${result.site_kind ?? 'unknown'}"): ${JSON.stringify(result.data_contract)}.` +
            (result.site_kind === 'dashboard'
              ? ' Это дашборд: перед пересборкой сравните columns с колонками новых данных — при расхождении не публикуйте молча, спросите пользователя.'
              : '')
          : null,
        result.http_auth_enabled
          ? 'Сайт защищён HTTP-паролем (логин/пароль не раскрывайте повторно).'
          : null,
      ]
        .filter(Boolean)
        .join(' ');

      return {
        content:
          `Текущий HTML сайта ${result.slug} (site_id=${result.site_id}). ` +
          `Правки делайте на основе ЭТОГО документа, футер data-arckep-footer сохраняйте:\n\n` +
          '```html\n' +
          result.html +
          '\n```' +
          (extraNote ? `\n\n${extraNote}` : ''),
        state: {
          data_contract: result.data_contract,
          site_id: result.site_id,
          site_kind: result.site_kind,
          slug: result.slug,
        },
        success: true,
      };
    } catch (error) {
      return {
        content: `Не удалось прочитать сайт: ${(error as Error).message}`,
        success: false,
      };
    }
  }

  async editSite(args: EditSiteParams): Promise<BuiltinServerRuntimeOutput> {
    try {
      if (!args.site_id || !Array.isArray(args.replacements) || args.replacements.length === 0) {
        return {
          content: 'editSite: нужны site_id и непустой replacements (find/replace).',
          success: false,
        };
      }
      const result = await this.deps.editSite(args);
      const lines = result.applied.map(
        (a) =>
          `• «${a.find.slice(0, 60)}${a.find.length > 60 ? '…' : ''}» → «${a.replace.slice(0, 60)}${a.replace.length > 60 ? '…' : ''}» (${a.count}×${a.replace_all ? ', all' : ''})`,
      );
      return {
        content:
          `Точечная правка опубликована. Сайт: ${result.url}\n` +
          `Версия: ${result.version}. site_id=${result.site_id} (${result.slug}).\n` +
          `Применено:\n${lines.join('\n')}\n` +
          `Пользователю: изменения уже в интернете — полную пересборку HTML в чат выкладывать не нужно.`,
        state: result,
        success: true,
      };
    } catch (error) {
      return {
        content:
          `Не удалось применить точечную правку: ${(error as Error).message}. ` +
          `Если «not found» — вызовите readSite и скопируйте точную подстроку. ` +
          `Если «matched N times» — удлините find или поставьте replace_all=true.`,
        success: false,
      };
    }
  }

  async generateImage(args: GenerateImageParams): Promise<BuiltinServerRuntimeOutput> {
    try {
      const result = await this.deps.generateImage(args);
      return {
        // Markdown image so the user sees the result in chat (not only a bare URL).
        // Landing agents can still copy result.url into <img src>.
        content:
          `Изображение сгенерировано (Nano Banana).\n\n` +
          `![generated](${result.url})\n\n` +
          `URL: ${result.url}\n` +
          `Стоимость: ${result.cost} ₽. Баланс: ${result.balance} ₽.\n` +
          `Для лендинга: вставьте URL в <img src="..."> или CSS background-image.`,
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
            `Для лендинга пока можно CSS (градиент / цветной блок) вместо фото.`,
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
          emoji: result.emoji,
          name: result.name,
          palette: result.palette,
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

  async listStyles(): Promise<BuiltinServerRuntimeOutput> {
    try {
      const result = await this.deps.listStyles();
      const names = result.styles.map((s) => `«${s.name}» (style_id="${s.id}")`).join(', ');
      return {
        content:
          `Каталог стилей показан пользователю интерактивной галереей (карточки с палитрами ` +
          `и кнопками выбора). Доступны: ${names}. НЕ перечисляйте стили текстом — одной ` +
          `фразой предложите выбрать карточкой или описать желаемое настроение словами.`,
        state: { styles: result.styles },
        success: true,
      };
    } catch (error) {
      return {
        content: `Не удалось получить каталог стилей: ${(error as Error).message}`,
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
