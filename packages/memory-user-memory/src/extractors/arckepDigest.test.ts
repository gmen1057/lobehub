import type { ModelRuntime } from '@lobechat/model-runtime';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildDigestPrompt,
  buildDigestSchema,
  DIGEST_LAYERS,
  DigestContextMemorySchema,
  DigestExperienceMemorySchema,
  DigestMemoryExtractor,
  DigestPreferenceMemorySchema,
} from './arckepDigest';

const assertOpenAIStrictObjectSchema = (node: unknown, path = '$') => {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((child, idx) => assertOpenAIStrictObjectSchema(child, `${path}[${idx}]`));
    return;
  }
  const obj = node as Record<string, any>;
  if (obj.properties && typeof obj.properties === 'object' && !Array.isArray(obj.properties)) {
    const propKeys = Object.keys(obj.properties).sort();
    expect(obj.additionalProperties, `${path}.additionalProperties`).toBe(false);
    expect(Array.isArray(obj.required), `${path}.required is array`).toBe(true);
    expect([...obj.required].sort(), `${path}.required keys`).toEqual(propKeys);
    for (const [k, v] of Object.entries(obj.properties)) {
      assertOpenAIStrictObjectSchema(v, `${path}.properties.${k}`);
    }
  }
  if (obj.items) {
    assertOpenAIStrictObjectSchema(obj.items, `${path}.items`);
  }
  for (const branchKey of ['anyOf', 'oneOf', 'allOf']) {
    if (Array.isArray(obj[branchKey])) {
      obj[branchKey].forEach((child: unknown, idx: number) =>
        assertOpenAIStrictObjectSchema(child, `${path}.${branchKey}[${idx}]`),
      );
    }
  }
  for (const defsKey of ['$defs', 'definitions']) {
    if (obj[defsKey] && typeof obj[defsKey] === 'object') {
      for (const [k, v] of Object.entries(obj[defsKey])) {
        assertOpenAIStrictObjectSchema(v, `${path}.${defsKey}.${k}`);
      }
    }
  }
};

// arckep (20.10.2026): суточный разбор одним вызовом. Главное для денег — одинаковое у всех людей начало запроса
// (схема и инструкции), всё личное — в конце; иначе кэш OpenAI не срабатывает.

describe('DigestMemoryExtractor', () => {
  let runtime: ModelRuntime;

  beforeEach(() => {
    runtime = { generateObject: vi.fn().mockResolvedValue({}) } as unknown as ModelRuntime;
  });

  it('схема — валидный OpenAI strict:true объект с пятью слоями и полем supersedeIds в preference/context/experience', () => {
    const schema = buildDigestSchema();
    expect(schema.strict).toBe(true);
    expect((schema.schema as any).required).toEqual([...DIGEST_LAYERS]);
    expect(Object.keys((schema.schema as any).properties).sort()).toEqual(
      [...DIGEST_LAYERS].sort(),
    );
    expect((schema.schema as any).properties.context.properties.memories.type).toBe('array');
    expect((schema.schema as any).additionalProperties).toBe(false);

    // Every nested object in the entire JSON Schema must satisfy OpenAI Structured Outputs strict:true
    assertOpenAIStrictObjectSchema(schema.schema);

    for (const layer of ['preference', 'context', 'experience'] as const) {
      const itemSchema = (schema.schema as any).properties[layer].properties.memories.items;
      expect(itemSchema.properties.supersedeIds).toBeDefined();
      expect(itemSchema.required).toContain('supersedeIds');
      expect(itemSchema.additionalProperties).toBe(false);
    }
  });

  it('Digest*MemorySchema.safeParse сохраняет supersedeIds (массив, null или отсутствие)', () => {
    const prefParsed = DigestPreferenceMemorySchema.safeParse({
      memories: [
        {
          details: 'd',
          memoryCategory: 'communication',
          memoryType: 'preference',
          summary: 's',
          supersedeIds: ['pref_old_1', 'pref_old_2'],
          tags: ['t'],
          title: 'Title',
          withPreference: {
            appContext: null,
            conclusionDirectives: 'Always reply concisely',
            extractedLabels: [],
            extractedScopes: [],
            originContext: null,
            scorePriority: 0.8,
            suggestions: [],
            type: 'communication',
          },
        },
      ],
    });
    expect(prefParsed.success).toBe(true);
    if (prefParsed.success) {
      expect(prefParsed.data.memories[0].supersedeIds).toEqual(['pref_old_1', 'pref_old_2']);
    }

    expect(DigestContextMemorySchema.shape.memories).toBeDefined();
    expect(DigestExperienceMemorySchema.shape.memories).toBeDefined();
  });

  it('инструкции без личного: ни одной подстановки, содержат правила supersedeIds и pinned="true"', () => {
    const prompt = buildDigestPrompt();
    expect(prompt).not.toMatch(/\{\{/);
    for (const layer of DIGEST_LAYERS) expect(prompt).toContain(`LAYER "${layer}"`);
    expect(prompt).toContain('never repeat what is already stored');
    expect(prompt).toContain('supersedeIds');
    expect(prompt).toContain('pinned="true"');
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
