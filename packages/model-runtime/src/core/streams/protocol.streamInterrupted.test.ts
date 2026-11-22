import type Anthropic from '@anthropic-ai/sdk';
import type { Stream as AnthropicSDKStream } from '@anthropic-ai/sdk/streaming';
import type { Stream as OpenAISDKStream } from 'openai/streaming';
import { describe, expect, it, vi } from 'vitest';

import { LobeGoogleAI } from '../../providers/google';
import { AgentRuntimeErrorType } from '../../types/error';
import { consumeStreamUntilDone } from '../../utils/consumeStream';
import { AnthropicStream } from './anthropic';
import { OpenAIStream } from './openai/openai';
import { OpenAIResponsesStream } from './openai/responsesStream';
import {
  convertIterableToStream,
  createFirstErrorHandleTransformer,
  isProviderStreamInterruptedError,
  readableFromAsyncIterable,
} from './protocol';

describe('REL-2A: ProviderStreamInterrupted classification across stream protocols & providers', () => {
  it.each([
    new TypeError('terminated', {
      cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
    }),
    Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
    Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }),
    new Error('socket hang up'),
    new Error('incomplete chunked read'),
    new Error('premature close'),
    new Error('LLM stream error: terminated'),
    {
      body: { name: 'Stream parsing error', reason: 'unexpected_end' },
      message: 'Stream ended unexpectedly',
      type: 'StreamChunkError',
    },
  ])('identifies network/mid-stream drop %# as ProviderStreamInterrupted', (err) => {
    expect(isProviderStreamInterruptedError(err)).toBe(true);
  });

  it.each([
    Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }),
    Object.assign(new Error('Request was aborted.'), { name: 'APIUserAbortError' }),
    Object.assign(new Error('aborted'), { code: 'UND_ERR_ABORTED' }),
    Object.assign(new Error('canceled'), { code: 'ABORT_ERR' }),
    { body: { reason: 'aborted' }, message: 'Stream cancelled', type: 'StreamChunkError' },
    new Error('Agent execution interrupted'),
    { code: 'ECONNRESET', message: 'Invalid request', status: 400 },
    { message: 'Rate limit exceeded', status: 429 },
    new Error('Unterminated string in JSON at position 42'),
  ])('never misclassifies user abort or HTTP 4xx %# as ProviderStreamInterrupted', (err) => {
    expect(isProviderStreamInterruptedError(err)).toBe(false);
  });

  it('preserves cause.code and tags ProviderStreamInterrupted in convertIterableToStream & readableFromAsyncIterable', async () => {
    const undiciDrop = new TypeError('terminated', {
      cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
    });

    async function* brokenGenerator() {
      yield { choices: [{ delta: { content: 'Hello' }, index: 0 }], id: 'chat_1' };
      throw undiciDrop;
    }

    const transformed: any[] = [];
    const reader = convertIterableToStream(brokenGenerator())
      .pipeThrough(createFirstErrorHandleTransformer(undefined, 'openai'))
      .getReader();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      transformed.push(value);
    }

    expect(transformed).toHaveLength(2);
    expect(transformed[1]).toMatchObject({
      code: 'UND_ERR_SOCKET',
      errorType: AgentRuntimeErrorType.ProviderStreamInterrupted,
      message: 'terminated',
      provider: 'openai',
    });

    async function* brokenReadable() {
      if (Date.now() < 0) yield 'unreachable';
      throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    }
    const r2 = readableFromAsyncIterable(brokenReadable())
      .pipeThrough(createFirstErrorHandleTransformer(undefined, 'deepseek'))
      .getReader();
    const single = await r2.read();
    expect(single.value).toMatchObject({
      code: 'ECONNRESET',
      errorType: AgentRuntimeErrorType.ProviderStreamInterrupted,
      provider: 'deepseek',
    });
  });

  it('surfaces ProviderStreamInterrupted after partial text across OpenAI Chat, OpenAI Responses, Anthropic, DeepSeek, and Google Gemini', async () => {
    const makeDroppingStream = <T>(firstChunk: T) => ({
      async *[Symbol.asyncIterator]() {
        yield firstChunk;
        throw new TypeError('terminated', {
          cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
        });
      },
    });

    // 1. OpenAI Chat
    const openaiText: string[] = [];
    const openaiError = vi.fn();
    const openaiRes = new Response(
      OpenAIStream(
        makeDroppingStream({
          choices: [{ delta: { content: 'OpenAI partial' }, index: 0 }],
          id: 'cmpl_1',
        }) as unknown as OpenAISDKStream<any>,
        {
          callbacks: { onError: openaiError, onText: (t) => void openaiText.push(t) },
          payload: { model: 'gpt-5.4', provider: 'openai' },
        },
      ),
    );
    await consumeStreamUntilDone(openaiRes);
    expect(openaiText.join('')).toBe('OpenAI partial');
    expect(openaiError).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'UND_ERR_SOCKET',
        type: AgentRuntimeErrorType.ProviderStreamInterrupted,
      }),
    );

    // 2. OpenAI Responses
    const responsesText: string[] = [];
    const responsesError = vi.fn();
    const responsesRes = new Response(
      OpenAIResponsesStream(
        makeDroppingStream({
          delta: 'Responses partial',
          item_id: 'msg_1',
          type: 'response.output_text.delta',
        }) as unknown as OpenAISDKStream<any>,
        {
          callbacks: { onError: responsesError, onText: (t) => void responsesText.push(t) },
          payload: { model: 'gpt-5.4', provider: 'openai' },
        },
      ),
    );
    await consumeStreamUntilDone(responsesRes);
    expect(responsesText.join('')).toBe('Responses partial');
    expect(responsesError).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'UND_ERR_SOCKET',
        type: AgentRuntimeErrorType.ProviderStreamInterrupted,
      }),
    );

    // 3. Anthropic
    const anthropicText: string[] = [];
    const anthropicError = vi.fn();
    const anthropicRes = new Response(
      AnthropicStream(
        makeDroppingStream({
          delta: { text: 'Claude partial', type: 'text_delta' },
          index: 0,
          type: 'content_block_delta',
        } as Anthropic.MessageStreamEvent) as unknown as AnthropicSDKStream<Anthropic.MessageStreamEvent>,
        {
          callbacks: { onError: anthropicError, onText: (t) => void anthropicText.push(t) },
          payload: { model: 'claude-sonnet-4-6', provider: 'anthropic' },
        },
      ),
    );
    await consumeStreamUntilDone(anthropicRes);
    expect(anthropicText.join('')).toBe('Claude partial');
    expect(anthropicError).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'UND_ERR_SOCKET',
        type: AgentRuntimeErrorType.ProviderStreamInterrupted,
      }),
    );

    // 4. DeepSeek truncated stream without finish_reason (requireTerminalEvent)
    const deepseekText: string[] = [];
    const deepseekError = vi.fn();
    async function* truncatedDeepSeek() {
      yield { choices: [{ delta: { content: 'DeepSeek partial' }, index: 0 }], id: 'ds_1' };
      // EOF without finish_reason and without throwing
    }
    const deepseekRes = new Response(
      OpenAIStream(truncatedDeepSeek() as unknown as OpenAISDKStream<any>, {
        callbacks: { onError: deepseekError, onText: (t) => void deepseekText.push(t) },
        payload: { model: 'deepseek-flash', provider: 'deepseek' },
      }),
    );
    await consumeStreamUntilDone(deepseekRes);
    expect(deepseekText.join('')).toBe('DeepSeek partial');
    expect(deepseekError).toHaveBeenCalledOnce();
    expect(isProviderStreamInterruptedError(deepseekError.mock.calls[0][0])).toBe(true);

    // 5. Google Gemini mid-stream drop vs user AbortError
    const encoder = new TextEncoder();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => {
      let sentFirst = false;
      return new Response(
        new ReadableStream({
          pull(controller) {
            if (!sentFirst) {
              sentFirst = true;
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    candidates: [
                      { content: { parts: [{ text: 'Gemini partial' }], role: 'model' }, index: 0 },
                    ],
                  })}\n\n`,
                ),
              );
              return;
            }
            controller.error(
              new TypeError('terminated', {
                cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
              }),
            );
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    });

    try {
      const google = new LobeGoogleAI({ apiKey: 'test', baseURL: 'http://proxy.test' });
      const geminiText: string[] = [];
      const geminiError = vi.fn();
      const geminiRes = await google.chat(
        { messages: [{ content: 'hi', role: 'user' }], model: 'gemini-3-pro' },
        { callback: { onError: geminiError, onText: (t) => void geminiText.push(t) } },
      );
      await consumeStreamUntilDone(geminiRes);
      expect(geminiText.join('')).toBe('Gemini partial');
      expect(geminiError).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'UND_ERR_SOCKET',
          type: AgentRuntimeErrorType.ProviderStreamInterrupted,
        }),
      );
    } finally {
      fetchSpy.mockRestore();
    }
    expect(
      isProviderStreamInterruptedError(
        Object.assign(new Error('read ECONNABORTED'), { code: 'ECONNABORTED' }),
      ),
    ).toBe(true);
  });

  it('classifies Google Gemini mid-stream ECONNABORTED (when signal is not aborted) as ProviderStreamInterrupted instead of AbortError', async () => {
    const encoder = new TextEncoder();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => {
      let sentFirst = false;
      return new Response(
        new ReadableStream({
          pull(controller) {
            if (!sentFirst) {
              sentFirst = true;
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    candidates: [
                      {
                        content: { parts: [{ text: 'Gemini before ECONNABORTED' }], role: 'model' },
                        index: 0,
                      },
                    ],
                  })}\n\n`,
                ),
              );
              return;
            }
            controller.error(
              Object.assign(new Error('read ECONNABORTED'), { code: 'ECONNABORTED' }),
            );
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    });

    try {
      const abortController = new AbortController();
      const google = new LobeGoogleAI({ apiKey: 'test', baseURL: 'http://proxy.test' });
      const geminiError = vi.fn();
      const res = await google.chat(
        { messages: [{ content: 'hi', role: 'user' }], model: 'gemini-3-pro' },
        { callback: { onError: geminiError }, signal: abortController.signal },
      );
      await consumeStreamUntilDone(res);
      expect(abortController.signal.aborted).toBe(false);
      expect(geminiError).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'ECONNABORTED',
          type: AgentRuntimeErrorType.ProviderStreamInterrupted,
        }),
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
