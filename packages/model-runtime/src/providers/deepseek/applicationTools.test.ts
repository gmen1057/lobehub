// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { convertOpenAIMessages } from '../../core/contextBuilders/openai';
import { transformResponseToStream } from '../../core/openaiCompatibleFactory/nonStreamToStream';
import { OpenAIStream } from '../../core/streams/openai/openai';
import { createReadableStream } from '../../core/streams/utils';
import { params } from './index';

const step = {
  index: 0,
  reasoning_content: 'step',
  calls: [
    {
      index: 0,
      id: 'srv_1',
      type: 'deepseek_read_url',
      kind: 'read_link',
      action: { type: 'read_link', url: 'https://example.com' },
      status: 'completed',
      signature: 'opaque-signed-page',
      page: { url: 'https://example.com', title: 'Source' },
    },
  ],
};
const annotations = [
  {
    type: 'url_citation',
    url_citation: { url: 'https://example.com', title: 'Source', start_index: 1, end_index: 3 },
  },
];
const payload = { model: 'deepseek-flash', provider: 'deepseek' };
const chunk = (delta: any, extra = {}) => ({ id: 'ds', choices: [{ index: 0, delta, ...extra }] });
const consume = async (stream: ReadableStream) => {
  for await (const _ of stream as any) {
    /* trigger callbacks */
  }
};

describe('DeepSeek application tools', () => {
  it('declares search/read separately, keeps functions, and safety stays opt-in', () => {
    const fn = { type: 'function', function: { name: 'weather', parameters: {} } };
    const handle = (p: any) =>
      params.chatCompletion.handlePayload({
        model: 'deepseek-flash',
        messages: [],
        ...p,
      } as any) as any;
    expect(handle({})).not.toHaveProperty('safety_check');
    expect(handle({ read_url: true, tools: [fn] }).tools).toEqual([
      fn,
      { type: 'deepseek_read_url' },
    ]);
    expect(handle({ enabledSearch: true, safety_check: true })).toMatchObject({
      tools: [{ type: 'deepseek_web_search' }],
      safety_check: { level: 'high' },
    });
    expect(() => handle({ model: 'deepseek-v4-pro', read_url: true })).toThrow();
    expect(handle({ model: 'deepseek-v4-pro', enabledSearch: true }).tools).toBeUndefined();
  });

  it('keeps complete signed steps, Unicode citation offsets and progress through stream and history conversion', async () => {
    const grounding = vi.fn();
    const completion = vi.fn();
    const tools = vi.fn();
    const event = { type: 'call_completed', step: 0, call: step.calls[0] };
    await consume(
      OpenAIStream(
        createReadableStream([
          chunk({ content: 'A😀Б' }),
          chunk({}, { server_tool_event: event }),
          chunk({ annotations, server_tool_calls: [step] }, { finish_reason: 'stop' }),
          {
            id: 'ds',
            model: 'deepseek-flash',
            choices: [],
            usage: {
              prompt_tokens: 1,
              completion_tokens: 2,
              server_tool_use: { tool_search: 0, tool_fetch: 1, tool_image_search: 0 },
            },
          },
        ]),
        {
          payload,
          callbacks: { onGrounding: grounding, onCompletion: completion, onToolsCalling: tools },
        },
      ),
    );
    expect(tools).not.toHaveBeenCalled();
    const data = grounding.mock.calls.at(-1)![0];
    expect(data).toMatchObject({
      citations: [{ start_index: 1, end_index: 3 }],
      deepseek: {
        server_tool_calls: [step],
        server_tool_events: [event],
        usage: { server_tool_use: { tool_fetch: 1 } },
      },
    });
    const converted = await convertOpenAIMessages([
      {
        role: 'assistant',
        content: 'A😀Б',
        server_tool_calls: data.deepseek.server_tool_calls,
        annotations,
      } as any,
    ]);
    expect(converted[0]).toMatchObject({ server_tool_calls: [step], annotations });
    expect(completion.mock.calls[0][0].text).toBe('A😀Б');
  });

  it('withdraws already streamed answer and reasoning on terminal content_filter, keeping executed calls', async () => {
    const completion = vi.fn();
    const grounding = vi.fn();
    await consume(
      OpenAIStream(
        createReadableStream([
          chunk({ content: 'unsafe partial', reasoning_content: 'private thinking' }),
          chunk(
            { content: '', server_tool_calls: [step], refusal: 'blocked' },
            { finish_reason: 'content_filter' },
          ),
        ]),
        { payload, callbacks: { onCompletion: completion, onGrounding: grounding } },
      ),
    );
    expect(completion.mock.calls[0][0]).toMatchObject({ text: '', thinking: undefined });
    expect(grounding.mock.calls.at(-1)![0]).toMatchObject({
      citations: [],
      deepseek: {
        finish_reason: 'content_filter',
        server_tool_calls: [{ reasoning_content: '', calls: step.calls }],
      },
    });
  });

  it('retains native fields for non-streaming responses and reports HTTP200 SSE errors', async () => {
    const grounding = vi.fn();
    const error = vi.fn();
    await consume(
      OpenAIStream(
        transformResponseToStream({
          model: 'deepseek-flash',
          id: 'ds',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: 'answer',
                annotations,
                server_tool_calls: [step],
              },
              finish_reason: 'stop',
            },
          ],
        } as any),
        { payload, callbacks: { onGrounding: grounding } },
      ),
    );
    expect(grounding.mock.calls.at(-1)![0].deepseek.server_tool_calls).toEqual([step]);
    await consume(
      OpenAIStream(
        createReadableStream([{ error: { message: 'unavailable', type: 'server_error' } }]),
        { payload, callbacks: { onError: error } },
      ),
    );
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ message: 'unavailable' }));
  });
});

