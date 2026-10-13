import { type MetadataRoute } from 'next';

import { LAST_MODIFIED, Sitemap, SitemapType } from '@/server/sitemap';

// Sitemap cache configuration - revalidate every 24 hours
export const revalidate = 86_400; // 24 hours - content page cache
export const dynamic = 'force-static';

export const generateSitemapLink = (url: string) =>
  ['<sitemap>', `<loc>${url}</loc>`, `<lastmod>${LAST_MODIFIED}</lastmod>`, '</sitemap>'].join(
    '\n',
  );

export async function generateSitemaps() {
  const sitemapModule = new Sitemap();
  // Generate dynamic sitemap list, including paginated sitemaps
  const staticSitemaps = sitemapModule.sitemapIndexs;

  // Get page counts for types that need pagination.
  // arckep: the market assistants sitemap is ~3000 static pages that each call the LobeHub
  // market during `next build`. On 2026-10-13 (server load 13-19) every one of them passed
  // Next's 60 s static-generation limit and failed the whole build. chat.arckep.ru is a
  // login-gated app (the entry point is arckep.ru/chat), so these SEO pages are not used.
  // Set SITEMAP_ASSISTANTS=1 at build time to generate them again.
  const [pluginPages, assistantPages, modelPages] = await Promise.all([
    sitemapModule.getPluginPageCount(),
    process.env.SITEMAP_ASSISTANTS === '1' ? sitemapModule.getAssistantPageCount() : 0,
    sitemapModule.getModelPageCount(),
  ]);

  // Generate paginated sitemap ID list
  const paginatedSitemaps = [
    ...Array.from({ length: pluginPages }, (_, i) => ({ id: `plugins-${i + 1}` as SitemapType })),
    ...Array.from({ length: assistantPages }, (_, i) => ({
      id: `assistants-${i + 1}` as SitemapType,
    })),
    ...Array.from({ length: modelPages }, (_, i) => ({ id: `models-${i + 1}` as SitemapType })),
  ];

  return [...staticSitemaps, ...paginatedSitemaps];
}

// Parse paginated ID
export function parsePaginatedId(id: string): { page?: number; type: SitemapType } {
  if (id.includes('-')) {
    const [type, pageStr] = id.split('-');
    const page = parseInt(pageStr, 10);
    if (!isNaN(page)) {
      return { page, type: type as SitemapType };
    }
  }
  return { type: id as SitemapType };
}

export default async function sitemap({
  id: idPromise,
}: {
  id: string;
}): Promise<MetadataRoute.Sitemap> {
  const id = await idPromise;

  const { type, page } = parsePaginatedId(id);
  const sitemapModule = new Sitemap();

  switch (type) {
    case SitemapType.Pages: {
      return sitemapModule.getPage();
    }
    case SitemapType.Assistants: {
      return sitemapModule.getAssistants(page);
    }
    case SitemapType.Plugins: {
      return sitemapModule.getPlugins(page);
    }
    case SitemapType.Models: {
      return sitemapModule.getModels(page);
    }
    case SitemapType.Providers: {
      return sitemapModule.getProviders();
    }
    default: {
      // Handle paginated sitemaps (plugins-1, assistants-2, mcp-3, etc.)
      if (id.startsWith('plugins-')) {
        const pageNum = parseInt(id.split('-')[1], 10);
        return sitemapModule.getPlugins(pageNum);
      }
      if (id.startsWith('assistants-')) {
        const pageNum = parseInt(id.split('-')[1], 10);
        return sitemapModule.getAssistants(pageNum);
      }
      if (id.startsWith('models-')) {
        const pageNum = parseInt(id.split('-')[1], 10);
        return sitemapModule.getModels(pageNum);
      }

      // Default to empty array
      return [];
    }
  }
}
