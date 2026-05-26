import { AgentRuntimeError } from '@lobechat/model-runtime';
import { ChatErrorType } from '@lobechat/types';
import { getXorPayload } from '@lobechat/utils/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as EnvsAuthModule from '@/envs/auth';
import { validateArckepToken } from '@/libs/arckep/validateToken';
import { createErrorResponse } from '@/utils/errorResponse';

import { type RequestHandler } from './index';
import { checkAuth } from './index';
import { checkAuthMethod } from './utils';

vi.mock('@/utils/errorResponse', () => ({
  createErrorResponse: vi.fn(),
}));

vi.mock('./utils', () => ({
  checkAuthMethod: vi.fn(),
}));

vi.mock('@lobechat/utils/server', () => ({
  getXorPayload: vi.fn(),
}));

vi.mock('@/envs/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof EnvsAuthModule>();
  return {
    ...actual,
  };
});

vi.mock('@/auth', () => ({
  auth: {
    api: {
      getSession: vi.fn().mockResolvedValue(null),
      signOut: vi.fn().mockResolvedValue(undefined),
    },
  },
}));

vi.mock('@/libs/arckep/validateToken', () => ({
  validateArckepToken: vi.fn(),
}));

vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: vi.fn().mockResolvedValue({}),
}));

vi.mock('@/libs/observability/traceparent', () => ({
  extractTraceContext: vi.fn().mockReturnValue({}),
  injectActiveTraceHeaders: vi.fn().mockReturnValue(undefined),
}));

vi.mock('@lobechat/observability-otel/api', () => ({
  context: {
    with: vi.fn((_ctx, fn) => fn()),
  },
}));

