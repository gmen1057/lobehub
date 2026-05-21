/* eslint-disable no-console */
import { toNextJsHandler } from 'better-auth/next-js';
import { NextRequest } from 'next/server';

import { auth } from '@/auth';
import { appEnv } from '@/envs/app';

const handler = toNextJsHandler(auth);

const cleanRequest = (req: NextRequest): NextRequest => {
  const url = new URL(req.url);
  let changed = false;

  // 1. Prepend /chat base path if missing
  if (!url.pathname.startsWith('/chat')) {
    url.pathname = '/chat' + url.pathname;
    changed = true;
  }

  // 2. Strip trailing slash if present
  if (url.pathname.endsWith('/')) {
    url.pathname = url.pathname.slice(0, -1);
    changed = true;
  }

  if (changed) {
    // Reconstruct the URL using the stable production domain (appEnv.APP_URL)
    // so that BetterAuth's host & base path matches baseURL perfectly.
    let targetUrl: URL;
    try {
      targetUrl = new URL(url.pathname + url.search, appEnv.APP_URL);
    } catch {
      targetUrl = url;
    }

    const headers = new Headers(req.headers);

    console.log('Original headers:');
    headers.forEach((val, key) => {
      console.log(`  ${key}: ${val}`);
    });

    headers.set('x-invoke-path', targetUrl.pathname);
    headers.set('x-forwarded-uri', targetUrl.pathname);

    const init: RequestInit & { duplex?: 'half' } = {
      method: req.method,
      headers,
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      init.body = req.body;
      init.duplex = 'half';
    }

    const cleaned = new NextRequest(targetUrl.toString(), init);
    console.log('cleanRequest cleaned:', {
      url: cleaned.url,
      nextUrl: cleaned.nextUrl.toString(),
      pathname: cleaned.nextUrl.pathname,
    });
    return cleaned;
  }
  return req;
};

export const GET = async (req: NextRequest) => {
  return handler.GET(cleanRequest(req));
};

export const POST = async (req: NextRequest) => {
  return handler.POST(cleanRequest(req));
};
