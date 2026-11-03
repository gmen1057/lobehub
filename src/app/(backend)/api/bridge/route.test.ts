// @vitest-environment node
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GET } from './route';

const provision = vi.hoisted(() => vi.fn());
vi.mock('@/auth', () => ({ auth: { provisionArckepUser: provision } }));
const fetchMock = vi.fn();
const request = (cookie = 'studio-token') =>
  new NextRequest('https://arckep.ru/chat/api/bridge?return=%2Fchat%2F', {
    headers: { host: 'arckep.ru', ...(cookie ? { cookie: `arckep_token=${cookie}` } : {}) },
  });

beforeEach(() => {
  provision.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('AUTH_SECRET', 'isolated-bridge-tests');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  fetchMock
    .mockResolvedValueOnce(new Response(null, { headers: { 'X-User-Id': '726' } }))
    .mockResolvedValueOnce(
      new Response(null, {
        headers: { 'Set-Cookie': 'better-auth.session_token=test; Path=/; HttpOnly' },
      }),
    )
    .mockResolvedValueOnce(new Response(null, { status: 503 }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('Studio bridge atomic provisioning', () => {
  it('awaits committed provisioning before asking Better Auth for session cookies', async () => {
    let release!: () => void;
    provision.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const pending = GET(request());
    await vi.waitFor(() => expect(provision).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(provision).toHaveBeenCalledWith({
      email: 'user726@arckep.ru',
      name: 'User 726',
      password: 'arckep_bridge_726_isolated',
    });
    release();
    const response = await pending;
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://arckep.ru/chat/');
    expect(response.headers.get('set-cookie')).toContain('better-auth.session_token=test');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/sign-up/'))).toBe(false);
  });

  it('does not provision before validating the Studio cookie', async () => {
    const response = await GET(request(''));
    expect(response.status).toBe(302);
    expect(provision).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not provision when Studio rejects the cookie', async () => {
    fetchMock.mockReset().mockResolvedValueOnce(new Response(null, { status: 401 }));
    expect((await GET(request())).status).toBe(302);
    expect(provision).not.toHaveBeenCalled();
  });

  it('can sign in after concurrent signup or post-commit hook failure only through password verification', async () => {
    provision.mockRejectedValue(new Error('Account committed; post-commit action failed'));
    expect((await GET(request())).status).toBe(302);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('/sign-in/email'),
      expect.objectContaining({
        body: JSON.stringify({
          email: 'user726@arckep.ru',
          password: 'arckep_bridge_726_isolated',
        }),
      }),
    );
  });

  it('never returns session cookies for an existing email with missing or foreign credentials', async () => {
    provision.mockRejectedValue(new Error('email already exists'));
    fetchMock
      .mockReset()
      .mockResolvedValueOnce(new Response(null, { headers: { 'X-User-Id': '726' } }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }));
    const response = await GET(request());
    expect(response.status).toBe(500);
    expect(response.headers.get('set-cookie')).toBeNull();
  });
});
