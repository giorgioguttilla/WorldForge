import { describe, expect, it } from 'vitest';
import { ancestorsForDirtyTile, childTileKeys, parentTileKey, tilePath, tilesPerSideAtDepth } from './tileKey';

describe('tile keys', () => {
  it('formats stable paths', () => {
    expect(tilePath({ x: 3, y: 2, d: 1 })).toBe('tiles/d1/y2/x3.r16');
    expect(tilePath({ x: 0, y: 1, d: 2 }, 'png')).toBe('tiles/d2/y1/x0.png');
  });

  it('calculates parent and child relationships', () => {
    const parent = parentTileKey({ x: 3, y: 2, d: 0 });
    expect(parent).toEqual({ x: 1, y: 1, d: 1 });
    expect(childTileKeys({ x: 1, y: 1, d: 1 })).toEqual([
      { x: 2, y: 2, d: 0 },
      { x: 3, y: 2, d: 0 },
      { x: 2, y: 3, d: 0 },
      { x: 3, y: 3, d: 0 }
    ]);
  });

  it('propagates dirty full-res tiles up the tree', () => {
    expect(tilesPerSideAtDepth(8, 2)).toBe(2);
    expect(ancestorsForDirtyTile({ x: 7, y: 6, d: 0 }, 8)).toEqual([
      { x: 3, y: 3, d: 1 },
      { x: 1, y: 1, d: 2 },
      { x: 0, y: 0, d: 3 }
    ]);
  });
});
