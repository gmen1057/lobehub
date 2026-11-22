import { describe, expect, it, vi } from 'vitest';

// Now import the real service — only the stubs above are faked
import { ResponsesService } from '../responses.service';

// Stub external dependencies so ResponsesService can be imported in isolation
vi.mock('@/server/modules/AgentRuntime/InMemoryStreamEventManager', () => ({
  InMemoryStreamEventManager: class {},
}));
vi.mock('@/server/modules/AgentRuntime/StreamEventManager', () => ({}));
vi.mock('@/server/services/agentRuntime', () => ({ AgentRuntimeService: class {} }));
vi.mock('@/server/services/aiAgent', () => ({ AiAgentService: class {} }));
// arckep: extractAttachments тянет модель файлов и файловый сервис — здесь они не нужны
vi.mock('@/database/models/file', () => ({ FileModel: class {} }));
vi.mock('@/server/services/file', () => ({ FileService: class {} }));
vi.mock('../../common/base.service', () => ({
  BaseService: class {
    db: any;
    userId = '';
    constructor() {}
    log() {}
  },
}));

// Helper: call the private extractOutputItems via bracket notation
const callExtractOutputItems = (messages: any[], responseId: string) => {
  const svc = new (ResponsesService as any)(null, null);
  return svc['extractOutputItems']({ messages }, responseId);
};

describe('ResponsesService.extractOutputItems', () => {
  describe('assistant message with tool_calls should still emit message item', () => {
    it('should include both message and function_call when assistant has text + tool_calls', () => {
      const messages = [
        {
          content: '好的，我来在沙箱中随机生成一个散点图！',
          role: 'assistant',
          tool_calls: [
            {
              function: {
                arguments: '{"code":"import matplotlib.pyplot as plt\\nprint(1)"}',
                name: 'lobe-cloud-sandbox____executeCode____builtin',
              },
              id: 'call_abc123',
            },
          ],
        },
      ];

      const { output } = callExtractOutputItems(messages, 'tpc_test');

      expect(output).toHaveLength(2);

      expect(output[0]).toMatchObject({
        content: [
          {
            text: '好的，我来在沙箱中随机生成一个散点图！',
            type: 'output_text',
          },
        ],
        role: 'assistant',
        status: 'completed',
        type: 'message',
      });

      expect(output[1]).toMatchObject({
        status: 'completed',
        type: 'function_call',
      });
    });

    it('should still work for assistant messages without tool_calls', () => {
      const messages = [{ content: 'Hello, how can I help?', role: 'assistant' }];

      const { output, outputText } = callExtractOutputItems(messages, 'tpc_test');

      expect(output).toHaveLength(1);
      expect(output[0].type).toBe('message');
      expect(outputText).toBe('Hello, how can I help?');
    });

    it('should not emit message for assistant with empty content + tool_calls', () => {
      const messages = [
        {
          content: '',
          role: 'assistant',
          tool_calls: [{ function: { arguments: '{}', name: 'my-plugin____myApi' }, id: 'call_1' }],
        },
      ];

      const { output } = callExtractOutputItems(messages, 'tpc_test');

      expect(output).toHaveLength(1);
      expect(output[0].type).toBe('function_call');
    });
  });

  describe('function_call name should be decoded from internal ____-separated format', () => {
    it('should decode builtin tool names: identifier____apiName____builtin → identifier/apiName', () => {
      const messages = [
        {
          content: '',
          role: 'assistant',
          tool_calls: [
            {
              function: {
                arguments: '{"code":"print(1)"}',
                name: 'lobe-cloud-sandbox____executeCode____builtin',
              },
              id: 'call_abc123',
            },
          ],
        },
      ];

      const { output } = callExtractOutputItems(messages, 'tpc_test');

      const fc = output.find((item: any) => item.type === 'function_call');
      expect(fc.name).toBe('lobe-cloud-sandbox/executeCode');
    });

    it('should strip lobe-client-fn prefix correctly', () => {
      const messages = [
        {
          content: '',
          role: 'assistant',
          tool_calls: [
            {
              function: { arguments: '{}', name: 'lobe-client-fn____get_weather' },
              id: 'call_xyz',
            },
          ],
        },
      ];

      const { output } = callExtractOutputItems(messages, 'tpc_test');

      const fc = output.find((item: any) => item.type === 'function_call');
      expect(fc.name).toBe('get_weather');
    });

    it('should decode default type tools: identifier____apiName → identifier/apiName', () => {
      const messages = [
        {
          content: '',
          role: 'assistant',
          tool_calls: [
            { function: { arguments: '{}', name: 'my-plugin____myApi' }, id: 'call_def' },
          ],
        },
      ];

      const { output } = callExtractOutputItems(messages, 'tpc_test');

      const fc = output.find((item: any) => item.type === 'function_call');
      expect(fc.name).toBe('my-plugin/myApi');
    });

    it('should return raw name when no separator is present', () => {
      const messages = [
        {
          content: '',
          role: 'assistant',
          tool_calls: [{ function: { arguments: '{}', name: 'simple_tool' }, id: 'call_simple' }],
        },
      ];

      const { output } = callExtractOutputItems(messages, 'tpc_test');

      const fc = output.find((item: any) => item.type === 'function_call');
      expect(fc.name).toBe('simple_tool');
    });
  });

  describe('function_call id should match streaming output_index', () => {
    it('should assign index 1 to function_call when message (index 0) precedes it', () => {
      const messages = [
        {
          content: '好的，我来执行代码！',
          role: 'assistant',
          tool_calls: [
            {
              function: {
                arguments: '{"code":"1+1"}',
                name: 'lobe-cloud-sandbox____executeCode____builtin',
              },
              id: 'call_abc',
            },
          ],
        },
      ];

      const { output } = callExtractOutputItems(messages, 'tpc_test');

      expect(output[0].id).toBe('msg_tpc_test_0');
      expect(output[1].id).toBe('fc_tpc_test_1');
    });

    it('should assign index 0 to function_call when no message content', () => {
      const messages = [
        {
          content: '',
          role: 'assistant',
          tool_calls: [{ function: { arguments: '{}', name: 'plugin____api' }, id: 'call_1' }],
        },
      ];

      const { output } = callExtractOutputItems(messages, 'tpc_test');
      expect(output[0].id).toBe('fc_tpc_test_0');
    });
  });
});

