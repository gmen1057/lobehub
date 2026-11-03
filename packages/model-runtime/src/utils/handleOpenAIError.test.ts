import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';

import { AgentRuntimeErrorType } from '../types/error';
import { handleOpenAIError } from './handleOpenAIError';

describe('handleOpenAIError', () => {
  describe('OpenAI APIError handling', () => {
    it('should handle OpenAI APIError with error object', () => {
      const apiError = new OpenAI.APIError(
        472,
        { error: { message: 'API error', type: 'invalid_request' } },
        'test-message',
        { status: 400 } as any,
      );

      const result = handleOpenAIError(apiError);

      expect(result).toEqual({
        errorResult: { error: { message: 'API error', type: 'invalid_request' }, status: 472 },
      });
      expect(result.RuntimeError).toBeUndefined();
    });

    it('should handle OpenAI APIError with cause', () => {
      const cause = { message: 'Network error', code: 'ECONNRESET' };
      const apiError = new OpenAI.APIError(472, null as any, 'test-message', {
        status: 500,
      } as any);
      (apiError as any).cause = cause;

      const result = handleOpenAIError(apiError);

      expect(result).toEqual({
        errorResult: { ...cause, status: 472 },
      });
      expect(result.RuntimeError).toBeUndefined();
    });

    it('should handle OpenAI APIError without error or cause', () => {
      const headers = { 'content-type': 'application/json' };
      const apiError = new OpenAI.APIError(472, null as any, 'test-message', {
        status: 401,
        headers,
      } as any);

      const result = handleOpenAIError(apiError);

      expect(result.errorResult).toEqual({
        headers: { headers, status: 401 },
        status: 472,
      });
      expect(result.RuntimeError).toBeUndefined();
    });

    it('should handle OpenAI APIError with both error and cause', () => {
      const errorObject = { message: 'API error', type: 'rate_limit' };
      const cause = { message: 'Rate limit exceeded' };
      const apiError = new OpenAI.APIError(472, { error: errorObject }, 'test-message', {
        status: 429,
      } as any);
      (apiError as any).cause = cause;

      const result = handleOpenAIError(apiError);

      // Should prioritize error over cause
      expect(result).toEqual({
        errorResult: { error: errorObject, status: 472 },
      });
    });

    it('preserves the HTTP status without mutating the provider body', () => {
      const body = { message: 'Model unavailable', status: 'NOT_FOUND' };
      const apiError = new OpenAI.APIError(404, body, 'not found', {});
      expect(handleOpenAIError(apiError).errorResult).toEqual({
        message: 'Model unavailable',
        status: 404,
      });
      expect(body.status).toBe('NOT_FOUND');
    });

    it('keeps a plain-text rejection readable and preserves its HTTP status', () => {
      const apiError = new OpenAI.APIError(403, 'Access denied', undefined, {});
      expect(handleOpenAIError(apiError).errorResult).toEqual({
        message: 'Access denied',
        status: 403,
      });
    });

    it('does not introduce an HTTP status when the SDK has none', () => {
      const apiError = new OpenAI.APIError(
        undefined,
        { message: 'Connection failed' },
        undefined,
        undefined,
      );
      expect(handleOpenAIError(apiError).errorResult).toEqual({ message: 'Connection failed' });
    });
  });

  describe('Non-OpenAI error handling', () => {
    it('should handle generic Error', () => {
      const error = new Error('Generic error');
      error.cause = { details: 'Error details' };

      const result = handleOpenAIError(error);

      expect(result).toEqual({
        RuntimeError: AgentRuntimeErrorType.AgentRuntimeError,
        errorResult: {
          cause: { details: 'Error details' },
          message: 'Generic error',
          name: 'Error',
        },
      });
    });

    it('should handle Error without cause', () => {
      const error = new Error('Simple error');

      const result = handleOpenAIError(error);

      expect(result).toEqual({
        RuntimeError: AgentRuntimeErrorType.AgentRuntimeError,
        errorResult: {
          cause: undefined,
          message: 'Simple error',
          name: 'Error',
        },
      });
    });

    it('should handle custom Error types', () => {
      class CustomError extends Error {
        constructor(message: string) {
          super(message);
          this.name = 'CustomError';
        }
      }

      const error = new CustomError('Custom error message');
      const result = handleOpenAIError(error);

      expect(result).toEqual({
        RuntimeError: AgentRuntimeErrorType.AgentRuntimeError,
        errorResult: {
          cause: undefined,
          message: 'Custom error message',
          name: 'CustomError',
        },
      });
    });

    it('should handle non-Error objects', () => {
      const errorObject = {
        message: 'Object error',
        code: 'CUSTOM_ERROR',
      };

      const result = handleOpenAIError(errorObject);

      expect(result).toEqual({
        RuntimeError: AgentRuntimeErrorType.AgentRuntimeError,
        errorResult: {
          cause: undefined,
          message: 'Object error',
          name: undefined,
        },
      });
    });
  });
});
