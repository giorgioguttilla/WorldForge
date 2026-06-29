import { describe, expect, it } from 'vitest';
import type { WorldConfig } from '../heightmap/worldConfig';
import { extractRiverAssets } from './riverExtraction';

const config: WorldConfig = {
  id: 'river-world',
  name: 'River World',
  tileSize: 32,
  tilesPerSide: 1,
  unitSize: 1,
  unit: 'foot',
  worldHeight: 512,
  water: { visible: false, level: 0 },
  createdAt: 'now',
  updatedAt: 'now',
  version: 1
};

describe('river extraction', () => {
  it('extracts a downhill river asset from a strong water-mask source', async () => {
    const heights = new Uint16Array(config.tileSize * config.tileSize);
    const mask = new Uint16Array(config.tileSize * config.tileSize);
    for (let y = 0; y < config.tileSize; y += 1) {
      for (let x = 0; x < config.tileSize; x += 1) {
        const elevation01 = 1 - (x + y) / ((config.tileSize - 1) * 2);
        heights[y * config.tileSize + x] = Math.round(elevation01 * 65535);
      }
    }
    mask[3 * config.tileSize + 3] = 65535;
    mask[4 * config.tileSize + 4] = 45000;
    mask[5 * config.tileSize + 5] = 32000;

    const rivers = await extractRiverAssets(config, {
      readTile: async () => heights,
      readWaterMaskTile: async () => mask
    }, 'test-time');

    expect(rivers.length).toBeGreaterThan(0);
    expect(rivers[0].source).toBe('erosion-water-mask-v1');
    expect(rivers[0].points.length).toBeGreaterThan(2);
    expect(rivers[0].points[0].elevation).toBeGreaterThan(rivers[0].points.at(-1)?.elevation ?? 0);
  });

  it('keeps river sources from separate regions instead of only the strongest area', async () => {
    const heights = new Uint16Array(config.tileSize * config.tileSize);
    const mask = new Uint16Array(config.tileSize * config.tileSize);
    for (let y = 0; y < config.tileSize; y += 1) {
      for (let x = 0; x < config.tileSize; x += 1) {
        const elevation01 = 1 - x / (config.tileSize - 1);
        heights[y * config.tileSize + x] = Math.round(elevation01 * 65535);
      }
    }
    for (let x = 2; x < 9; x += 1) {
      mask[4 * config.tileSize + x] = 65535 - x * 100;
      mask[24 * config.tileSize + x] = 58000 - x * 100;
    }

    const rivers = await extractRiverAssets(config, {
      readTile: async () => heights,
      readWaterMaskTile: async () => mask
    }, 'test-time');

    expect(rivers.length).toBeGreaterThanOrEqual(2);
    expect(rivers.some((river) => river.points[0].z < -4)).toBe(true);
    expect(rivers.some((river) => river.points[0].z > 4)).toBe(true);
  });
});
