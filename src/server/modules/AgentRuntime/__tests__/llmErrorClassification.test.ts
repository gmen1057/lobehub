import Anthropic from '@anthropic-ai/sdk';
import { Stream as AnthropicSDKStream } from '@anthropic-ai/sdk/streaming';
import OpenAI from 'openai';
import { Stream } from 'openai/streaming';
import { describe, expect, it, vi } from 'vitest';

import { handleAnthropicError } from '../../../../../packages/model-runtime/src/core/anthropicCompatibleFactory/handleAnthropicError';
import { AnthropicStream } from '../../../../../packages/model-runtime/src/core/streams/anthropic';
import { OpenAIStream } from '../../../../../packages/model-runtime/src/core/streams/openai/openai';
import { OpenAIResponsesStream } from '../../../../../packages/model-runtime/src/core/streams/openai/responsesStream';
import { QwenAIStream } from '../../../../../packages/model-runtime/src/core/streams/qwen';
import { LobeGoogleAI } from '../../../../../packages/model-runtime/src/providers/google';
import { consumeStreamUntilDone } from '../../../../../packages/model-runtime/src/utils/consumeStream';
import { parseGoogleErrorMessage } from '../../../../../packages/model-runtime/src/utils/googleErrorParser';
import { handleOpenAIError } from '../../../../../packages/model-runtime/src/utils/handleOpenAIError';
import { classifyLLMError } from '../llmErrorClassification';

