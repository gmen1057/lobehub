// @vitest-environment node
import OpenAI from 'openai';
import type * as OpenAIShims from 'openai/_shims/index';
import { afterEach, expect, it, vi } from 'vitest';

import { observeMemoryFetch, withMemoryBillingRun } from '../arckepAttemptReceipt';

vi.mock('openai/_shims/index', async (load) => {
  const original = await load<typeof OpenAIShims>();
  return {
    ...original,
    fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
  };
});

const context = { billingOperationId: 'memauto-123456789012345678901234', userId: 15 };
const upstream = 'https://api.openai.com/v1/responses';

const init = {
  body: JSON.stringify({ input: 'private', model: 'gpt-6-luna', service_tier: 'flex' }),
  headers: { authorization: 'Bearer fake-provider-secret' },
  method: 'POST',
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function configure() {
  vi.stubEnv('ARCKEP_INTERNAL_TOKEN', 'internal-test');
  vi.stubEnv('IMAGE_STUDIO_API_URL', 'http://localhost:8202');
  const receipts: Record<string, unknown>[] = [];
  const provider = vi.fn(async () =>
    Response.json(
      {
        output_text: 'private result',
        service_tier: 'default',
        usage: {
          input_tokens: 16,
          input_tokens_details: { cached_tokens: 8 },
          output_tokens: 9,
          output_tokens_details: { reasoning_tokens: 2 },
        },
      },
      { headers: { 'x-request-id': 'req_distinct' } },
    ),
  );
  const acknowledge = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
      if (String(input).startsWith('http://localhost:8202/')) {
        expect(String(input)).toEqual(
          'http://localhost:8202/api/internal/memory-provider-attempts',
        );
        expect(options?.headers).toMatchObject({ 'X-Arckep-Token': 'internal-test' });
        receipts.push(JSON.parse(String(options?.body)));
        return acknowledge();
      }
      return provider();
    }),
  );
  return { acknowledge, provider, receipts };
}

it('records distinct physical attempts, durable start before network, only whitelisted evidence', async () => {
  const { receipts, provider } = configure();
  provider.mockImplementationOnce(async () => {
    expect(receipts).toHaveLength(1);
    expect(receipts[0].phase).toBe('start');
    return new Response('capacity', { status: 429, headers: { 'x-request-id': 'req_denied' } });
  });
  const res = await withMemoryBillingRun(context, async () => {
    expect((await observeMemoryFetch(upstream, init)).status).toBe(429);
    return observeMemoryFetch(upstream, { ...init, body: JSON.stringify({ model: 'gpt-6-luna' }) });
  });
  expect((await res.json()).output_text).toBe('private result');
  expect(receipts.map((r) => r.phase)).toEqual(['start', 'finish', 'start', 'finish']);
  expect(receipts[0].callId).toMatch(/^[a-f0-9]{32}$/);
  expect(receipts[0].callId).not.toEqual(receipts[2].callId);
  expect(receipts[1]).toMatchObject({
    ...context,
    callId: receipts[0].callId,
    statusCode: 429,
    serviceTier: 'flex',
    providerRequestId: 'req_denied',
  });
  expect(receipts[3]).toEqual({
    ...context,
    endpoint: 'responses',
    model: 'gpt-6-luna',
    phase: 'finish',
    callId: receipts[2].callId,
    statusCode: 200,
    serviceTier: 'default',
    inputTokens: 16,
    cachedTokens: 8,
    outputTokens: 9,
    reasoningTokens: 2,
    providerRequestId: 'req_distinct',
  });
  expect(JSON.stringify(receipts)).not.toMatch(/private|fake-provider-secret/);
});

it('never sends an unregistered provider request and leaves ambiguous IO failure open', async () => {
  const { acknowledge, provider, receipts } = configure();
  acknowledge.mockResolvedValueOnce(new Response(null, { status: 403 }));
  await expect(
    withMemoryBillingRun(context, () => observeMemoryFetch(upstream, init)),
  ).rejects.toThrow('registered');
  expect(provider).not.toHaveBeenCalled();
  provider.mockRejectedValueOnce(new Error('connection lost'));
  await expect(
    withMemoryBillingRun(context, () => observeMemoryFetch(upstream, init)),
  ).rejects.toThrow('connection lost');
  expect(receipts.map((r) => r.phase)).toEqual(['start', 'start']);
});

it('retains original response if a finish receipt fails', async () => {
  const { acknowledge, provider } = configure();
  acknowledge.mockResolvedValueOnce(new Response(null, { status: 204 }));
  acknowledge.mockResolvedValueOnce(new Response(null, { status: 409 }));
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const res = await withMemoryBillingRun(context, () => observeMemoryFetch(upstream, init));
  expect((await res.json()).output_text).toBe('private result');
  expect(provider).toHaveBeenCalledTimes(1);
  expect(log).toHaveBeenCalledTimes(1);
});

it('isolates concurrent runs, unrelated endpoints and legacy calls', async () => {
  const { receipts } = configure();
  await Promise.all([
    observeMemoryFetch(upstream, init),
    withMemoryBillingRun(context, () =>
      observeMemoryFetch('https://api.openai.com/v1/embeddings', init),
    ),
    withMemoryBillingRun(context, () =>
      observeMemoryFetch('https://proxy.example/v1/responses', init),
    ),
    withMemoryBillingRun(context, () => observeMemoryFetch(upstream, init)),
    withMemoryBillingRun(
      { ...context, billingOperationId: 'memauto-000000000000000000000000', userId: 102 },
      () => observeMemoryFetch('https://api.openai.com/v1/chat/completions', init),
    ),
  ]);
  expect(receipts).toHaveLength(4);
  expect(receipts.filter((r) => r.endpoint === 'responses').map((r) => r.userId)).toEqual([15, 15]);
  expect(receipts.filter((r) => r.endpoint === 'chat/completions').map((r) => r.userId)).toEqual([
    102, 102,
  ]);
});

it('captures the SDK automatic retry as a new HTTP attempt', async () => {
  const { receipts, provider } = configure();
  provider.mockImplementationOnce(async () =>
    Response.json(
      { error: { message: 'retry' } },
      { status: 503, headers: { 'retry-after-ms': '1' } },
    ),
  );
  const sdk = new OpenAI({ apiKey: 'fake-upstream-key', fetch: observeMemoryFetch, maxRetries: 1 });
  await withMemoryBillingRun(context, () =>
    sdk.responses.create({
      input: 'sample',
      model: 'gpt-6-luna',
      service_tier: 'flex',
    }),
  );
  expect(provider).toHaveBeenCalledTimes(2);
  expect(receipts.map((r) => [r.phase, r.statusCode])).toEqual([
    ['start', undefined],
    ['finish', 503],
    ['start', undefined],
    ['finish', 200],
  ]);
  expect(new Set(receipts.map((r) => r.callId)).size).toBe(2);
});
