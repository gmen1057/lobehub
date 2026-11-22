import { describe, expect, it, vi } from 'vitest';

import { TopicReferenceManifest } from '../manifest';
import { TopicReferenceExecutor } from './index';

describe('TopicReferenceManifest and TopicReferenceExecutor', () => {
  it('exposes startLine and maxLines parameters on getTopicContext schema', () => {
    const api = TopicReferenceManifest.api.find((item) => item.name === 'getTopicContext');
    expect(api).toBeDefined();
    expect(api!.parameters.properties).toMatchObject({
      maxLines: { maximum: 500, minimum: 1, type: 'integer' },
      startLine: { minimum: 1, type: 'integer' },
    });
  });

  it('forwards startLine and maxLines to runtime getTopicContext', async () => {
    const getTopicContext = vi.fn().mockResolvedValue({ content: 'ok', success: true });
    const executor = new TopicReferenceExecutor({ getTopicContext });

    const params = {
      fileId: 'file-1',
      maxLines: 120,
      mode: 'code_artifacts' as const,
      startLine: 45,
      topicId: 'topic-1',
    };
    const res = await executor.getTopicContext(params, {} as any);

    expect(res).toEqual({ content: 'ok', success: true });
    expect(getTopicContext).toHaveBeenCalledWith(params);
  });
});
