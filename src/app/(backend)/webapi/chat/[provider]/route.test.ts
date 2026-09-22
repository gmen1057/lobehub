// @vitest-environment node
import { type LobeRuntimeAI } from '@lobechat/model-runtime';
import { ModelRuntime } from '@lobechat/model-runtime';
import { ChatErrorType } from '@lobechat/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { auth } from '@/auth';
import { createTraceOptions, initModelRuntimeFromDB } from '@/server/modules/ModelRuntime';

import { POST } from './route';

vi.mock('@/server/modules/ModelRuntime', () => ({
  initModelRuntimeFromDB: vi.fn(),
  createTraceOptions: vi.fn().mockReturnValue({}),
  normalizeAssistantMessageId: (value: unknown) => {
    if (value === null || value === undefined) return undefined;
    const s = String(value).trim();
    if (!/^[\w-]{8,64}$/.test(s)) return undefined;
    return s;
  },
}));

vi.mock('@/libs/arckep/validateToken', () => ({
  validateArckepToken: vi.fn().mockResolvedValue({ status: 'valid', userId: '123' }),
}));

vi.mock('@/auth', () => ({
  auth: {
    api: {
      getSession: vi.fn(),
      signOut: vi.fn(),
    },
  },
}));

vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: vi.fn().mockResolvedValue({}),
}));

// 模拟请求和响应
let request: Request;
const originalEnableLangfuse = process.env.ENABLE_LANGFUSE;
beforeEach(() => {
  process.env.ENABLE_LANGFUSE = '0';
  vi.mocked(auth.api.getSession).mockResolvedValue({
    user: { id: 'usr_test', email: 'user123@arckep.ru' },
  } as any);
  request = new Request(new URL('https://test.com'), {
    method: 'POST',
    body: JSON.stringify({ model: 'test-model' }),
  });
});

afterEach(() => {
  if (originalEnableLangfuse === undefined) {
    delete process.env.ENABLE_LANGFUSE;
  } else {
    process.env.ENABLE_LANGFUSE = originalEnableLangfuse;
  }
  vi.clearAllMocks();
});

