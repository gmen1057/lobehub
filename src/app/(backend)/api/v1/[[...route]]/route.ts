import lobeOpenApi from '@lobechat/openapi';

/**
 * arckep: форк собран с basePath '/chat' и trailingSlash=true, поэтому в Hono приходил путь
 * '/chat/api/v1/…/' и REST отвечал 404 (Hono ждёт '/api/v1/…' без хвостового '/').
 * Срезаем префикс и хвостовой '/', тело и заголовки не трогаем.
 */
const BASE_PATH = '/chat';

const normalize = (request: Request): Request => {
  const url = new URL(request.url);
  let pathname = url.pathname;
  if (pathname.startsWith(`${BASE_PATH}/api/v1`)) pathname = pathname.slice(BASE_PATH.length);
  if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
  if (pathname === url.pathname) return request;
  url.pathname = pathname;
  return new Request(url.toString(), request);
};

const handler = (request: Request) => lobeOpenApi.fetch(normalize(request));

// Export all required HTTP method handlers
export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const DELETE = handler;
export const PATCH = handler;
export const OPTIONS = handler;
export const HEAD = handler;
