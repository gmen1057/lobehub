import { describe, expect, it } from 'vitest';

import {
  DEFAULT_FORCE_FINISH_PROMPT,
  ForceFinishSummaryInjector,
} from '../ForceFinishSummaryInjector';

const createContext = (messages: any[] = []) => ({
  initialState: {
    messages: [],
    model: 'gpt-4',
    provider: 'openai',
    systemRole: '',
    tools: [],
  },
  isAborted: false,
  messages,
  metadata: {
    maxTokens: 4096,
    model: 'gpt-4',
  },
});

describe('ForceFinishSummaryInjector', () => {
  it('skips injection when disabled', async () => {
    const provider = new ForceFinishSummaryInjector({ enabled: false });
    const context = createContext([{ content: 'Continue', id: '1', role: 'user' }]);

    const result = await provider.process(context);

    expect(result.messages).toHaveLength(1);
    expect(result.metadata.forceFinishInjected).toBeUndefined();
  });

  it('injects the default summary prompt with conversation language, progress preservation, and no-tool rules', async () => {
    const provider = new ForceFinishSummaryInjector({ enabled: true });
    const originalMessages = [
      { content: 'Analyze all 10 files', id: '1', role: 'user' },
      { content: 'Done with 7 files', id: '2', role: 'assistant' },
    ];
    const context = createContext(originalMessages);

    const result = await provider.process(context);

    expect(originalMessages).toHaveLength(2);
    expect(result.messages).toHaveLength(3);
    expect(result.messages[2]).toEqual({
      content: DEFAULT_FORCE_FINISH_PROMPT,
      role: 'system',
    });
    expect(result.messages[2].content).toContain('maximum step limit');
    expect(result.messages[2].content).toContain('language of the current conversation');
    expect(result.messages[2].content).toContain('already been completed');
    expect(result.messages[2].content).toContain('preserve all obtained results');
    expect(result.messages[2].content).toContain('next message');
    expect(result.messages[2].content).toContain('Do not frame this pause as an error');
    expect(result.messages[2].content).toContain('Do not attempt to use any tools');
    expect(result.metadata.forceFinishInjected).toBe(true);
  });

  it('uses an explicit custom prompt when provided', async () => {
    const customPrompt = 'Custom circuit breaker stop instruction.';
    const provider = new ForceFinishSummaryInjector({
      enabled: true,
      prompt: customPrompt,
    });
    const context = createContext([{ content: 'Try again', id: '1', role: 'user' }]);

    const result = await provider.process(context);

    expect(result.messages).toHaveLength(2);
    expect(result.messages[1]).toEqual({
      content: customPrompt,
      role: 'system',
    });
    expect(result.metadata.forceFinishInjected).toBe(true);
  });

  it('merges into an existing leading system message so Anthropic/Google keep a single system prompt', async () => {
    const provider = new ForceFinishSummaryInjector({ enabled: true });
    const originalSystem = { content: 'You are a helpful assistant.', id: 'sys-1', role: 'system' };
    const originalUser = { content: 'Analyze files', id: 'u-1', role: 'user' };
    const context = createContext([originalSystem, originalUser]);

    const result = await provider.process(context);

    expect(originalSystem.content).toBe('You are a helpful assistant.');
    expect(result.messages).toHaveLength(2);
    expect(result.messages.filter((m) => m.role === 'system')).toHaveLength(1);
    expect(result.messages[0]).toEqual({
      content: `You are a helpful assistant.\n\n${DEFAULT_FORCE_FINISH_PROMPT}`,
      id: 'sys-1',
      role: 'system',
    });
    expect(result.messages[1]).toEqual(originalUser);
    expect(result.metadata.forceFinishInjected).toBe(true);
  });

  it('merges custom prompt into existing system message and avoids leading newlines when system content is empty', async () => {
    const customPrompt = 'Circuit breaker tripped.';
    const provider = new ForceFinishSummaryInjector({ enabled: true, prompt: customPrompt });

    const withContent = await provider.process(
      createContext([
        { content: 'Base instructions.', id: 'sys-1', role: 'system' },
        { content: 'Run tool', id: 'u-1', role: 'user' },
      ]),
    );
    expect(withContent.messages).toHaveLength(2);
    expect(withContent.messages[0].content).toBe(`Base instructions.\n\n${customPrompt}`);

    const withEmpty = await provider.process(
      createContext([
        { content: '', id: 'sys-2', role: 'system' },
        { content: 'Run tool', id: 'u-2', role: 'user' },
      ]),
    );
    expect(withEmpty.messages).toHaveLength(2);
    expect(withEmpty.messages[0].content).toBe(customPrompt);
  });
});