describe('POST handler', () => {
  describe('init chat model', () => {
    it('should initialize ModelRuntime correctly with valid authorization', async () => {
      const mockParams = Promise.resolve({ provider: 'test-provider' });

      // chat mock 需要返回一个 Response 对象，否则中间件访问 res.headers 会报错
      const mockChatResponse = new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
      const mockRuntime: LobeRuntimeAI = {
        baseURL: 'abc',
        chat: vi.fn().mockResolvedValue(mockChatResponse),
      };

      // Mock initModelRuntimeFromDB
      vi.mocked(initModelRuntimeFromDB).mockResolvedValue(new ModelRuntime(mockRuntime));

      // 调用 POST 函数
      await POST(request as unknown as Request, { params: mockParams });

      // 验证是否正确调用了模拟函数
      expect(initModelRuntimeFromDB).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        'test-provider',
        { sessionId: undefined, topicId: undefined, assistantMessageId: undefined },
      );
    });

    it('should forward x-session-id and x-topic-id to initModelRuntimeFromDB', async () => {
      const mockParams = Promise.resolve({ provider: 'test-provider' });
      const mockChatResponse = new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
      const mockRuntime: LobeRuntimeAI = {
        baseURL: 'abc',
        chat: vi.fn().mockResolvedValue(mockChatResponse),
      };
      vi.mocked(initModelRuntimeFromDB).mockResolvedValue(new ModelRuntime(mockRuntime));

      const reqWithConv = new Request(new URL('https://test.com'), {
        method: 'POST',
        body: JSON.stringify({ model: 'test-model' }),
        headers: {
          'x-session-id': 'inbox',
          'x-topic-id': 'tpc_abc',
        },
      });

      await POST(reqWithConv as unknown as Request, { params: mockParams });

      expect(initModelRuntimeFromDB).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        'test-provider',
        { sessionId: 'inbox', topicId: 'tpc_abc', assistantMessageId: undefined },
      );
    });

    it('should forward a valid x-assistant-message-id and drop a bad one', async () => {
      const mockParams = Promise.resolve({ provider: 'test-provider' });
      const mockChatResponse = new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
      const mockRuntime: LobeRuntimeAI = {
        baseURL: 'abc',
        chat: vi.fn().mockResolvedValue(mockChatResponse),
      };
      vi.mocked(initModelRuntimeFromDB).mockResolvedValue(new ModelRuntime(mockRuntime));

      const good = new Request(new URL('https://test.com'), {
        method: 'POST',
        body: JSON.stringify({ model: 'test-model' }),
        headers: { 'x-assistant-message-id': 'msg_VqfAoxBtmD01N7' },
      });
      await POST(good as unknown as Request, { params: mockParams });
      expect(initModelRuntimeFromDB).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.any(String),
        'test-provider',
        {
          sessionId: undefined,
          topicId: undefined,
          assistantMessageId: 'msg_VqfAoxBtmD01N7',
        },
      );

      const bad = new Request(new URL('https://test.com'), {
        method: 'POST',
        body: JSON.stringify({ model: 'test-model' }),
        headers: { 'x-assistant-message-id': 'not a message' },
      });
      await POST(bad as unknown as Request, { params: mockParams });
      expect(initModelRuntimeFromDB).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.any(String),
        'test-provider',
        { sessionId: undefined, topicId: undefined, assistantMessageId: undefined },
      );
    });

    it('should create Langfuse traces when ENABLE_LANGFUSE even without client opt-in', async () => {
      process.env.ENABLE_LANGFUSE = '1';
      const mockParams = Promise.resolve({ provider: 'test-provider' });
      const mockChatResponse = new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
      const mockRuntime: LobeRuntimeAI = {
        baseURL: 'abc',
        chat: vi.fn().mockResolvedValue(mockChatResponse),
      };
      vi.mocked(initModelRuntimeFromDB).mockResolvedValue(new ModelRuntime(mockRuntime));

      await POST(request as unknown as Request, { params: mockParams });

      expect(createTraceOptions).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'test-model' }),
        expect.objectContaining({
          provider: 'test-provider',
          trace: expect.objectContaining({ enabled: true }),
        }),
      );
    });

    it('should return Unauthorized error when session is missing', async () => {
      const { auth } = await import('@/auth');
      vi.mocked(auth.api.getSession).mockResolvedValueOnce(null as any);
      const mockParams = Promise.resolve({ provider: 'test-provider' });
      const requestWithoutAuthHeader = new Request(new URL('https://test.com'), {
        method: 'POST',
        body: JSON.stringify({ model: 'test-model' }),
      });

      const response = await POST(requestWithoutAuthHeader, { params: mockParams });

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        body: {
          error: { errorType: 401 },
          provider: 'test-provider',
        },
        errorType: 401,
      });
    });

    it('should return InternalServerError error when throw a unknown error', async () => {
      const mockParams = Promise.resolve({ provider: 'test-provider' });
      vi.mocked(initModelRuntimeFromDB).mockRejectedValueOnce(new Error('unknown error'));

      const response = await POST(request, { params: mockParams });

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        body: {
          error: {},
          provider: 'test-provider',
        },
        errorType: 500,
      });
    });
  });

  describe('chat', () => {
    it('should correctly handle chat completion with valid payload', async () => {
      const mockParams = Promise.resolve({ provider: 'test-provider' });
      const mockChatPayload = { message: 'Hello, world!' };
      request = new Request(new URL('https://test.com'), {
        method: 'POST',
        body: JSON.stringify(mockChatPayload),
      });

      const mockChatResponse: any = { success: true, message: 'Reply from agent' };
      const mockRuntime: LobeRuntimeAI = {
        baseURL: 'abc',
        chat: vi.fn().mockResolvedValue(mockChatResponse),
      };

      vi.mocked(initModelRuntimeFromDB).mockResolvedValue(new ModelRuntime(mockRuntime));

      const response = await POST(request as unknown as Request, { params: mockParams });

      expect(response).toEqual(mockChatResponse);
      expect(mockRuntime.chat).toHaveBeenCalledWith(mockChatPayload, {
        user: expect.any(String),
        signal: expect.anything(),
      });
    });

    it('should return an error response when chat completion fails', async () => {
      const mockParams = Promise.resolve({ provider: 'test-provider' });
      const mockChatPayload = { message: 'Hello, world!' };
      request = new Request(new URL('https://test.com'), {
        method: 'POST',
        body: JSON.stringify(mockChatPayload),
      });

      const mockErrorResponse = {
        errorType: ChatErrorType.InternalServerError,
        error: { errorMessage: 'Something went wrong', errorType: 500 },
        errorMessage: 'Something went wrong',
      };

      const mockRuntime: LobeRuntimeAI = {
        baseURL: 'abc',
        chat: vi.fn().mockRejectedValue(mockErrorResponse),
      };

      vi.mocked(initModelRuntimeFromDB).mockResolvedValue(new ModelRuntime(mockRuntime));

      const response = await POST(request, { params: mockParams });

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        body: {
          errorMessage: 'Something went wrong',
          error: {
            errorMessage: 'Something went wrong',
            errorType: 500,
          },
          provider: 'test-provider',
        },
        errorType: 500,
      });
    });
  });
});
