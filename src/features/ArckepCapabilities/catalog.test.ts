import { describe, expect, it } from 'vitest';

import {
  ARCKEP_ALSO_CAN,
  ARCKEP_CAPABILITY_CUBES,
  cubesForAgent,
  SEO_AGENT_MARKET_ID,
} from './catalog';

describe('Arckep capability catalog', () => {
  it('lists SEO plus the core in-chat jobs', () => {
    expect(ARCKEP_CAPABILITY_CUBES.map((cube) => cube.id)).toEqual([
      'seo',
      'image',
      'site',
      'dashboard',
      'search',
      'crm',
    ]);
    expect(ARCKEP_CAPABILITY_CUBES.every((cube) => cube.prompt.length > 20)).toBe(true);
    expect(ARCKEP_ALSO_CAN.length).toBeGreaterThanOrEqual(3);
  });

  it('hides the SEO cube on the dedicated SEO agent', () => {
    expect(cubesForAgent(SEO_AGENT_MARKET_ID).map((cube) => cube.id)).not.toContain('seo');
    expect(cubesForAgent(undefined).map((cube) => cube.id)).toContain('seo');
  });
});
