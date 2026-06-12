import { defineConfig } from './src/libs/next/config/define-config';

const isVercel = !!process.env.VERCEL_ENV;

const vercelConfig = {
  // Vercel serverless optimization: exclude musl binaries from all routes
  // Vercel uses Amazon Linux (glibc), not Alpine Linux (musl)
  // This saves ~45MB (29MB canvas-musl + 16MB sharp-musl) per serverless function
  outputFileTracingExcludes: {
    '*': [
      'node_modules/.pnpm/@napi-rs+canvas-*-musl*',
      'node_modules/.pnpm/@img+sharp-libvips-*musl*',
      // Exclude SPA/desktop/mobile build artifacts from serverless functions
      'public/_spa/**',
      'dist/desktop/**',
      'dist/mobile/**',
      'apps/desktop/**',
      'packages/database/migrations/**',
    ],
  },
};
const nextConfig = defineConfig({
  ...(isVercel ? vercelConfig : {}),
  experimental: {
    // Turbopack filesystem cache for `next build`: warm rebuilds reuse
    // compiler artifacts from .next/cache instead of recompiling everything.
    // Experimental for builds (stable for dev) — if a build ever produces
    // weird artifacts, drop this flag and `rm -rf .next` to force cold build.
    turbopackFileSystemCacheForBuild: true,
  },
});
nextConfig.basePath = '/chat';
nextConfig.trailingSlash = true;

export default nextConfig;
