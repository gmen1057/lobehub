import type { ModelRuntime } from '@lobechat/model-runtime';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExtractorTemplateProps } from '../types';
import { ContextExtractor } from './context';
import { UserMemoryGateKeeper } from './gatekeeper';

// arckep (20.10.2026): шаблон привратника и слоёв рисовался и в системное, и в пользовательское сообщение —
// вместе с перепиской, то есть всё уходило в модель дважды. Теперь переписка идёт один раз, а ступень
// рассуждений и учёт токенов доходят до вызова модели.

const TOPIC =
  '<chat_topic id="t1"><messages count="1"><message role="user">Я веду рассылки</message></messages></chat_topic>';

const templateOptions: ExtractorTemplateProps = {
  availableCategories: ['work'],
  language: 'Russian',
  retrievedContexts: [TOPIC, 'existing memory'],
  sessionDate: '2026-10-20',
  topK: 10,
  username: 'User',
};

const count = (text: string, part: string) => text.split(part).length - 1;

describe('BaseMemoryExtractor (arckep)', () => {
  let runtime: ModelRuntime;

  beforeEach(() => {
    runtime = {
      generateObject: vi.fn().mockResolvedValue({ memories: [] }),
    } as unknown as ModelRuntime;
  });

  it('слой: переписка в запросе один раз, пользовательское сообщение — короткое задание', async () => {
    const extractor = new ContextExtractor({
      agent: 'layer-context',
      model: 'gpt-6-luna',
      modelRuntime: runtime,
    });
    await extractor.structuredCall(templateOptions);

    const payload = (runtime.generateObject as any).mock.calls[0][0];
    const all = payload.messages.map((m: { content: string }) => m.content).join('\n');
    expect(count(all, TOPIC)).toBe(1);
    expect(payload.messages.at(-1)).toMatchObject({ role: 'user' });
    expect(payload.messages.at(-1).content).toContain('layer-context');
    expect(payload.messages.at(-1).content).not.toContain(TOPIC);
  });

  it('привратник: инструкция и переписка тоже один раз', async () => {
    (runtime.generateObject as any).mockResolvedValue({
      activity: { reasoning: '', shouldExtract: false },
      context: { reasoning: '', shouldExtract: false },
      experience: { reasoning: '', shouldExtract: false },
      identity: { reasoning: '', shouldExtract: false },
      preference: { reasoning: '', shouldExtract: false },
    });
    const gatekeeper = new UserMemoryGateKeeper({
      agent: 'gatekeeper',
      model: 'gpt-6-luna',
      modelRuntime: runtime,
    });
    await gatekeeper.check({ retrievedContexts: [TOPIC], topK: 10 });

    const all = (runtime.generateObject as any).mock.calls[0][0].messages
      .map((m: { content: string }) => m.content)
      .join('\n');
    expect(count(all, TOPIC)).toBe(1);
    expect(count(all, 'Gate Keeping Guidelines')).toBe(1);
  });

  it('ступень рассуждений и учёт токенов доходят до вызова модели', async () => {
    const onUsage = vi.fn();
    const extractor = new ContextExtractor({
      agent: 'layer-context',
      model: 'gpt-6-luna',
      modelRuntime: runtime,
      onUsage,
      reasoningEffort: 'medium',
    });
    await extractor.structuredCall(templateOptions);

    const [payload, options] = (runtime.generateObject as any).mock.calls[0];
    expect(payload.reasoningEffort).toBe('medium');
    expect(options.onUsage).toBe(onUsage);
    expect(options.metadata).toEqual({ trigger: 'memory' });
  });

  it('без настроек — как раньше: ступени нет, учёта нет', async () => {
    const extractor = new ContextExtractor({
      agent: 'layer-context',
      model: 'gpt-6-luna',
      modelRuntime: runtime,
    });
    await extractor.structuredCall(templateOptions);

    const [payload, options] = (runtime.generateObject as any).mock.calls[0];
    expect(payload).not.toHaveProperty('reasoningEffort');
    expect(options).not.toHaveProperty('onUsage');
  });
});
