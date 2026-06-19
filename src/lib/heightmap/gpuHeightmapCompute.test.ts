import { describe, expect, it } from 'vitest';
import { hasUsableHeightRange } from './gpuHeightmapCompute';

describe('heightmap compute output validation', () => {
  it('rejects flat all-zero output', () => {
    expect(hasUsableHeightRange(new Uint16Array([0, 0, 0, 0]))).toBe(false);
  });

  it('accepts varied terrain output', () => {
    expect(hasUsableHeightRange(new Uint16Array([1200, 1400, 1800, 2600]))).toBe(true);
  });
});
