import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

import { fetch as sdkFetch } from 'openai/_shims/index';
import type { Fetch } from 'openai/core';

interface MemoryBillingRun {
  billingOperationId: string;
  userId: number;
}

const memoryBillingRun = new AsyncLocalStorage<MemoryBillingRun & { receipts: Promise<void>[] }>();

export async function withMemoryBillingRun<T>(
  run: MemoryBillingRun,
  work: () => Promise<T>,
): Promise<T> {
  const receipts: Promise<void>[] = [];
  try {
    return await memoryBillingRun.run({ ...run, receipts }, work);
  } finally {
    await Promise.all(receipts);
  }
}

type ServiceTier = 'auto' | 'default' | 'flex';
type JsonObject = Record<string, unknown>;

interface Attempt extends MemoryBillingRun {
  callId: string;
  endpoint: 'responses' | 'chat/completions';
  model: string;
  serviceTier: ServiceTier;
}

interface Receipt extends Attempt {
  cachedTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  phase: 'start' | 'finish';
  providerRequestId?: string;
  reasoningTokens?: number;
  statusCode?: number;
}

const object = (value: unknown): JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {};

const tokenCount = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

const tier = (value: unknown): ServiceTier | undefined =>
  value === 'default' || value === 'flex' || value === 'auto' ? value : undefined;

async function sendReceipt(receipt: Receipt): Promise<boolean> {
  const token = process.env.ARCKEP_INTERNAL_TOKEN || process.env.LOBECHAT_BACKEND_KEY;
  if (!token) return false;
  const base = process.env.IMAGE_STUDIO_API_URL || 'http://127.0.0.1:8202';
  const url = new URL('/api/internal/memory-provider-attempts', base);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const reply = await fetch(url, {
        body: JSON.stringify(receipt),
        headers: { 'Content-Type': 'application/json', 'X-Arckep-Token': token },
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(3000),
      });
      if (reply.ok) return true;
      if (reply.status < 500 && reply.status !== 408 && reply.status !== 429) break;
    } catch {
      // An ACK may have been lost. Repeat the receipt with its original call ID.
    }
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
  }
  return false;
}

// Only installed on the system OpenAI memory runtime. AsyncLocalStorage keeps cached
// runtimes safe to share across concurrent digests, legacy calls and other memory jobs.
export const observeMemoryFetch: Fetch = async (input, init) => {
  const run = memoryBillingRun.getStore();
  if (!run) return sdkFetch(input, init);
  const url = new URL(typeof input === 'object' && 'url' in input ? input.url : input.toString());
  const endpoint = url.pathname.slice('/v1/'.length);
  const method =
    init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET');
  if (
    method.toUpperCase() !== 'POST' ||
    url.origin !== 'https://api.openai.com' ||
    !url.pathname.startsWith('/v1/') ||
    (endpoint !== 'responses' && endpoint !== 'chat/completions')
  )
    return sdkFetch(input, init);

  // The SDK sends JSON. Only the model and service tier leave this process.
  const reqBody =
    typeof init?.body === 'string'
      ? object(JSON.parse(init.body))
      : typeof input === 'object' && 'clone' in input
        ? object(await input.clone().json())
        : {};
  if (reqBody.model !== 'gpt-6-luna') return sdkFetch(input, init);
  const attempt: Attempt = {
    billingOperationId: run.billingOperationId,
    userId: run.userId,
    callId: randomUUID().replaceAll('-', ''),
    endpoint,
    model: reqBody.model,
    serviceTier: tier(reqBody.service_tier) ?? 'default',
  };
  if (!(await sendReceipt({ ...attempt, phase: 'start' }))) {
    throw new Error('Memory provider attempt could not be registered');
  }
  // A transport error leaves the committed start unknown. Let the SDK decide on retry.
  const res = await sdkFetch(input, init);
  // node-fetch tees cloned bodies with bounded buffers. Start reading the copy now
  // and return the original to the SDK immediately so either side can make progress.
  const report = async () => {
    try {
      const body = res.ok
        ? object(
            await res
              .clone()
              .json()
              .catch(() => null),
          )
        : {};
      const usage = object(body.usage);
      const promptDetails = object(usage.input_tokens_details ?? usage.prompt_tokens_details);
      const completionDetails = object(
        usage.output_tokens_details ?? usage.completion_tokens_details,
      );
      const saved = await sendReceipt({
        ...attempt,
        cachedTokens: tokenCount(promptDetails.cached_tokens),
        inputTokens: tokenCount(usage.input_tokens ?? usage.prompt_tokens),
        outputTokens: tokenCount(usage.output_tokens ?? usage.completion_tokens),
        phase: 'finish',
        providerRequestId: res.headers.get('x-request-id') || undefined,
        reasoningTokens: tokenCount(completionDetails.reasoning_tokens),
        serviceTier: tier(body.service_tier) ?? attempt.serviceTier,
        statusCode: res.status,
      });
      if (!saved) console.error('[memory-attempt] finish was not acknowledged', attempt.callId);
    } catch {
      console.error('[memory-attempt] finish could not be reported', attempt.callId);
    }
  };
  run.receipts.push(report());
  // Never turn an upstream success into a second paid request after an ACK failure.
  return res;
};