describe('checkAuth', () => {
  const mockHandler: RequestHandler = vi.fn();
  const mockOptions = { params: Promise.resolve({ provider: 'mock' }) };

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: arckep token is valid — lets the original auth flow run
    vi.mocked(validateArckepToken).mockResolvedValue({ status: 'valid', userId: '123' });
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('should return unauthorized error if no authorization header', async () => {
    const req = new Request('https://example.com');
    await checkAuth(mockHandler)(req, mockOptions);

    expect(createErrorResponse).toHaveBeenCalledWith(ChatErrorType.Unauthorized, {
      error: AgentRuntimeError.createError(ChatErrorType.Unauthorized),
      provider: 'mock',
    });
    expect(mockHandler).not.toHaveBeenCalled();
  });

  it('should return error response on getJWTPayload error', async () => {
    const mockError = AgentRuntimeError.createError(ChatErrorType.Unauthorized);
    const req = new Request('https://example.com');
    req.headers.set('Authorization', 'invalid');
    vi.mocked(getXorPayload).mockRejectedValueOnce(mockError);

    await checkAuth(mockHandler)(req, mockOptions);

    expect(createErrorResponse).toHaveBeenCalledWith(ChatErrorType.Unauthorized, {
      error: mockError,
      provider: 'mock',
    });
    expect(mockHandler).not.toHaveBeenCalled();
  });

  it('should return error response on checkAuthMethod error', async () => {
    const mockError = AgentRuntimeError.createError(ChatErrorType.Unauthorized);
    const req = new Request('https://example.com');
    req.headers.set('Authorization', 'valid');
    vi.mocked(getXorPayload).mockResolvedValueOnce({});
    vi.mocked(checkAuthMethod).mockImplementationOnce(() => {
      throw mockError;
    });

    await checkAuth(mockHandler)(req, mockOptions);

    expect(createErrorResponse).toHaveBeenCalledWith(ChatErrorType.Unauthorized, {
      error: mockError,
      provider: 'mock',
    });
    expect(mockHandler).not.toHaveBeenCalled();
  });

  describe('arckep gate', () => {
    it('returns 503 with Retry-After when validate is unreachable (no fail-open)', async () => {
      vi.mocked(validateArckepToken).mockResolvedValueOnce({ status: 'unreachable' });
      const req = new Request('https://chat.arckep.ru/webapi/chat/openai', {
        method: 'POST',
      });

      const res = await checkAuth(mockHandler)(req, mockOptions);

      expect(res).toBeInstanceOf(Response);
      expect((res as Response).status).toBe(503);
      expect((res as Response).headers.get('Retry-After')).toBe('5');
      expect(mockHandler).not.toHaveBeenCalled();
      // Critical: handler must NOT be called when validate is unreachable —
      // a fail-open here would let banned users keep working through any
      // backend hiccup.
    });

    function buildReq(headers: Record<string, string>): Request {
      // happy-dom strips `referer` during Request construction (browser Fetch
      // spec forbids it), and we want full control over what middleware sees.
      // In production this header arrives untouched from nginx → Next.js Node.
      const map = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
      const req = {
        clone: () => req,
        headers: { get: (name: string) => map.get(name.toLowerCase()) ?? null },
      } as unknown as Request;
      return req;
    }

    it('returns 401 with X-Bridge-Location for XHR/SSE on expired token (no 302 follow-trap)', async () => {
      vi.mocked(validateArckepToken).mockResolvedValueOnce({ status: 'expired' });
      const req = buildReq({
        accept: 'application/json, text/event-stream',
        host: 'arckep.ru',
        referer: 'https://arckep.ru/chat/agent/agt_abc?topic=tpc_xyz',
      });

      const res = await checkAuth(mockHandler)(req, mockOptions);

      expect((res as Response).status).toBe(401);
      const bridge = (res as Response).headers.get('X-Bridge-Location') ?? '';
      expect(bridge.startsWith('https://arckep.ru/chat/api/bridge?return=')).toBe(true);
      expect(decodeURIComponent(bridge)).toContain('/agent/agt_abc?topic=tpc_xyz');
      expect(mockHandler).not.toHaveBeenCalled();
    });

    it('returns 302 redirect for top-level navigation (Accept: text/html)', async () => {
      vi.mocked(validateArckepToken).mockResolvedValueOnce({ status: 'expired' });
      const req = buildReq({
        accept: 'text/html,application/xhtml+xml',
        host: 'arckep.ru',
      });

      const res = await checkAuth(mockHandler)(req, mockOptions);

      expect((res as Response).status).toBe(302);
      expect((res as Response).headers.get('Location')).toBe(
        'https://arckep.ru/chat/api/bridge?return=%2Fchat%2F',
      );
    });

    it('returns 401 with default bridge_url when token is missing', async () => {
      vi.mocked(validateArckepToken).mockResolvedValueOnce({ status: 'missing' });
      const req = buildReq({
        accept: 'application/json',
        host: 'arckep.ru',
      });

      const res = await checkAuth(mockHandler)(req, mockOptions);

      expect((res as Response).status).toBe(401);
      expect((res as Response).headers.get('X-Bridge-Location')).toBe(
        'https://arckep.ru/chat/api/bridge?return=%2Fchat%2F',
      );
    });

    it('does not honor cross-origin referers (open-redirect guard)', async () => {
      vi.mocked(validateArckepToken).mockResolvedValueOnce({ status: 'expired' });
      const req = buildReq({
        accept: 'application/json',
        host: 'arckep.ru',
        referer: 'https://evil.example.com/phish?path=/',
      });

      const res = await checkAuth(mockHandler)(req, mockOptions);

      expect((res as Response).headers.get('X-Bridge-Location')).toBe(
        'https://arckep.ru/chat/api/bridge?return=%2Fchat%2F',
      );
    });

    it('hardcodes canonical arckep.ru/chat origin even when Host header is poisoned', async () => {
      vi.mocked(validateArckepToken).mockResolvedValueOnce({ status: 'expired' });
      const req = buildReq({
        accept: 'application/json',
        host: 'arckep.ru@evil.com',
      });

      const res = await checkAuth(mockHandler)(req, mockOptions);

      const bridge = (res as Response).headers.get('X-Bridge-Location') ?? '';
      expect(bridge.startsWith('https://arckep.ru/chat/')).toBe(true);
      expect(bridge.includes('evil.com')).toBe(false);
    });

    it('forces signOut and redirects to bridge on account switch (email mismatch)', async () => {
      const { auth } = await import('@/auth');
      vi.mocked(auth.api.getSession).mockResolvedValueOnce({
        user: { id: 'usr_abc', email: 'user456@arckep.ru' },
      } as any);
      vi.mocked(auth.api.signOut).mockResolvedValueOnce(undefined as any);

      vi.mocked(validateArckepToken).mockResolvedValueOnce({ status: 'valid', userId: '123' });

      const req = buildReq({
        accept: 'application/json',
        host: 'arckep.ru',
      });

      const res = await checkAuth(mockHandler)(req, mockOptions);

      expect(auth.api.signOut).toHaveBeenCalled();
      expect((res as Response).status).toBe(401);
      expect((res as Response).headers.get('X-Bridge-Location')).toBe(
        'https://arckep.ru/chat/api/bridge?return=%2Fchat%2F',
      );
      expect(mockHandler).not.toHaveBeenCalled();
    });
  });
});