describe('classifyLLMError', () => {
  it('should classify rate limit errors as retry', () => {
    expect(
      classifyLLMError({ errorType: 'QuotaLimitReached', message: '429 rate limit' }).kind,
    ).toBe('retry');
  });

  it('should classify invalid api key errors as stop', () => {
    expect(
      classifyLLMError({ errorType: 'InvalidProviderAPIKey', message: '401 unauthorized' }).kind,
    ).toBe('stop');
  });

  it('should classify context window errors as stop', () => {
    expect(
      classifyLLMError({ errorType: 'ExceededContextWindow', message: 'maximum context length' })
        .kind,
    ).toBe('stop');
  });

  it('should classify ProviderBizError invalid_request errors as stop', () => {
    expect(
      classifyLLMError({
        error: {
          error: {
            message: 'tools.0.custom.input_schema: Field required',
            type: 'invalid_request_error',
          },
          errorType: 'ProviderBizError',
        },
        errorType: 'ProviderBizError',
      }).kind,
    ).toBe('stop');
  });

  it('should keep ProviderBizError rate limit errors as retry', () => {
    expect(
      classifyLLMError({
        error: { message: '429 rate limit exceeded' },
        errorType: 'ProviderBizError',
      }).kind,
    ).toBe('retry');
  });

  it('should default unknown errors to retry', () => {
    expect(classifyLLMError(new Error('unexpected upstream issue')).kind).toBe('retry');
  });

  it.each([400, 401, 403, 404, 409, 422])(
    'should stop a permanent HTTP %s before the generic ProviderBizError retry',
    (status) => {
      expect(
        classifyLLMError({
          error: { message: 'Provider rejected the request', status },
          errorType: 'ProviderBizError',
        }).kind,
      ).toBe('stop');
    },
  );

  it.each([408, 425, 429, 500, 502, 503])('should keep HTTP %s retryable', (status) => {
    expect(
      classifyLLMError({
        error: { message: 'Provider could not complete the request', status },
        errorType: 'ProviderBizError',
      }).kind,
    ).toBe('retry');
  });

  it('preserves HTTP 404 through OpenAI normalization and JSON transport', () => {
    const apiError = OpenAI.APIError.generate(
      404,
      {
        error: { message: 'This model is unavailable for free. Use the paid model.' },
      },
      undefined,
      new Headers() as any,
    );
    const { errorResult } = handleOpenAIError(apiError);
    // Exercise the actual JSON wire boundary, not an in-memory clone.
    // eslint-disable-next-line unicorn/prefer-structured-clone
    const payload = JSON.parse(
      JSON.stringify({
        error: errorResult,
        errorType: 'ProviderBizError',
        provider: 'openrouter',
      }),
    );
    expect(payload.error.status).toBe(404);
    expect(classifyLLMError(payload).kind).toBe('stop');
    // RuntimeExecutors throws an Error carrying the stream payload's fields.
    const streamExecutionError = Object.assign(new Error('LLM stream error'), payload);
    expect(classifyLLMError(streamExecutionError).kind).toBe('stop');
  });

  // arckep (19.10.2026): нехватка баланса — повторять бессмысленно (раньше 6 попыток по ~30 с подряд)
  describe('нехватка баланса (HTTP 402 прокси студии)', () => {
    const BALANCE_MESSAGE =
      'Недостаточно средств на балансе. Пополните баланс: https://arckep.ru/settings#balance';
    const body = {
      error: { code: 'billing_error', message: BALANCE_MESSAGE, type: 'insufficient_balance' },
    };

    // что model-runtime кидает наверх, когда провайдер ответил 402: тело ошибки в `error`, тип — ProviderBizError
    // (общий для повторяемых и неповторяемых ошибок).
    const openAICompatiblePayload = () => {
      const apiError = OpenAI.APIError.generate(402, body, undefined, new Headers() as any);
      const { errorResult } = handleOpenAIError(apiError);
      return {
        endpoint: 'https://api.arckep.ru',
        error: errorResult,
        errorType: 'ProviderBizError',
        provider: 'openai',
      };
    };
    const anthropicPayload = () => {
      const apiError = Anthropic.APIError.generate(402, body, undefined, new Headers() as any);
      const { errorResult } = handleAnthropicError(apiError);
      return {
        endpoint: 'https://api.arckep.ru',
        error: errorResult,
        errorType: 'ProviderBizError',
        provider: 'anthropic',
      };
    };
    // @google/genai кладёт тело ответа в строку message ошибки; parseGoogleErrorMessage разбирает её
    const googlePayload = (googleBody: unknown) => {
      const { error, errorType } = parseGoogleErrorMessage(JSON.stringify(googleBody));
      return { error, errorType, provider: 'google' };
    };

    it('openai-совместимый провайдер: ProviderBizError со статусом и признаками в error → stop', () => {
      const payload = openAICompatiblePayload();
      expect(payload.errorType).toBe('ProviderBizError');
      expect(payload.error.status).toBe(402);

      expect(classifyLLMError(payload).kind).toBe('stop');
    });

    it('anthropic: та же обёртка с телом из двух уровней error → stop', () => {
      const payload = anthropicPayload();
      expect(payload.errorType).toBe('ProviderBizError');
      expect(payload.error.status).toBeUndefined();

      expect(classifyLLMError(payload).kind).toBe('stop');
    });

    it('google: тело разобрано parseGoogleErrorMessage, код строкой billing_error → stop', () => {
      const payload = googlePayload(body);
      expect(payload.errorType).toBe('ProviderBizError');

      expect(classifyLLMError(payload).kind).toBe('stop');
    });

    it('google в своём формате: код 402 числом → stop и не падает на нестроковом коде', () => {
      const payload = googlePayload({
        error: { code: 402, message: 'Payment required', status: 'FAILED_PRECONDITION' },
      });

      expect(() => classifyLLMError(payload)).not.toThrow();
      expect(classifyLLMError(payload).kind).toBe('stop');
    });

    it('числовой код других ошибок Google не ломает классификацию: 429 остаётся retry', () => {
      const payload = googlePayload({
        error: { code: 429, message: 'Resource has been exhausted', status: 'RESOURCE_EXHAUSTED' },
      });

      expect(payload.errorType).toBe('QuotaLimitReached');
      expect(classifyLLMError(payload).kind).toBe('retry');
    });

    it('сам объект ошибки провайдера со статусом 402 (не обёрнутый) → stop', () => {
      expect(
        classifyLLMError(OpenAI.APIError.generate(402, body, undefined, new Headers() as any)).kind,
      ).toBe('stop');
      expect(
        classifyLLMError(Anthropic.APIError.generate(402, body, undefined, new Headers() as any))
          .kind,
      ).toBe('stop');
    });

    it('distinguishes the vendor wallet through the OpenAI, Anthropic and Google SDK wrappers', () => {
      const message = 'Сейчас эта модель временно недоступна. Мы уже в процессе её восстановления.';
      const vendor = {
        error: { code: 'provider_credits_exhausted', message, type: 'provider_credits_exhausted' },
      };
      const openai = OpenAI.APIError.generate(402, vendor, undefined, new Headers() as any);
      const anthropic = Anthropic.APIError.generate(429, vendor, undefined, new Headers() as any);
      for (const error of [
        handleOpenAIError(openai).errorResult,
        handleAnthropicError(anthropic).errorResult,
        googlePayload({ error: { ...vendor.error, code: 429, status: 'RESOURCE_EXHAUSTED' } }),
      ]) {
        expect(classifyLLMError(error)).toMatchObject({
          billing: false,
          code: 'provider_credits_exhausted',
        });
      }
    });

    it.each([
      { status: 402, retrySafe: true },
      { status: 429, retrySafe: true },
      { status: 503, retrySafe: false },
    ])('decides recovery from transport and retry metadata for $status', (transport) => {
      const ordinary = { ...transport, errorType: 'ProviderBizError' };
      const marked = { ...ordinary, body: { code: 'provider_credits_exhausted' } };
      expect(classifyLLMError(marked).kind).toBe(classifyLLMError(ordinary).kind);
    });

    it('preserves the context limit through the Google SDK error parser', () => {
      const wrapped = googlePayload({
        error: { code: 400, message: 'This request exceeds the context window of this model' },
      });
      expect(classifyLLMError(wrapped)).toMatchObject({
        code: 'context_length_exceeded',
        kind: 'stop',
      });
    });

    it('статус 402 сам по себе, в любом виде → stop', () => {
      expect(
        classifyLLMError({ errorType: 'ProviderBizError', message: 'x', status: 402 }).kind,
      ).toBe('stop');
      expect(classifyLLMError({ message: 'payment required', statusCode: 402 }).kind).toBe('stop');
      expect(classifyLLMError(new Error('402 Payment Required')).kind).toBe('stop');
      expect(classifyLLMError({ error: { status: 402 }, errorType: 'ProviderBizError' }).kind).toBe(
        'stop',
      );
    });

    it('только текст: insufficient_balance / billing_error / «Недостаточно средств» → stop', () => {
      for (const marker of [
        'insufficient_balance',
        'Insufficient Balance',
        'billing_error',
        'НЕДОСТАТОЧНО СРЕДСТВ на счёте',
      ]) {
        expect(
          classifyLLMError({ errorType: 'ProviderBizError', message: marker }).kind,
          marker,
        ).toBe('stop');
        expect(classifyLLMError(marker).kind, marker).toBe('stop');
        expect(
          classifyLLMError({ error: { type: marker }, errorType: 'AgentRuntimeError' }).kind,
          `type: ${marker}`,
        ).toBe('stop');
        expect(
          classifyLLMError({ error: { code: marker }, errorType: 'StreamChunkError' }).kind,
          `code: ${marker}`,
        ).toBe('stop');
      }
    });

    it('текст для человека сохраняется в результате классификации', () => {
      expect(classifyLLMError(openAICompatiblePayload()).message).toContain('недостаточно средств');
    });

    it('обычные повторяемые ошибки провайдера остаются retry', () => {
      expect(
        classifyLLMError({
          error: { message: 'upstream overloaded' },
          errorType: 'ProviderBizError',
        }).kind,
      ).toBe('retry');
      expect(
        classifyLLMError({
          error: { message: 'internal error' },
          errorType: 'ProviderBizError',
          status: 503,
        }).kind,
      ).toBe('retry');
      expect(classifyLLMError(new Error('network timeout')).kind).toBe('retry');
    });
  });

  describe('OpenAI stream non-retryable schema and proxy recovery metadata', () => {
    it('stops on ProviderBizError with Invalid JSON schema / invalid_json_schema even without status', () => {
      expect(
        classifyLLMError({
          errorType: 'ProviderBizError',
          message:
            'LLM stream error: Invalid JSON schema: regex lookaround is not supported in pattern',
        }).kind,
      ).toBe('stop');

      expect(
        classifyLLMError({
          body: { code: 'invalid_json_schema', message: 'Schema validation failed' },
          type: 'ProviderBizError',
        }).kind,
      ).toBe('stop');
    });

    it('stops when retrySafe: false is carried in details, body.details, or body.error.details', () => {
      const details = [{ reason: 'upstream_error', retryOwner: 'engine', retrySafe: false }];

      expect(
        classifyLLMError({
          details,
          message: 'Upstream request failed',
          type: 'ProviderBizError',
        }),
      ).toMatchObject({ kind: 'stop', retrySafe: false });

      expect(
        classifyLLMError({
          body: { details, message: 'Upstream request failed' },
          type: 'ProviderBizError',
        }),
      ).toMatchObject({ kind: 'stop', retrySafe: false });

      expect(
        classifyLLMError({
          body: { error: { details, message: 'Upstream request failed' } },
          type: 'ProviderBizError',
        }),
      ).toMatchObject({ kind: 'stop', retrySafe: false });
    });

    it.each([400, 401, 403, 404, 413, 415, 422])(
      'extracts numeric HTTP %s from body.status and body.error.status and stops',
      (status) => {
        expect(
          classifyLLMError({
            body: { message: 'Request rejected', status },
            type: 'ProviderBizError',
          }),
        ).toMatchObject({ kind: 'stop', status });

        expect(
          classifyLLMError({
            body: { error: { message: 'Request rejected', status } },
            type: 'ProviderBizError',
          }),
        ).toMatchObject({ kind: 'stop', status });
      },
    );

    it('stops end-to-end when OpenAIResponsesStream receives billing_proxy SSE error frame', async () => {
      const ssePayload = {
        error: {
          code: 'invalid_json_schema',
          details: [
            {
              hasOutput: false,
              hasUsage: false,
              reason: 'upstream_error',
              retryOwner: 'engine',
              retrySafe: false,
            },
          ],
          message: 'Invalid JSON schema: regex lookaround is not supported',
          type: 'invalid_request_error',
        },
      };
      const sseResponse = new Response(
        `: ping\n\nevent: error\ndata: ${JSON.stringify(ssePayload)}\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
      const openAIStream = Stream.fromSSEResponse<any>(sseResponse, new AbortController());
      const onError = vi.fn();

      const protocolStream = OpenAIResponsesStream(openAIStream, {
        callbacks: { onError },
        payload: { provider: 'openai' },
      });
      await consumeStreamUntilDone(new Response(protocolStream));

      expect(onError).toHaveBeenCalledOnce();
      const streamError = onError.mock.calls[0][0];
      const { message, ...restStreamError } = streamError;
      const streamExecutionError = Object.assign(
        new Error(`LLM stream error: ${message}`),
        restStreamError,
      );

      expect(classifyLLMError(streamExecutionError)).toMatchObject({
        code: 'INVALID_JSON_SCHEMA',
        kind: 'stop',
        retrySafe: false,
      });
    });
  });

  describe('billing_proxy 504 upstream_timeout (retrySafe: false) vs 502 upstream_unavailable (retrySafe: true)', () => {
    const toStreamExecutionError = (streamError: Record<string, unknown>) => {
      const { message, ...rest } = streamError;
      return Object.assign(new Error(`LLM stream error: ${String(message)}`), rest);
    };

    it.each([
      {
        expectedKind: 'stop' as const,
        reason: 'upstream_timeout',
        retrySafe: false,
        status: 504,
      },
      {
        expectedKind: 'retry' as const,
        reason: 'upstream_unavailable',
        retrySafe: true,
        status: 502,
      },
    ])(
      'OpenAIStream, OpenAIResponsesStream, and QwenAIStream classify $status $reason (retrySafe=$retrySafe) as $expectedKind',
      async ({ status, reason, retrySafe, expectedKind }) => {
        const ssePayload = {
          error: {
            code: reason,
            details: [
              {
                hasOutput: false,
                hasUsage: false,
                reason,
                retryOwner: 'engine',
                retrySafe,
              },
            ],
            message:
              status === 504
                ? 'Upstream provider openai timed out.'
                : 'Upstream provider openai unavailable.',
            status,
            type: reason,
          },
        };

        for (const [label, wrapStream] of [
          [
            'OpenAIStream (data-only SSE)',
            (s: Stream<any>, onError: any) =>
              OpenAIStream(s, { callbacks: { onError }, payload: { provider: 'openai' } }),
          ],
          [
            'OpenAIResponsesStream (event: error SSE)',
            (s: Stream<any>, onError: any) =>
              OpenAIResponsesStream(s, {
                callbacks: { onError },
                payload: { provider: 'openai' },
              }),
          ],
          [
            'QwenAIStream',
            (s: Stream<any>, onError: any) =>
              QwenAIStream(s, { callbacks: { onError }, payload: { provider: 'qwen' } }),
          ],
        ] as const) {
          const rawSse = label.includes('event: error')
            ? `: ping\n\nevent: error\ndata: ${JSON.stringify(ssePayload)}\n\n`
            : `: ping\n\ndata: ${JSON.stringify(ssePayload)}\n\n`;
          const sseResponse = new Response(rawSse, {
            headers: { 'content-type': 'text/event-stream' },
          });
          const openAIStream = Stream.fromSSEResponse<any>(sseResponse, new AbortController());
          const onError = vi.fn();

          await consumeStreamUntilDone(new Response(wrapStream(openAIStream, onError)));

          expect(onError, label).toHaveBeenCalledOnce();
          const classified = classifyLLMError(toStreamExecutionError(onError.mock.calls[0][0]));
          expect(classified, label).toMatchObject({
            kind: expectedKind,
            retrySafe,
            status,
          });
        }
      },
    );

    it.each([
      {
        expectedKind: 'stop' as const,
        reason: 'upstream_timeout',
        retrySafe: false,
        status: 504,
      },
      {
        expectedKind: 'retry' as const,
        reason: 'upstream_unavailable',
        retrySafe: true,
        status: 502,
      },
    ])(
      'AnthropicStream classifies $status $reason (retrySafe=$retrySafe) as $expectedKind',
      async ({ status, reason, retrySafe, expectedKind }) => {
        const ssePayload = {
          error: {
            code: reason,
            details: [
              {
                hasOutput: false,
                hasUsage: false,
                reason,
                retryOwner: 'engine',
                retrySafe,
              },
            ],
            message:
              status === 504
                ? 'Upstream provider anthropic timed out.'
                : 'Upstream provider anthropic unavailable.',
            status,
            type: reason,
          },
          type: 'error',
        };
        const sseResponse = new Response(
          `: ping\n\nevent: error\ndata: ${JSON.stringify(ssePayload)}\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        );
        const sdkStream = AnthropicSDKStream.fromSSEResponse(sseResponse, new AbortController());
        const onError = vi.fn();

        const protocolStream = AnthropicStream(sdkStream, {
          callbacks: { onError },
          payload: { provider: 'anthropic' },
        });
        await consumeStreamUntilDone(new Response(protocolStream));

        expect(onError).toHaveBeenCalledOnce();
        const classified = classifyLLMError(toStreamExecutionError(onError.mock.calls[0][0]));
        expect(classified).toMatchObject({
          kind: expectedKind,
          retrySafe,
          status,
        });
      },
    );

    it.each([
      {
        expectedKind: 'stop' as const,
        grpcStatus: 'DEADLINE_EXCEEDED',
        reason: 'upstream_timeout',
        retrySafe: false,
        status: 504,
      },
      {
        expectedKind: 'retry' as const,
        grpcStatus: 'UNAVAILABLE',
        reason: 'upstream_unavailable',
        retrySafe: true,
        status: 502,
      },
    ])(
      'LobeGoogleAI classifies $status $reason (retrySafe=$retrySafe) via arckepProxyError as $expectedKind',
      async ({ status, grpcStatus, reason, retrySafe, expectedKind }) => {
        const errorBody = {
          code: status,
          details: [
            {
              hasOutput: false,
              hasUsage: false,
              reason,
              retryOwner: 'engine',
              retrySafe,
            },
          ],
          message:
            status === 504
              ? 'Upstream provider google timed out.'
              : 'Upstream provider google unavailable.',
          status: grpcStatus,
        };
        const wireChunk = {
          error: errorBody,
          promptFeedback: {
            blockReason: 'OTHER',
            blockReasonMessage: JSON.stringify({ arckepProxyError: 1, error: errorBody }),
          },
        };
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
          new Response(`: ping\n\ndata: ${JSON.stringify(wireChunk)}\n\n`, {
            headers: { 'content-type': 'text/event-stream' },
          }),
        );
        try {
          const google = new LobeGoogleAI({
            apiKey: 'test',
            baseURL: 'http://proxy.test',
            defaultHeaders: { 'X-Arckep-Token': 'internal-test', 'x-arckep-retry-owner': 'engine' },
          });
          const onError = vi.fn();
          const res = await google.chat(
            {
              messages: [{ content: 'hi', role: 'user' }],
              model: 'gemini-4-argon',
            },
            { callback: { onError } },
          );
          await consumeStreamUntilDone(res);

          expect(onError).toHaveBeenCalledOnce();
          const classified = classifyLLMError(toStreamExecutionError(onError.mock.calls[0][0]));
          expect(classified).toMatchObject({
            kind: expectedKind,
            retrySafe,
            status,
          });
        } finally {
          fetchSpy.mockRestore();
        }
      },
    );
  });
});
