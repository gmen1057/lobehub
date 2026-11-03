import { describe, expect, it } from 'vitest';

import { calculatorExecutor } from './executor';
import cases from './numerical-cases.json';
import { systemPrompt } from './systemRole';

describe('calculation contract', () => {
  it('scopes expression syntax to the corresponding engine', () => {
    expect(systemPrompt).not.toContain('Use mathjs syntax for ALL calculations');
    expect(systemPrompt).toContain('mathjs syntax for calculate and evaluate');
    expect(systemPrompt).toContain('nerdamer syntax for symbolic APIs');
  });

  for (const task of cases) {
    it(`evaluates the supplied inputs of ${task.id}`, async () => {
      for (const check of task.checks) {
        const result = await calculatorExecutor.calculate({ expression: check.expression });
        expect(result.success).toBe(true);
        expect(Number(result.content)).toBeCloseTo(check.expected, 8);
      }
    });
  }

  it('supports the separately described symbolic path', async () => {
    const result = await calculatorExecutor.execute({ expression: 'factor(x^2-1)' });
    expect(result.success).toBe(true);
    expect(result.content).toBe('(-1+x)*(1+x)');
  });
});
