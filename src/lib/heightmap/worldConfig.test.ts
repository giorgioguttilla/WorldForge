import { describe, expect, it } from 'vitest';
import { createWorldConfig, getWorldAreaSquareMiles, getWorldLinearSize, isPowerOfTwo, metersToWorldUnits, normalizeWorldConfig, r16ToElevation, validateWorldConfig } from './worldConfig';

describe('world config', () => {
  it('validates power-of-two sizing', () => {
    expect(isPowerOfTwo(4)).toBe(true);
    expect(isPowerOfTwo(6)).toBe(false);
    expect(validateWorldConfig({
      name: 'Bad',
      tileSize: 1000,
      unitSize: 1,
      unit: 'foot',
      tilesPerSide: 3,
      worldHeight: 100
    })).toEqual(expect.arrayContaining([
      'Tile size must be a power of two.',
      'World size must be a power-of-two tile count.'
    ]));
  });

  it('computes linear world size from tile count and unit size', () => {
    expect(getWorldLinearSize({ tileSize: 1024, tilesPerSide: 8, unitSize: 0.5 })).toBe(4096);
  });

  it('computes world area in square miles', () => {
    expect(getWorldAreaSquareMiles({ tileSize: 5280, tilesPerSide: 2, unitSize: 1, unit: 'foot' })).toBe(4);
  });

  it('creates a normalized versioned config', () => {
    const config = createWorldConfig({
      name: '  Test World  ',
      tileSize: 128,
      unitSize: 1,
      unit: 'meter',
      tilesPerSide: 2,
      worldHeight: 512
    }, 'world-test');

    expect(config).toMatchObject({
      id: 'world-test',
      name: 'Test World',
      worldHeight: 512,
      version: 1
    });
  });

  it('maps R16 values into the configured overall world height', () => {
    expect(r16ToElevation(65535, 3000)).toBe(3000);
    expect(r16ToElevation(0, 3000)).toBe(0);
  });

  it('converts meters into active world units', () => {
    expect(metersToWorldUnits(2, { unit: 'foot' })).toBeCloseTo(6.56168);
    expect(metersToWorldUnits(2, { unit: 'meter' })).toBe(2);
    expect(metersToWorldUnits(2, { unit: 'cm' })).toBe(200);
  });

  it('normalizes legacy maxElevation configs to worldHeight', () => {
    const config = normalizeWorldConfig({
      id: 'legacy',
      name: 'Legacy',
      tileSize: 32,
      unitSize: 1,
      unit: 'foot',
      tilesPerSide: 2,
      maxElevation: 900,
      createdAt: 'now',
      updatedAt: 'now',
      version: 1
    });

    expect(config.worldHeight).toBe(900);
  });
});
