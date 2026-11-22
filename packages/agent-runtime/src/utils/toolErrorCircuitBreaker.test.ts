import type { ChatToolPayload } from '@lobechat/types';
import { describe, expect, it } from 'vitest';

import {
  buildToolErrorCircuitBreakerPrompt,
  getToolErrorKey,
  isToolErrorCircuitBreakerTripped,
  isToolResultFailure,
  TOOL_ERROR_CIRCUIT_BREAKER_LIMIT,
  type ToolResultLike,
  updateToolErrorCircuitBreaker,
} from './toolErrorCircuitBreaker';

const createToolCall = (overrides?: Partial<ChatToolPayload>): ChatToolPayload => ({
  apiName: 'create_3d',
  arguments: '{"prompt":"chair"}',
  id: 'call-1',
  identifier: 'mcp-arckep-studio-3d',
  type: 'mcp',
  ...overrides,
});

const createFailedResult = (
  toolOverrides?: Partial<ChatToolPayload>,
  resultOverrides?: Partial<ToolResultLike>,
): ToolResultLike => ({
  data: {
    content: 'Error executing tool create_3d: Public API HTTP 422: validation failed',
    error: { code: 'BAD_REQUEST', message: 'HTTP 422' },
    success: false,
  },
  isSuccess: false,
  toolCall: createToolCall(toolOverrides),
  ...resultOverrides,
});

const createMcpIsErrorResult = (toolOverrides?: Partial<ChatToolPayload>): ToolResultLike => ({
  // Mirrors ToolExecutionService.executeMCPTool: success remains true so executeToolWithRetry
  // does not auto-retry MCP errors, while state.isError === true marks the tool error.
  data: {
    content: 'Error executing tool create_3d: Public API HTTP 422: invalid parameters',
    executionTime: 120,
    state: {
      content: [
        {
          text: 'Error executing tool create_3d: Public API HTTP 422: invalid parameters',
          type: 'text',
        },
      ],
      isError: true,
    },
    success: true,
  },
  isSuccess: true,
  toolCall: createToolCall(toolOverrides),
});

const createSuccessResult = (toolOverrides?: Partial<ChatToolPayload>): ToolResultLike => ({
  data: {
    content: '{"job_id":"job_123"}',
    executionTime: 85,
    state: {
      content: [{ text: '{"job_id":"job_123"}', type: 'text' }],
      isError: false,
    },
    success: true,
  },
  isSuccess: true,
  toolCall: createToolCall(toolOverrides),
});

