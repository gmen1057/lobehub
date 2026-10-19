import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';

import { handleAnthropicError } from '../../../../../packages/model-runtime/src/core/anthropicCompatibleFactory/handleAnthropicError';
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

  // arckep (19.10.2026): нехватка баланса — повторять бессмысленно (раньше 6 попыток по ~30 с подряд)
  describe('нехватка баланса (HTTP 402 прокси студии)', () => {
    const BALANCE_MESSAGE =
      'Недостаточно средств на балансе. Пополните баланс: https://arckep.ru/settings#balance';
    const body = {
      error: { code: 'billing_error', message: BALANCE_MESSAGE, type: 'insufficient_balance' },
    };

    // что model-runtime кидает наверх, когда провайдер ответил 402: тело ошибки в `error`, тип — ProviderBizError
    // (общий для повторяемых и неповторяемых ошибок), HTTP-статус при оборачивании теряется
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

    it('openai-совместимый провайдер: ProviderBizError без статуса, признаки в error → stop', () => {
      const payload = openAICompatiblePayload();
      // страховка от случайного изменения формы: статуса в обёртке нет, а тип именно «повторяемый»
      expect(payload.errorType).toBe('ProviderBizError');
      expect(payload.error.status).toBeUndefined();

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
});
