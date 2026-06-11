import { type BuiltinServerRuntimeOutput } from '@lobechat/types';

import { type ReadSiteParams, type SiteSummary } from '../types';

interface ArckepSitesRuntimeDeps {
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
}
