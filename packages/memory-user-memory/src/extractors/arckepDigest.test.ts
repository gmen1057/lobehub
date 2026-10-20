import type { ModelRuntime } from '@lobechat/model-runtime';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildDigestPrompt,
  buildDigestSchema,
  DIGEST_LAYERS,
  DigestMemoryExtractor,
} from './arckepDigest';

// arckep (20.10.2026): суточный разбор одним вызовом. Главное для денег — одинаковое у всех людей начало запроса
// (схема и инструкции), всё личное — в конце; иначе кэш OpenAI не срабатывает.

describe('DigestMemoryExtractor', () => {
  let runtime: ModelRuntime;

  beforeEach(() => {
    runtime = { generateObject: vi.fn().mockResolvedValue({}) } as unknown as ModelRuntime;
  });

  it('схема — объект с пятью слоями, у каждого схема его экстрактора', () => {
    const schema = buildDigestSchema();
    expect(schema.strict).toBe(true);
    expect((schema.schema as any).required).toEqual([...DIGEST_LAYERS]);
    expect(Object.keys((schema.schema as any).properties).sort()).toEqual(
      [...DIGEST_LAYERS].sort(),
    );
    expect((schema.schema as any).properties.context.properties.memories.type).toBe('array');
    expect((schema.schema as any).additionalProperties).toBe(false);
  });

  it('инструкции без личного: ни одной подстановки, одинаковы при любом человеке', () => {
    const prompt = buildDigestPrompt();
    expect(prompt).not.toMatch(/\{\{/);
    for (const layer of DIGEST_LAYERS) expect(prompt).toContain(`LAYER "${layer}"`);
    expect(prompt).toContain('never repeat what is already stored');
  });

  it('системное сообщение одинаково у разных людей, личное — только в сообщении пользователя', async () => {
    const extractor = new DigestMemoryExtractor({
      model: 'gpt-6-luna',
      modelRuntime: runtime,
      serviceTier: 'flex',
    });
    await extractor.structuredCall({
      availableCategories: ['work'],
      digestContext: '<new_conversations>Анна, Москва</new_conversations>',
      language: 'Russian',
      sessionDate: '2026-10-20T00:00:00.000Z',
    } as any);
    await extractor.structuredCall({
      availableCategories: [],
      digestContext: '<new_conversations>Тимур, Казань</new_conversations>',
      language: 'Russian',
      sessionDate: '2026-10-21T00:00:00.000Z',
    } as any);

    const [first, second] = (runtime.generateObject as any).mock.calls.map(
      (call: any[]) => call[0],
    );
    expect(first.messages).toHaveLength(2);
    expect(first.messages[0].role).toBe('system');
    expect(first.messages[0].content).toBe(second.messages[0].content);
    expect(first.schema).toBe(second.schema);
    expect(first.messages[1]).toMatchObject({ role: 'user' });
    expect(first.messages[1].content).toContain('Анна, Москва');
    expect(first.messages[1].content).toContain('language="Russian"');
    expect(first.messages[0].content).not.toContain('Анна');
    expect(first.serviceTier).toBe('flex');
  });
});