it('preserves parallel client function call IDs across fragmented native-tool chunks', async () => {
  const completion = vi.fn();
  await consume(
    OpenAIStream(
      createReadableStream([
        chunk({
          tool_calls: [
            {
              index: 0,
              id: 'fn_1',
              type: 'function',
              function: { name: 'weather', arguments: '{"city":' },
            },
          ],
        }),
        chunk({}, { server_tool_event: { type: 'step_reasoning_done', step: 0 } }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '"Berlin"}' } }] }),
        chunk({}, { finish_reason: 'tool_calls' }),
      ]),
      { payload, callbacks: { onCompletion: completion } },
    ),
  );
  expect(completion.mock.calls[0][0].toolsCalling).toMatchObject([
    { id: 'fn_1', function: { name: 'weather', arguments: '{"city":"Berlin"}' } },
  ]);
});

it('reports a truncated native stream even when usage arrived before the missing terminal chunk', async () => {
  const error = vi.fn();
  await consume(
    OpenAIStream(
      createReadableStream([
        chunk({ content: 'partial' }),
        { id: 'ds', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } },
      ]),
      { payload, callbacks: { onError: error } },
    ),
  );
  expect(error).toHaveBeenCalledWith(
    expect.objectContaining({ message: 'Stream ended unexpectedly' }),
  );
});

it('replays only final-step reasoning alongside complete prior steps', async () => {
  const completion = vi.fn();
  await consume(
    OpenAIStream(
      createReadableStream([
        chunk({ reasoning_content: 'first step' }),
        chunk({}, { server_tool_event: { type: 'step_reasoning_done', step: 0 } }),
        chunk({ reasoning_content: 'final step' }),
        chunk({ content: 'answer', server_tool_calls: [step] }, { finish_reason: 'stop' }),
      ]),
      { payload, callbacks: { onCompletion: completion } },
    ),
  );
  expect(completion.mock.calls[0][0].grounding.deepseek.reasoning_content).toBe('final step');
});
