import { describe, expect, it, vi } from 'vitest';

import { ActivatorExecutionRuntime } from './index';

const images = 'mcp-arckep-studio-images';
const sandbox = 'mcp-arckep-e2b-sandbox';

describe('availability-scoped activation', () => {
  it('returns recoverable enable guidance for an absent installed/disabled tool without activating it', async () => {
    const markActivated = vi.fn();
    const runtime = new ActivatorExecutionRuntime({
      service: {
        getActivatedToolIds: () => [],
        getToolManifests: async () => [],
        markActivated,
      },
    });
    const result = await runtime.activateTools({ identifiers: [images, sandbox] });
    expect(result.success).toBe(true); // Discovery succeeded; this must not stop the conversation.
    expect(result.state).toMatchObject({ activatedTools: [], notFound: [images, sandbox] });
    expect(result.content).toContain('no provider call was attempted');
    expect(result.content).toContain('enable it through "+" in the chat');
    expect(result.content).toContain('do not enable it yourself or override exclusions');
    expect(markActivated).not.toHaveBeenCalled();
  });

  it('retains successful partial activation without claiming the missing tool is ready', async () => {
    const markActivated = vi.fn();
    const runtime = new ActivatorExecutionRuntime({
      service: {
        getActivatedToolIds: () => ['lobe-artifacts'],
        getToolManifests: async () => [
          {
            identifier: images,
            name: 'Images',
            apiDescriptions: [{ name: 'create_image', description: 'Draw or edit' }],
          },
        ],
        markActivated,
      },
    });
    const result = await runtime.activateTools({
      identifiers: [images, sandbox, 'lobe-artifacts'],
    });
    expect(result.success).toBe(true);
    expect(result.state).toMatchObject({ notFound: [sandbox], alreadyActive: ['lobe-artifacts'] });
    expect(result.content).toContain('create_image');
    expect(markActivated).toHaveBeenCalledExactlyOnceWith([images]);
  });
});
