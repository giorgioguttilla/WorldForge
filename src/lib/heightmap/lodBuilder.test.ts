import { describe, expect, it } from 'vitest';
import { LodBuilder, downsample2x2Children } from './lodBuilder';
import { tileKeyToId, type TileKey } from './tileKey';

describe('LOD builder', () => {
  it('downsamples four children into one parent tile', () => {
    const children = [
      new Uint16Array([0, 2, 4, 6]),
      new Uint16Array([10, 12, 14, 16]),
      new Uint16Array([20, 22, 24, 26]),
      new Uint16Array([30, 32, 34, 36])
    ];

    expect(downsample2x2Children(2, children)).toEqual(new Uint16Array([3, 13, 23, 33]));
  });

  it('rebuilds only dirty ancestors in depth order', async () => {
    const writes: TileKey[] = [];
    const tiles = new Map<string, Uint16Array>();
    for (let y = 0; y < 2; y += 1) {
      for (let x = 0; x < 2; x += 1) {
        tiles.set(tileKeyToId({ x, y, d: 0 }), new Uint16Array([x + y * 10, x + y * 10, x + y * 10, x + y * 10]));
      }
    }

    const builder = new LodBuilder({
      async readTile(key) {
        const tile = tiles.get(tileKeyToId(key));
        if (!tile) throw new Error(`Missing ${tileKeyToId(key)}`);
        return tile;
      },
      async writeTile(key, samples) {
        writes.push(key);
        tiles.set(tileKeyToId(key), samples);
      }
    }, 2, 2);

    await builder.rebuildFromDirty([{ x: 1, y: 1, d: 0 }]);
    expect(writes).toEqual([{ x: 0, y: 0, d: 1 }]);
    expect(tiles.get('d1/y0/x0')).toEqual(new Uint16Array([0, 1, 10, 11]));
  });
});