describe('toolErrorCircuitBreaker', () => {
  describe('getToolErrorKey', () => {
    it('formats identifier and apiName as identifier::apiName', () => {
      expect(getToolErrorKey(createToolCall())).toBe('mcp-arckep-studio-3d::create_3d');
    });

    it('handles missing identifier or apiName gracefully', () => {
      expect(getToolErrorKey({ apiName: 'create_3d', identifier: '' })).toBe('create_3d');
      expect(getToolErrorKey({ apiName: '', identifier: 'mcp-arckep-studio-3d' })).toBe(
        'mcp-arckep-studio-3d',
      );
      expect(getToolErrorKey(undefined)).toBeUndefined();
    });
  });

  describe('isToolResultFailure', () => {
    it('detects standard isSuccess: false failures', () => {
      expect(isToolResultFailure(createFailedResult())).toBe(true);
    });

    it('detects MCP tool errors where isSuccess is true but data.state.isError is true', () => {
      expect(isToolResultFailure(createMcpIsErrorResult())).toBe(true);
    });

    it('detects top-level data.isError: true and data.success: false', () => {
      expect(
        isToolResultFailure({
          data: { content: 'bad', isError: true },
          isSuccess: true,
          toolCall: createToolCall(),
        }),
      ).toBe(true);
      expect(
        isToolResultFailure({
          data: { content: 'bad', success: false },
          isSuccess: true,
          toolCall: createToolCall(),
        }),
      ).toBe(true);
    });

    it('detects failures in built-in AgentRuntime result shape', () => {
      expect(
        isToolResultFailure({
          result: { isError: true, text: 'failed' },
          toolCall: createToolCall(),
        }),
      ).toBe(true);
      expect(
        isToolResultFailure({
          result: { success: false },
          toolCall: createToolCall(),
        }),
      ).toBe(true);
    });

    it('treats normal successful results (including isError: false) as non-failures', () => {
      expect(isToolResultFailure(createSuccessResult())).toBe(false);
      expect(
        isToolResultFailure({
          result: { ok: true },
          toolCall: createToolCall(),
        }),
      ).toBe(false);
    });
  });

  describe('updateToolErrorCircuitBreaker', () => {
    it('allows 1-3 consecutive failures and trips on the 4th consecutive failure (isSuccess: false)', () => {
      let breaker = updateToolErrorCircuitBreaker(undefined, [createFailedResult()]);
      expect(breaker).toEqual({
        consecutiveErrors: 1,
        toolKey: 'mcp-arckep-studio-3d::create_3d',
      });
      expect(isToolErrorCircuitBreakerTripped(breaker)).toBe(false);

      breaker = updateToolErrorCircuitBreaker(breaker, [createFailedResult()]);
      expect(breaker?.consecutiveErrors).toBe(2);
      expect(isToolErrorCircuitBreakerTripped(breaker)).toBe(false);

      breaker = updateToolErrorCircuitBreaker(breaker, [createFailedResult()]);
      expect(breaker?.consecutiveErrors).toBe(3);
      expect(isToolErrorCircuitBreakerTripped(breaker)).toBe(false);

      breaker = updateToolErrorCircuitBreaker(breaker, [createFailedResult()]);
      expect(breaker).toEqual({
        consecutiveErrors: TOOL_ERROR_CIRCUIT_BREAKER_LIMIT,
        toolKey: 'mcp-arckep-studio-3d::create_3d',
        tripped: true,
      });
      expect(isToolErrorCircuitBreakerTripped(breaker)).toBe(true);
    });

    it('trips on the 4th consecutive MCP isError: true failure even with isSuccess: true', () => {
      let breaker: ReturnType<typeof updateToolErrorCircuitBreaker>;

      for (let attempt = 1; attempt <= 3; attempt++) {
        breaker = updateToolErrorCircuitBreaker(breaker, [createMcpIsErrorResult()]);
        expect(breaker?.consecutiveErrors).toBe(attempt);
        expect(isToolErrorCircuitBreakerTripped(breaker)).toBe(false);
      }

      breaker = updateToolErrorCircuitBreaker(breaker, [createMcpIsErrorResult()]);
      expect(breaker).toEqual({
        consecutiveErrors: 4,
        toolKey: 'mcp-arckep-studio-3d::create_3d',
        tripped: true,
      });
      expect(isToolErrorCircuitBreakerTripped(breaker)).toBe(true);
    });

    it('resets consecutive counter to 0 on any successful tool execution', () => {
      let breaker = updateToolErrorCircuitBreaker(undefined, [createMcpIsErrorResult()]);
      breaker = updateToolErrorCircuitBreaker(breaker, [createMcpIsErrorResult()]);
      breaker = updateToolErrorCircuitBreaker(breaker, [createMcpIsErrorResult()]);
      expect(breaker?.consecutiveErrors).toBe(3);

      breaker = updateToolErrorCircuitBreaker(breaker, [createSuccessResult()]);
      expect(breaker).toEqual({ consecutiveErrors: 0 });
      expect(isToolErrorCircuitBreakerTripped(breaker)).toBe(false);

      // Next failure starts fresh at 1
      breaker = updateToolErrorCircuitBreaker(breaker, [createMcpIsErrorResult()]);
      expect(breaker).toEqual({
        consecutiveErrors: 1,
        toolKey: 'mcp-arckep-studio-3d::create_3d',
      });
    });

    it('resets and isolates consecutive failures when switching to a different tool', () => {
      let breaker: ReturnType<typeof updateToolErrorCircuitBreaker>;
      for (let i = 0; i < 3; i++) {
        breaker = updateToolErrorCircuitBreaker(breaker, [createFailedResult()]);
      }
      expect(breaker?.consecutiveErrors).toBe(3);

      breaker = updateToolErrorCircuitBreaker(breaker, [
        createFailedResult({ apiName: 'search', identifier: 'lobe-web-browsing' }),
      ]);
      expect(breaker).toEqual({
        consecutiveErrors: 1,
        toolKey: 'lobe-web-browsing::search',
      });
      expect(isToolErrorCircuitBreakerTripped(breaker)).toBe(false);

      // Returning to create_3d starts at 1
      breaker = updateToolErrorCircuitBreaker(breaker, [createFailedResult()]);
      expect(breaker).toEqual({
        consecutiveErrors: 1,
        toolKey: 'mcp-arckep-studio-3d::create_3d',
      });
    });

    it('handles mixed batches: resets if any succeeds, increments if all fail on same tool, resets if all fail on different tools', () => {
      const prior = {
        consecutiveErrors: 3,
        toolKey: 'mcp-arckep-studio-3d::create_3d',
      };

      // Mixed batch where one succeeds -> resets to 0
      expect(
        updateToolErrorCircuitBreaker(prior, [
          createMcpIsErrorResult(),
          createSuccessResult({ apiName: 'list_models' }),
        ]),
      ).toEqual({ consecutiveErrors: 0 });

      // Batch where all fail on the same tool -> increments by batch size and trips
      expect(
        updateToolErrorCircuitBreaker(prior, [
          createMcpIsErrorResult({ id: 'call-1' }),
          createMcpIsErrorResult({ id: 'call-2' }),
        ]),
      ).toEqual({
        consecutiveErrors: 5,
        toolKey: 'mcp-arckep-studio-3d::create_3d',
        tripped: true,
      });

      // Single parallel batch of 4 failing calls to the same tool trips immediately
      expect(
        updateToolErrorCircuitBreaker(undefined, [
          createMcpIsErrorResult({ id: 'call-1' }),
          createMcpIsErrorResult({ id: 'call-2' }),
          createMcpIsErrorResult({ id: 'call-3' }),
          createMcpIsErrorResult({ id: 'call-4' }),
        ]),
      ).toEqual({
        consecutiveErrors: 4,
        toolKey: 'mcp-arckep-studio-3d::create_3d',
        tripped: true,
      });

      // Batch mixing a known failing tool with an entry missing toolCall -> resets instead of attributing all failures to the known tool
      expect(
        updateToolErrorCircuitBreaker(prior, [
          createMcpIsErrorResult({ id: 'call-1' }),
          {
            data: { content: 'error without toolCall', success: false },
            isSuccess: false,
            toolCall: undefined,
          },
        ]),
      ).toEqual({ consecutiveErrors: 0 });

      // Batch where all fail on different tools -> resets single-tool streak
      expect(
        updateToolErrorCircuitBreaker(prior, [
          createMcpIsErrorResult(),
          createFailedResult({ apiName: 'search', identifier: 'lobe-web-browsing' }),
        ]),
      ).toEqual({ consecutiveErrors: 0 });
    });

    it('ignores synthetic unresolved tool feedback entries', () => {
      const prior = {
        consecutiveErrors: 3,
        toolKey: 'mcp-arckep-studio-3d::create_3d',
      };

      const afterSynthetic = updateToolErrorCircuitBreaker(prior, [
        {
          data: { content: 'unresolved', success: false },
          isSuccess: false,
          synthetic: true,
          toolCall: { apiName: 'missing', identifier: '__arckep_unresolved_tool__' },
        },
      ]);

      expect(afterSynthetic).toEqual(prior);
    });
  });

  describe('buildToolErrorCircuitBreakerPrompt', () => {
    it('includes the failing tool key, consecutive attempt count, and no-tool instruction', () => {
      const prompt = buildToolErrorCircuitBreakerPrompt({
        consecutiveErrors: 4,
        toolKey: 'mcp-arckep-studio-3d::create_3d',
        tripped: true,
      });

      expect(prompt).toContain('mcp-arckep-studio-3d::create_3d');
      expect(prompt).toContain('4 times in a row');
      expect(prompt).toContain('Do not attempt to call any tools');
    });
  });
});