it('retains native citation offsets in completed output', () => {
  const annotations = [
    {
      type: 'url_citation',
      url_citation: { url: 'https://example.com', title: 'Source', start_index: 1, end_index: 3 },
    },
  ];
  const result = callExtractOutputItems(
    [{ role: 'assistant', content: 'A😀Б', search: { deepseek: { annotations } } }],
    'tpc_test',
  );
  expect((result.output[0] as any).content[0].annotations).toEqual(annotations);
});

it('skips discarded assistant messages marked with internalRepairAttempt', () => {
  const messages = [
    {
      content: 'Вот модуль:\n[omitted invalid empty file reference tag]',
      metadata: { internalRepairAttempt: true },
      role: 'assistant',
    },
    {
      content: 'Повтори ответ целиком с кодом',
      role: 'user',
    },
    {
      content: 'Вот исправленный код:\n```vb\nSub Main()\nEnd Sub\n```',
      role: 'assistant',
    },
  ];

  const { output, outputText } = callExtractOutputItems(messages, 'tpc_repair');

  expect(output).toHaveLength(1);
  expect((output[0] as any).content[0].text).toBe(
    'Вот исправленный код:\n```vb\nSub Main()\nEnd Sub\n```',
  );
  expect(outputText).toBe('Вот исправленный код:\n```vb\nSub Main()\nEnd Sub\n```');
});

it('extractAssistantContent skips internalRepairAttempt messages so omitted markers never leak into output_text', () => {
  const svc = new (ResponsesService as any)(null, null);
  const onlyRepairState = {
    messages: [
      { content: 'Write code', role: 'user' },
      {
        content: 'Вот модуль:\n[omitted invalid empty file reference tag]',
        metadata: { internalRepairAttempt: true },
        role: 'assistant',
      },
      { content: 'Повтори ответ целиком', role: 'user' },
    ],
  };
  expect(svc['extractAssistantContent'](onlyRepairState)).toBe('');

  const withPriorAnswerState = {
    messages: [
      { content: 'Previous clean answer', role: 'assistant' },
      {
        content: '[omitted invalid empty file reference tag]',
        metadata: { internalRepairAttempt: true },
        role: 'assistant',
      },
    ],
  };
  expect(svc['extractAssistantContent'](withPriorAnswerState)).toBe('Previous clean answer');
});

