import { describe, expect, it } from 'vitest';
import type { WorldConfig } from '../heightmap/worldConfig';
import { EROSION_PRESETS, type LakeAssetV1 } from './authoringDocument';
import { bakeRetainedWaterMasks } from './retainedWaterBake';

const config: WorldConfig = {
  id: 'retained-water-world',
  name: 'Retained Water World',
  tileSize: 64,
  tilesPerSide: 1,
  unitSize: 1,
  unit: 'foot',
  worldHeight: 100,
  water: { visible: false, level: 0 },
  createdAt: 'now',
  updatedAt: 'now',
  version: 1
};

describe('retained water bake', () => {
  it('saves lake polygons from the full resolution retained-water raster', async () => {
    const heights = new Uint16Array(config.tileSize * config.tileSize);
    for (let y = 0; y < config.tileSize; y += 1) {
      for (let x = 0; x < config.tileSize; x += 1) {
        const distance = Math.hypot(x - 32, y - 32);
        const elevation = distance < 15 ? 20 + distance * 0.8 : 45 + distance;
        heights[y * config.tileSize + x] = Math.round((elevation / config.worldHeight) * 65535);
      }
    }

    const coarseLake: LakeAssetV1 = {
      id: 'lake-a',
      name: 'Lake A',
      generatedAt: 'test-time',
      source: 'heightmap-depression-v2',
      waterElevation: 31,
      area: 100,
      maxDepth: 11,
      points: [
        { x: -20, z: -20 },
        { x: 20, z: -20 },
        { x: 20, z: 20 },
        { x: -20, z: 20 }
      ]
    };
    let retained: Uint16Array | null = null;

    const result = await bakeRetainedWaterMasks(config, { ...EROSION_PRESETS.medium, outputWaterMask: true, waterMaskScale: 16 }, [coarseLake], {
      readTile: async () => heights,
      writeRetainedWaterMaskTile: async (_key, samples) => {
        retained = samples;
      }
    });

    expect(result.lakes).toHaveLength(1);
    expect(result.lakes[0].points.length).toBeGreaterThan(8);
    expect(result.lakes[0].points).not.toEqual(coarseLake.points);
    expect(result.lakes[0].area).toBeGreaterThan(coarseLake.area);
    expect(retained && Math.max(...retained)).toBeGreaterThan(0);
  });
});
