import { describe, expect, it } from 'vitest';
import { createDefaultNoiseFieldLibrary, evaluateNoiseFieldGraph, validateNoiseGraph } from '.';

describe('noise graph evaluation', () => {
  it('validates and evaluates default presets deterministically', () => {
    const [rolling] = createDefaultNoiseFieldLibrary();
    expect(validateNoiseGraph(rolling)).toEqual([]);
    const context = {
      cartesian: { x: 100, y: 200 },
      spline: { x: 25, y: -8 }
    };
    const first = evaluateNoiseFieldGraph(rolling, context);
    const second = evaluateNoiseFieldGraph(rolling, context);
    expect(first).toBe(second);
    expect(first).toBeGreaterThanOrEqual(-1);
    expect(first).toBeLessThanOrEqual(1);
  });
});
