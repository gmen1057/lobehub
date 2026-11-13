import { describe, expect, it } from 'vitest';

import { MessagesEngine } from '../../engine/messages/MessagesEngine';
import { deepseekApplicationContext } from '../deepseekApplicationContext';
import { MessageCleanupProcessor } from '../MessageCleanup';

describe('DeepSeek owned documents and signed history', () => {
  it('transports opaque handles on the native route and preserves original signed steps', async () => {
    const steps = [{ index: 0, calls: [{ signature: 'opaque-signature' }] }];
    const messages = [
      {
        role: 'user',
        content: 'read',
        metadata: { deepseek_document_ids: ['arkdoc_owner-envelope'] },
      },
      {
        role: 'assistant',
        content: 'answer',
        search: { deepseek: { server_tool_calls: steps, annotations: [] } },
      },
    ];
    const result = await new MessageCleanupProcessor().process({
      initialState: { messages: [], model: 'deepseek-flash', provider: 'deepseek' },
      messages,
      metadata: {},
      isAborted: false,
    } as any);
    expect(result.messages[0].content).toEqual([
      { type: 'text', text: 'read' },
      { type: 'file', file_id: 'arkdoc_owner-envelope' },
    ]);
    expect(result.messages[1]).toMatchObject({ server_tool_calls: steps, annotations: [] });
  });
  it('never forwards provider IDs or leaks native history onto another provider/model', () => {
    const message = {
      role: 'user',
      content: '',
      metadata: { deepseek_document_ids: ['file-api-raw'] },
    };
    expect(() => deepseekApplicationContext(message, 'deepseek-flash', 'deepseek')).toThrow();
    expect(deepseekApplicationContext(message, 'deepseek-v4-pro', 'deepseek')).toEqual({});
    expect(
      deepseekApplicationContext(
        { role: 'assistant', search: { deepseek: { server_tool_calls: [{}] } } },
        'deepseek-flash',
        'openrouter',
      ),
    ).toEqual({});
  });
});

it('keeps handles through the actual context pipeline even beside image attachments', async () => {
  const result = await new MessagesEngine({
    model: 'deepseek-flash',
    provider: 'deepseek',
    enableSystemDate: false,
    capabilities: { isCanUseVision: () => true },
    messages: [
      {
        id: 'u',
        role: 'user',
        content: 'read',
        metadata: { deepseek_document_ids: ['arkdoc_owned'] },
        imageList: [{ id: 'i', url: 'data:image/png;base64,aA==' }],
      },
    ] as any,
  }).process();
  expect(result.messages.find((m) => m.role === 'user')?.content).toContainEqual({
    type: 'file',
    file_id: 'arkdoc_owned',
  });
});