describe('arckep-text-file masking and receipt stripping for clients', () => {
  it('masks arguments to "{}" for all arckep-text-file/* tools and strips diff tail from function_call_output', () => {
    const canonicalReceipt =
      'ARCKEP_TEXT_FILE_V1\n' +
      JSON.stringify({
        documentId: '11111111-1111-5111-a111-111111111111',
        fileId: '22222222-2222-5222-a222-222222222222',
        fileName: 'Module1.bas',
        part: 2,
        status: 'ready',
      });
    const fullContentWithDiff =
      canonicalReceipt +
      '\nPatch applied: 1 edit, lines 10 -> 11 (+1 / -0), encoding utf-8 -> utf-8, lineEnding CRLF.\n@@ -1,2 +1,3 @@\n+secret = 1';

    const messages = [
      {
        content: '',
        role: 'assistant',
        tool_calls: [
          {
            function: {
              arguments: JSON.stringify({
                documentId: '11111111-1111-5111-a111-111111111111',
                edits: [{ newText: 'secret = 1', oldText: 'old = 0' }],
              }),
              name: 'arckep-text-file____patchFile____builtin',
            },
            id: 'call_patch_1',
          },
          {
            function: {
              arguments: JSON.stringify({
                fileName: 'other.ts',
                final: true,
                part: 1,
                text: 'secret source',
              }),
              name: 'arckep-text-file____writePart____builtin',
            },
            id: 'call_write_1',
          },
        ],
      },
      {
        content: fullContentWithDiff,
        role: 'tool',
        tool_call_id: 'call_patch_1',
      },
      {
        content: canonicalReceipt,
        role: 'tool',
        tool_call_id: 'call_write_1',
      },
    ];

    const { output } = callExtractOutputItems(messages, 'tpc_patch');
    const patchCall = output.find(
      (i: any) => i.call_id === 'call_patch_1' && i.type === 'function_call',
    );
    const writeCall = output.find(
      (i: any) => i.call_id === 'call_write_1' && i.type === 'function_call',
    );
    const patchOut = output.find(
      (i: any) => i.call_id === 'call_patch_1' && i.type === 'function_call_output',
    );
    const writeOut = output.find(
      (i: any) => i.call_id === 'call_write_1' && i.type === 'function_call_output',
    );

    expect(patchCall.name).toBe('arckep-text-file/patchFile');
    expect(patchCall.arguments).toBe('{}');
    expect(writeCall.name).toBe('arckep-text-file/writePart');
    expect(writeCall.arguments).toBe('{}');

    // Strictly canonical 2-line 5-key receipt — no diff tail leaked to clients!
    expect(patchOut.output).toBe(canonicalReceipt);
    expect(patchOut.output.split('\n')).toHaveLength(2);
    expect(Object.keys(JSON.parse(patchOut.output.split('\n')[1]))).toHaveLength(5);
    expect(writeOut.output).toBe(canonicalReceipt);
  });

  it('strips diff tail from SSE tool_end function_call_output events', async () => {
    const canonicalReceipt =
      'ARCKEP_TEXT_FILE_V1\n' +
      JSON.stringify({
        documentId: '11111111-1111-5111-a111-111111111111',
        fileId: '22222222-2222-5222-a222-222222222222',
        fileName: 'Module1.bas',
        part: 2,
        status: 'ready',
      });
    const fullContentWithDiff =
      canonicalReceipt + '\nPatch applied: 1 edit\n@@ -1,1 +1,1 @@\n-old\n+new';

    const svc = new (ResponsesService as any)(null, null);
    const fakeOp: any = {
      finalState: {
        messages: [
          {
            content: fullContentWithDiff,
            role: 'tool',
            tool_call_id: 'call_patch_sse',
          },
        ],
        status: 'done',
      },
      operationId: 'op_sse_patch',
      responseId: 'resp_sse_patch',
    };

    const { responsesStreamHub } = await import('../responsesStreamHub');
    const attachSpy = vi.spyOn(responsesStreamHub, 'attach').mockReturnValue({
      done: true,
      history: [
        {
          data: {
            isSuccess: true,
            payload: { toolCalling: { id: 'call_patch_sse' } },
            result: { content: fullContentWithDiff },
          },
          stepIndex: 1,
          type: 'tool_end',
        } as any,
      ],
      truncated: false,
      unsubscribe: vi.fn(),
    });

    try {
      const events: any[] = [];
      for await (const ev of svc['streamOperationEvents'](
        fakeOp,
        { id: 'resp_sse_patch', output: [], status: 'in_progress' },
        0,
      )) {
        events.push(ev);
      }

      const fcoEvents = events.filter((e) => e.item?.type === 'function_call_output');
      expect(fcoEvents).toHaveLength(2);
      for (const ev of fcoEvents) {
        expect(ev.item.output).toBe(canonicalReceipt);
        expect(ev.item.output).not.toContain('Patch applied');
      }
      const completed = events.find((e) => e.type === 'response.completed');
      expect(completed?.response.output[0].output).toBe(canonicalReceipt);
    } finally {
      attachSpy.mockRestore();
    }
  });
});
