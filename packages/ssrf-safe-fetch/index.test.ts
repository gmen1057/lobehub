// @ts-ignore
import fetch from 'node-fetch';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ssrfSafeFetch } from './index';

// Mock node-fetch to avoid actual network requests
vi.mock('node-fetch', () => ({
  default: vi.fn(),
}));

const mockFetch = fetch as any;

// Mock console.error to avoid noise in test output
vi.spyOn(console, 'error').mockImplementation(() => {});

describe('ssrfSafeFetch', () => {
  const createMockResponse = (
    options: {
      arrayBuffer?: ArrayBuffer;
      headers?: Map<string, string>;
      status?: number;
      statusText?: string;
    } = {},
  ) => ({
    arrayBuffer: vi.fn().mockResolvedValue(options.arrayBuffer || new ArrayBuffer(10)),
    headers: options.headers || new Map(),
    status: options.status || 200,
    statusText: options.statusText || 'OK',
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset environment variables
    delete process.env.SSRF_ALLOW_IP_ADDRESS_LIST;
    delete process.env.SSRF_ALLOW_PRIVATE_IP_ADDRESS;
  });

  describe('successful requests to allowed URLs', () => {
    it('should make a successful fetch request to external URL', async () => {
      const mockResponse = createMockResponse({
        headers: new Map([['content-type', 'application/json']]),
      });

      mockFetch.mockResolvedValue(mockResponse);

      const response = await ssrfSafeFetch('https://httpbin.org/get');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://httpbin.org/get',
        expect.objectContaining({
          agent: expect.any(Function),
        }),
      );
      expect(response).toBeInstanceOf(Response);
      expect(response.status).toBe(200);
      expect(response.statusText).toBe('OK');
    });

    it('should pass through request options', async () => {
      const mockResponse = createMockResponse();
      mockFetch.mockResolvedValue(mockResponse);

      const requestOptions = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ test: 'data' }),
      };

      await ssrfSafeFetch('https://httpbin.org/post', requestOptions);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://httpbin.org/post',
        expect.objectContaining({
          ...requestOptions,
          agent: expect.any(Function),
        }),
      );
    });
  });

  describe('SSRF protection for private IP addresses', () => {
    const privateIPs = [
      'http://127.0.0.1:8080',
      'http://localhost:3000',
      'http://192.168.1.1/api',
      'http://10.0.0.1/internal',
      'http://172.16.0.1/admin',
      'http://0.0.0.0:80',
    ];

    privateIPs.forEach((url) => {
      it(`should block requests to private IP: ${url}`, async () => {
        // The request-filtering-agent should throw an error for private IPs
        mockFetch.mockImplementation(() => {
          throw new Error('getaddrinfo ENOTFOUND');
        });

        await expect(ssrfSafeFetch(url)).rejects.toThrow(/Fetch failed/);

        expect(console.error).toHaveBeenCalledWith('Fetch error:', expect.any(Error));
      });
    });

    it('should allow private IPs when SSRF_ALLOW_PRIVATE_IP_ADDRESS is true', async () => {
      process.env.SSRF_ALLOW_PRIVATE_IP_ADDRESS = '1';

      const mockResponse = createMockResponse();
      mockFetch.mockResolvedValue(mockResponse);

      const response = await ssrfSafeFetch('http://127.0.0.1:8080/api');

      expect(response).toBeInstanceOf(Response);
      expect(response.status).toBe(200);
    });

    it('should allow specific IPs in SSRF_ALLOW_IP_ADDRESS_LIST', async () => {
      process.env.SSRF_ALLOW_IP_ADDRESS_LIST = '127.0.0.1,192.168.1.100';

      const mockResponse = createMockResponse();
      mockFetch.mockResolvedValue(mockResponse);

      const response = await ssrfSafeFetch('http://127.0.0.1:8080/api');

      expect(response).toBeInstanceOf(Response);
      expect(response.status).toBe(200);
    });
  });

  describe('SSRF protection for malicious URLs', () => {
    const privateHttpUrls = [
      'http://169.254.169.254/latest/meta-data/', // AWS metadata service
      'http://169.254.169.254:80/computeMetadata/v1/', // GCP metadata
      'http://metadata.google.internal/computeMetadata/v1/',
    ];

    privateHttpUrls.forEach((url) => {
      it(`should SSRF-block private HTTP URL: ${url}`, async () => {
        mockFetch.mockImplementation(() => {
          throw new Error(
            'DNS lookup 169.254.169.254 is not allowed. Because, It is private IP address.',
          );
        });

        await expect(ssrfSafeFetch(url)).rejects.toThrow(/SSRF blocked/);
      });
    });

    const unsupportedSchemeUrls = [
      'file:///etc/passwd', // File protocol
      'ftp://internal.company.com/secrets', // FTP protocol
    ];

    unsupportedSchemeUrls.forEach((url) => {
      it(`should reject unsupported scheme: ${url}`, async () => {
        mockFetch.mockImplementation(() => {
          throw new TypeError('Only HTTP(S) protocols are supported');
        });

        await expect(ssrfSafeFetch(url)).rejects.toThrow(/Fetch failed/);
      });
    });
  });

  describe('environment variable configuration', () => {
    it('should respect empty SSRF_ALLOW_IP_ADDRESS_LIST', async () => {
      process.env.SSRF_ALLOW_IP_ADDRESS_LIST = '';

      mockFetch.mockImplementation(() => {
        throw new Error('getaddrinfo ENOTFOUND');
      });

      await expect(ssrfSafeFetch('http://127.0.0.1:8080')).rejects.toThrow(/Fetch failed/);
    });

    it('should handle invalid environment variable values gracefully', async () => {
      process.env.SSRF_ALLOW_PRIVATE_IP_ADDRESS = 'invalid-value';

      mockFetch.mockImplementation(() => {
        throw new Error('getaddrinfo ENOTFOUND');
      });

      // Should default to false when env var is not 'true'
      await expect(ssrfSafeFetch('http://127.0.0.1:8080')).rejects.toThrow(/Fetch failed/);
    });
  });

  describe('error handling', () => {
    it('should throw error with descriptive message when fetch fails', async () => {
      const originalError = new Error('Network error');
      mockFetch.mockRejectedValue(originalError);

      await expect(ssrfSafeFetch('https://example.com')).rejects.toThrow(
        'Fetch failed: Network error',
      );

      expect(console.error).toHaveBeenCalledWith('Fetch error:', originalError);
    });

    it('should throw SSRF blocked error when request-filtering-agent blocks', async () => {
      const ssrfError = new Error(
        'DNS lookup 10.0.0.1(family:4, host:10.0.0.1) is not allowed. Because, It is private IP address.',
      );
      mockFetch.mockRejectedValue(ssrfError);

      await expect(ssrfSafeFetch('http://10.0.0.1/internal')).rejects.toThrow(/SSRF blocked/);

      expect(console.error).toHaveBeenCalledWith('SSRF protection blocked request:', ssrfError);
    });

    it('should handle non-Error thrown values', async () => {
      const nonErrorValue = 'String error';
      mockFetch.mockRejectedValue(nonErrorValue);

      await expect(ssrfSafeFetch('https://example.com')).rejects.toThrow(
        'Fetch failed: String error',
      );
    });

    it('should handle null/undefined error values', async () => {
      mockFetch.mockRejectedValue(null);

      await expect(ssrfSafeFetch('https://example.com')).rejects.toThrow('Fetch failed: null');
    });
  });

  describe('response conversion', () => {
    it('should convert node-fetch Response to standard Response', async () => {
      const mockArrayBuffer = new ArrayBuffer(10);
      const mockHeaders = new Map([
        ['content-type', 'application/json'],
        ['content-length', '10'],
      ]);

      const mockResponse = createMockResponse({
        arrayBuffer: mockArrayBuffer,
        headers: mockHeaders,
        status: 201,
        statusText: 'Created',
      });

      mockFetch.mockResolvedValue(mockResponse);

      const response = await ssrfSafeFetch('https://httpbin.org/status/201');

      expect(response).toBeInstanceOf(Response);
      expect(response.status).toBe(201);
      expect(response.statusText).toBe('Created');
      expect(response.headers.get('content-type')).toBe('application/json');
      expect(response.headers.get('content-length')).toBe('10');
      expect(mockResponse.arrayBuffer).toHaveBeenCalled();
    });

    it('should handle response with different status codes', async () => {
      const mockResponse = createMockResponse({
        arrayBuffer: new ArrayBuffer(0),
        status: 404,
        statusText: 'Not Found',
      });

      mockFetch.mockResolvedValue(mockResponse);

      const response = await ssrfSafeFetch('https://httpbin.org/status/404');

      expect(response.status).toBe(404);
      expect(response.statusText).toBe('Not Found');
    });

    it('should handle response with empty headers', async () => {
      const mockResponse = createMockResponse({
        arrayBuffer: new ArrayBuffer(0),
      });

      mockFetch.mockResolvedValue(mockResponse);

      const response = await ssrfSafeFetch('https://httpbin.org/get');

      expect(response.headers).toBeDefined();
      expect([...response.headers.entries()]).toEqual([]);
    });
  });

  describe('integration scenarios', () => {
    it('should work with complex request configurations', async () => {
      process.env.SSRF_ALLOW_IP_ADDRESS_LIST = '127.0.0.1';
      process.env.SSRF_ALLOW_PRIVATE_IP_ADDRESS = '1';

      const mockResponse = createMockResponse({
        // @ts-ignore
        arrayBuffer: new TextEncoder().encode('{"success": true}'),
        headers: new Map([['content-type', 'application/json']]),
      });

      mockFetch.mockResolvedValue(mockResponse);

      const requestOptions = {
        method: 'PUT',
        headers: {
          'Authorization': 'Bearer token123',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ data: 'test' }),
      };

      const response = await ssrfSafeFetch('https://api.example.com/data', requestOptions);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/data',
        expect.objectContaining({
          ...requestOptions,
          agent: expect.any(Function),
        }),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('application/json');
    });

    it('should properly handle agent function with HTTPS URLs', async () => {
      const mockResponse = createMockResponse();
      mockFetch.mockResolvedValue(mockResponse);

      await ssrfSafeFetch('https://secure.example.com/api');

      // Verify that the agent function is passed
      expect(mockFetch).toHaveBeenCalledWith(
        'https://secure.example.com/api',
        expect.objectContaining({
          agent: expect.any(Function),
        }),
      );
    });
  });

  describe('timeoutMs and AbortSignal handling', () => {
    it('should abort hung fetch when timeoutMs expires and pass signal to node-fetch', async () => {
      let capturedSignal: AbortSignal | undefined;
      mockFetch.mockImplementation(
        (_url: string, init: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            capturedSignal = init.signal;
            init.signal?.addEventListener('abort', () => {
              const err = new Error('The operation was aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }),
      );

      await expect(
        ssrfSafeFetch('https://storage.yandexcloud.net/imagestudio/slow.png', { timeoutMs: 30 }),
      ).rejects.toThrow(/Request timed out after 30ms/);

      expect(capturedSignal).toBeDefined();
      expect(capturedSignal?.aborted).toBe(true);
      // timeoutMs itself must not leak into node-fetch options
      expect(mockFetch.mock.calls[0][1]).not.toHaveProperty('timeoutMs');
    });

    it('should abort hung response.arrayBuffer() under the same timeoutMs budget', async () => {
      let capturedSignal: AbortSignal | undefined;
      mockFetch.mockImplementation(async (_url: string, init: { signal?: AbortSignal }) => {
        capturedSignal = init.signal;
        return {
          arrayBuffer: () => new Promise<ArrayBuffer>(() => {}),
          headers: new Map([['content-type', 'image/png']]),
          status: 200,
          statusText: 'OK',
        };
      });

      await expect(
        ssrfSafeFetch('https://storage.yandexcloud.net/imagestudio/stalled-body.png', {
          timeoutMs: 35,
        }),
      ).rejects.toThrow(/Request timed out after 35ms/);

      expect(capturedSignal?.aborted).toBe(true);
    });

    it('should forward caller AbortSignal when combined with timeoutMs', async () => {
      const callerController = new AbortController();
      let capturedSignal: AbortSignal | undefined;

      mockFetch.mockImplementation(
        (_url: string, init: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            capturedSignal = init.signal;
            init.signal?.addEventListener('abort', () => {
              reject(new Error('Caller cancelled'));
            });
          }),
      );

      const pending = ssrfSafeFetch('https://example.com/cancel', {
        signal: callerController.signal,
        timeoutMs: 5000,
      });

      callerController.abort(new Error('Caller cancelled'));

      await expect(pending).rejects.toThrow(/Caller cancelled/);
      expect(capturedSignal?.aborted).toBe(true);
    });

    it('should reject immediately when caller signal is already aborted', async () => {
      const callerController = new AbortController();
      callerController.abort(new Error('Already aborted'));

      await expect(
        ssrfSafeFetch('https://example.com/already-aborted', {
          signal: callerController.signal,
          timeoutMs: 5000,
        }),
      ).rejects.toThrow(/Already aborted/);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should resolve normally and clear timer when fetch finishes before timeoutMs', async () => {
      const mockResponse = createMockResponse({
        headers: new Map([['content-type', 'image/png']]),
      });
      mockFetch.mockResolvedValue(mockResponse);

      const response = await ssrfSafeFetch('https://example.com/fast.png', { timeoutMs: 2000 });
      expect(response.status).toBe(200);
      expect(mockFetch.mock.calls[0][1].signal?.aborted).toBe(false);
    });

    it('marks timeout cause as TimeoutError and distinguishes external caller AbortSignal as AbortError', async () => {
      mockFetch.mockImplementation(
        (_url: string, init: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              const err = new Error('The operation was aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }),
      );

      let caughtTimeout: any;
      try {
        await ssrfSafeFetch('https://example.com/timeout-cause', { timeoutMs: 25 });
      } catch (err) {
        caughtTimeout = err;
      }
      expect(caughtTimeout).toBeInstanceOf(Error);
      expect(caughtTimeout.message).toContain('Request timed out after 25ms');
      expect(caughtTimeout.cause?.name).toBe('TimeoutError');
      expect(caughtTimeout.isCallerAbort).toBeUndefined();

      const callerController = new AbortController();
      const pending = ssrfSafeFetch('https://example.com/caller-abort', {
        signal: callerController.signal,
        timeoutMs: 5000,
      });
      callerController.abort();

      let caughtAbort: any;
      try {
        await pending;
      } catch (err) {
        caughtAbort = err;
      }
      expect(caughtAbort).toBeInstanceOf(Error);
      expect(caughtAbort.name).toBe('AbortError');
      expect(caughtAbort.isCallerAbort).toBe(true);
      expect(caughtAbort.cause?.name).toBe('AbortError');
    });

    it('reuses pooled keepAlive HTTP/HTTPS agents across identical SSRF settings and isolates distinct settings', async () => {
      mockFetch.mockResolvedValue(createMockResponse());

      await ssrfSafeFetch('https://example.com/a');
      await ssrfSafeFetch('https://example.com/b');
      process.env.SSRF_ALLOW_PRIVATE_IP_ADDRESS = '1';
      await ssrfSafeFetch('https://example.com/c');

      const agentFn1 = mockFetch.mock.calls[0][1].agent;
      const agentFn2 = mockFetch.mock.calls[1][1].agent;
      const agentFn3 = mockFetch.mock.calls[2][1].agent;

      const httpsUrl = new URL('https://example.com');
      const httpUrl = new URL('http://example.com');

      const httpsAgent1 = agentFn1(httpsUrl);
      const httpsAgent2 = agentFn2(httpsUrl);
      const httpsAgent3 = agentFn3(httpsUrl);

      expect(httpsAgent1).toBe(httpsAgent2);
      expect(agentFn1(httpUrl)).toBe(agentFn2(httpUrl));
      expect(httpsAgent1.keepAlive).toBe(true);
      expect(agentFn1(httpUrl).keepAlive).toBe(true);
      expect(httpsAgent3).not.toBe(httpsAgent1);
    });
  });
});
