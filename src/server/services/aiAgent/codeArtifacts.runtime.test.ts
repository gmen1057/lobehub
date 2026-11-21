import { AgentRuntime } from '@lobechat/agent-runtime';
import { serializePartsForStorage } from '@lobechat/utils';
import { describe, expect, it, vi } from 'vitest';

import {
  createRuntimeExecutors,
  type RuntimeExecutorContext,
} from '@/server/modules/AgentRuntime/RuntimeExecutors';
import { initModelRuntimeFromDB } from '@/server/modules/ModelRuntime';

const { uploadFromBuffer } = vi.hoisted(() => ({ uploadFromBuffer: vi.fn() }));
vi.mock('@/server/modules/ModelRuntime', () => ({ initModelRuntimeFromDB: vi.fn() }));
vi.mock('@/server/modules/Mecha/ContextEngineering', () => ({ serverMessagesEngine: vi.fn() }));
vi.mock('@/server/services/message', () => ({ MessageService: vi.fn() }));
vi.mock('@/server/services/file', () => ({
  FileService: class {
    uploadBase64 = vi.fn(async () => ({ fileId: 'image-id', url: 'https://example.test/image' }));
    uploadFromBuffer = uploadFromBuffer;
  },
}));
vi.mock('@/envs/file', () => ({ fileEnv: { NEXT_PUBLIC_S3_FILE_PATH: 'files' } }));
vi.mock('@/server/services/agentDocuments', () => ({ AgentDocumentsService: vi.fn() }));
vi.mock('@/server/modules/AgentRuntime/arckepSearch', () => ({
  resolveServerEnabledSearch: vi.fn(async () => false),
}));
vi.mock('@/server/modules/AgentRuntime/serverModelParams', () => ({
  resolveServerModelParams: vi.fn(async () => ({})),
}));
vi.mock('@/server/modules/AgentRuntime/llmTrace', () => ({
  createEngineTraceCallbacks: vi.fn(),
  withEngineTrace: (_trace: unknown, callbacks: unknown) => callbacks,
}));

const FILE_ID = 'f994edcd-bfb3-4d15-9ceb-924f63675569';
const source = Array.from({ length: 26 }, (_, index) => `print(${index})`).join('\n');
const content = ['```python', source, '```'].join('\n');

describe('Studio final code artifact', () => {
  it.each([
    { artifact: true, hasImage: false, reply: content, studioWebChat: true },
    { artifact: true, hasImage: true, reply: content, studioWebChat: true },
    { artifact: false, hasImage: false, reply: content, studioWebChat: false },
    { artifact: false, hasImage: false, reply: '```python\nprint(0)\n```', studioWebChat: true },
  ])(
    'stores the final answer (web chat = $studioWebChat, artifact = $artifact, image = $hasImage)',
    async ({ artifact, hasImage, reply, studioWebChat }) => {
      uploadFromBuffer.mockReset().mockResolvedValue({ fileId: FILE_ID });
      const chat = vi.fn(async (_payload, options) => {
        if (hasImage) {
          await options.callback.onContentPart({ content: reply, partType: 'text' });
          await options.callback.onContentPart({
            content: 'aW1hZ2U=',
            mimeType: 'image/png',
            partType: 'image',
          });
        } else {
          await options.callback.onText(reply);
        }
        return new Response('data: [DONE]\n\n', {
          headers: { 'Content-Type': 'text/event-stream' },
        });
      });
      vi.mocked(initModelRuntimeFromDB).mockResolvedValue({ chat } as any);
      const state = AgentRuntime.createInitialState({
        operationId: 'op',
        metadata: { agentId: 'agt_1', studioWebChat, topicId: 'tpc_1' },
        status: 'running',
      });
      const update = vi.fn();
      const publishStreamEvent = vi.fn();
      const ctx = {
        loadAgentState: vi.fn(async () => state),
        messageModel: {
          create: vi.fn(async () => ({ id: 'assistant_1' })),
          query: vi.fn(async () => []),
          update,
        },
        operationId: 'op',
        serverDB: {},
        stepIndex: 0,
        streamManager: { publishStreamChunk: vi.fn(), publishStreamEvent },
        userId: 'owner_1',
      } as unknown as RuntimeExecutorContext;
      const instruction = {
        payload: { messages: [], model: 'test', provider: 'openai', tools: [] },
        type: 'call_llm',
      } as const;

      const result = await createRuntimeExecutors(ctx).call_llm!(instruction as any, state);
      const saved = update.mock.calls.at(-1)?.[1];
      const finalContent = saved.content;
      if (artifact) {
        expect(uploadFromBuffer).toHaveBeenCalledOnce();
        expect(uploadFromBuffer.mock.calls[0][3].metadata.codeArtifact.messageId).toBe(
          'assistant_1',
        );
        const persistedText = hasImage ? JSON.parse(finalContent)[0].text : finalContent;
        expect(persistedText).toContain(`src="/chat/code-artifact/${FILE_ID}/"`);
        expect(persistedText).not.toContain(source);
        expect(saved.metadata).toMatchObject({
          codeArtifactFallback: hasImage
            ? serializePartsForStorage([
                { text: reply, type: 'text' },
                { image: 'https://example.test/image', type: 'image' },
              ])
            : reply,
        });
      } else {
        expect(uploadFromBuffer).not.toHaveBeenCalled();
        expect(finalContent).toBe(reply);
        expect(saved.metadata).toBeUndefined();
      }
      expect(publishStreamEvent).toHaveBeenCalledWith(
        'op',
        expect.objectContaining({
          data: expect.objectContaining({ finalContent }),
          type: 'stream_end',
        }),
      );
      expect(result.events).toContainEqual(
        expect.objectContaining({
          result: expect.objectContaining({ content: finalContent }),
          type: 'llm_result',
        }),
      );
      const terminalText = result.newState.messages.at(-1)?.content;
      if (hasImage) {
        expect(terminalText).toContain(`src="/chat/code-artifact/${FILE_ID}/"`);
      } else {
        expect(terminalText).toBe(finalContent);
      }
    },
  );
});
