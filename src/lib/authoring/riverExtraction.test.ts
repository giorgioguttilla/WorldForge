import { describe, expect, it } from 'vitest';
import type { WorldConfig } from '../heightmap/worldConfig';
import { extractHydrologyAssets, extractRiverAssets } from './riverExtraction';

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
    expect(rivers[0].source).toBe('heightmap-flow-v2');
    expect(rivers[0].points.length).toBeGreaterThan(2);
    expect(rivers[0].points[0].elevation).toBeGreaterThan(rivers[0].points.at(-1)?.elevation ?? 0);
  });

  it('extracts a drainage river from heightmap flow without a water mask', async () => {
    const heights = new Uint16Array(config.tileSize * config.tileSize);
    for (let y = 0; y < config.tileSize; y += 1) {
      for (let x = 0; x < config.tileSize; x += 1) {
        const eastwardDrop = x / (config.tileSize - 1) * 0.46;
        const valleyRelief = Math.abs(y - 16) / 16 * 0.22;
        const elevation01 = Math.max(0, Math.min(1, 0.78 - eastwardDrop + valleyRelief));
        heights[y * config.tileSize + x] = Math.round(elevation01 * 65535);
      }
    }

    const hydrology = await extractHydrologyAssets(config, {
      readTile: async () => heights
    }, 'test-time');

    expect(hydrology.rivers.length).toBeGreaterThan(0);
    expect(hydrology.rivers[0].source).toBe('heightmap-flow-v2');
    expect(hydrology.rivers[0].points.length).toBeGreaterThan(2);
    expect(hydrology.rivers[0].points[0].elevation).toBeGreaterThan(hydrology.rivers[0].points.at(-1)?.elevation ?? 0);
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

  it('extracts multiple tributary branches from one drainage network', async () => {
    const heights = new Uint16Array(config.tileSize * config.tileSize);
    const mask = new Uint16Array(config.tileSize * config.tileSize);
    for (let y = 0; y < config.tileSize; y += 1) {
      for (let x = 0; x < config.tileSize; x += 1) {
        const elevation01 = 1 - (x + Math.abs(y - 16) * 0.2) / (config.tileSize - 1 + 16 * 0.2);
        heights[y * config.tileSize + x] = Math.round(Math.max(0, elevation01) * 65535);
      }
    }
    for (let x = 2; x < 24; x += 1) {
      mask[10 * config.tileSize + x] = 52000;
      mask[22 * config.tileSize + x] = 50000;
      if (x > 12) mask[16 * config.tileSize + x] = 62000;
    }

    const rivers = await extractRiverAssets(config, {
      readTile: async () => heights,
      readWaterMaskTile: async () => mask
    }, 'test-time');

    expect(rivers.length).toBeGreaterThanOrEqual(2);
    expect(rivers.some((river) => river.points[0].z < 0)).toBe(true);
    expect(rivers.some((river) => river.points[0].z > 0)).toBe(true);
  });

  it('extracts lake assets from closed wet depressions', async () => {
    const heights = new Uint16Array(config.tileSize * config.tileSize);
    const mask = new Uint16Array(config.tileSize * config.tileSize);
    for (let y = 0; y < config.tileSize; y += 1) {
      for (let x = 0; x < config.tileSize; x += 1) {
        const distance = Math.hypot(x - 16, y - 16);
        const basin = Math.min(1, distance / 13);
        heights[y * config.tileSize + x] = Math.round((0.28 + basin * 0.45) * 65535);
        if (distance < 8) mask[y * config.tileSize + x] = 56000;
      }
    }

    const hydrology = await extractHydrologyAssets(config, {
      readTile: async () => heights,
      readWaterMaskTile: async () => mask
    }, 'test-time');

    expect(hydrology.lakes.length).toBeGreaterThan(0);
    expect(hydrology.lakes[0].source).toBe('heightmap-depression-v2');
    expect(hydrology.lakes[0].points.length).toBeGreaterThanOrEqual(8);
    expect(hydrology.lakes[0].maxDepth).toBeGreaterThan(0);
    expect(maxClosedPolygonSegmentLength(hydrology.lakes[0].points)).toBeLessThan(8);
  });

  it('uses water budget to reject dry basins and keep wet basins', async () => {
    const heights = new Uint16Array(config.tileSize * config.tileSize);
    for (let y = 0; y < config.tileSize; y += 1) {
      for (let x = 0; x < config.tileSize; x += 1) {
        const distance = Math.hypot(x - 16, y - 16);
        const basin = Math.min(1, distance / 14);
        heights[y * config.tileSize + x] = Math.round((0.25 + basin * 0.48) * 65535);
      }
    }

    const dry = await extractHydrologyAssets(config, {
      readTile: async () => heights
    }, 'test-time', { rainfall: 0.01, evaporation: 2, infiltration: 0.7 });
    const wet = await extractHydrologyAssets(config, {
      readTile: async () => heights
    }, 'test-time', { rainfall: 1.2, evaporation: 0.05, infiltration: 0.02 });

    expect(dry.lakes.length).toBe(0);
    expect(wet.lakes.length).toBeGreaterThan(0);
  });
});

function maxClosedPolygonSegmentLength(points: Array<{ x: number; z: number }>): number {
  let maxLength = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    maxLength = Math.max(maxLength, Math.hypot(a.x - b.x, a.z - b.z));
  }
  return maxLength;
}
