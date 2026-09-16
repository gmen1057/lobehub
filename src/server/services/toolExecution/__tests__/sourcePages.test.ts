import { describe, expect, it, vi } from 'vitest';

import { ToolExecutionService } from '../index';

vi.mock('@/server/services/discover', () => ({ DiscoverService: class {} }));
vi.mock('@/server/services/mcp/contentProcessor', () => ({ contentBlocksToString: vi.fn() }));

describe('source pages keep their cursor coverage', () => {
  it.each([
    ['lobe-knowledge-base', 'readKnowledge'],
    ['lobe-topic-reference', 'getTopicContext'],
  ])('does not cut an already bounded %s/%s result', async (identifier, apiName) => {
    const content = 'x'.repeat(20_000) + '\nnextOffset:20000';
    const service = new ToolExecutionService({
      builtinToolsExecutor: {
        execute: vi.fn().mockResolvedValue({ content, success: true }),
      } as any,
      mcpService: {} as any,
    });
    const result = await service.executeTool(
      { id: 'call-1', identifier, apiName, arguments: '{}', type: 'builtin' },
      { toolManifestMap: {}, toolResultMaxLength: 1000 },
    );
    expect(result.content).toBe(content);
  });

  it('continues to limit unrelated tool output', async () => {
    const service = new ToolExecutionService({
      builtinToolsExecutor: {
        execute: vi.fn().mockResolvedValue({ content: 'x'.repeat(20_000), success: true }),
      } as any,
      mcpService: {} as any,
    });
    const result = await service.executeTool(
      { id: 'call-2', identifier: 'unrelated', apiName: 'read', arguments: '{}', type: 'builtin' },
      { toolManifestMap: {}, toolResultMaxLength: 1000 },
    );
    expect(result.content.length).toBeLessThan(2000);
  });
});
