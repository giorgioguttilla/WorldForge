import { describe, expect, it } from 'vitest';
import type { TileKey } from '../heightmap/tileKey';
import type { WorldConfig } from '../heightmap/worldConfig';
import { runHydrologyBasinBake } from './hydrologyBake';

function config(tileSize: number, tilesPerSide: number): WorldConfig {
  return {
    id: 'world',
    name: 'World',
    tileSize,
    tilesPerSide,
    unitSize: 1,
    unit: 'meter',
    worldHeight: 65535,
    water: { visible: false, level: 0 },
    createdAt: 'now',
    updatedAt: 'now',
    version: 1
  };
}

describe('hydrology basin bake', () => {
  it('matches full-map priority flood for a one-cell pit', async () => {
    const samples = [
      10, 10, 10,
      10, 1, 10,
      10, 10, 10
    ];
    const result = await bakeSmallMap(config(3, 1), samples);

    expect([...result.lakeFill]).toEqual(referenceLakeFill(3, 3, samples));
    expect(result.lakeFill[4]).toBe(10);
    expect(result.summary.lakeCellCount).toBe(1);
    expect(result.summary.maxDepth).toBe(9);
  });

  it('does not fill a low region touching the absolute ocean edge', async () => {
    const samples = [
      1, 1, 10,
      1, 1, 10,
      10, 10, 10
    ];
    const result = await bakeSmallMap(config(3, 1), samples);

    expect([...result.lakeFill]).toEqual(referenceLakeFill(3, 3, samples));
    expect(result.summary.lakeCellCount).toBe(0);
  });

  it('fills a basin spanning tile boundaries', async () => {
    const samples = [
      10, 10, 10, 10,
      10, 2, 2, 10,
      10, 2, 2, 10,
      10, 10, 10, 10
    ];
    const result = await bakeSmallMap(config(2, 2), samples);

    expect([...result.lakeFill]).toEqual(referenceLakeFill(4, 4, samples));
    expect(result.summary.lakeCellCount).toBe(4);
    expect(result.summary.maxDepth).toBe(8);
  });

  it('uses diagonal 8-connected outlets', async () => {
    const samples = [
      1, 10, 10,
      10, 1, 10,
      10, 10, 10
    ];
    const result = await bakeSmallMap(config(3, 1), samples);

    expect([...result.lakeFill]).toEqual(referenceLakeFill(3, 3, samples));
    expect(result.lakeFill[4]).toBe(0);
  });
});

async function bakeSmallMap(config: WorldConfig, samples: number[]): Promise<{ lakeFill: Uint16Array; summary: Awaited<ReturnType<typeof runHydrologyBasinBake>>['summary'] }> {
  const tiles = new Map<string, Uint16Array>();
  const lakeFillTiles = new Map<string, Uint16Array>();
  const fullSide = config.tileSize * config.tilesPerSide;
  for (let ty = 0; ty < config.tilesPerSide; ty += 1) {
    for (let tx = 0; tx < config.tilesPerSide; tx += 1) {
      const tile = new Uint16Array(config.tileSize * config.tileSize);
      for (let y = 0; y < config.tileSize; y += 1) {
        for (let x = 0; x < config.tileSize; x += 1) {
          const globalX = tx * config.tileSize + x;
          const globalY = ty * config.tileSize + y;
          tile[y * config.tileSize + x] = samples[globalY * fullSide + globalX];
        }
      }
      tiles.set(id({ x: tx, y: ty, d: 0 }), tile);
    }
  }

  const result = await runHydrologyBasinBake(config, {
    async readTile(key) {
      const tile = tiles.get(id(key));
      if (!tile) throw new Error(`missing ${id(key)}`);
      return tile;
    },
    async writeLakeFillHeightTile(key, tile) {
      lakeFillTiles.set(id(key), tile);
    }
  }, undefined, { useWorkers: false });

  return {
    lakeFill: stitch(config, lakeFillTiles),
    summary: result.summary
  };
}

function stitch(config: WorldConfig, tiles: Map<string, Uint16Array>): Uint16Array {
  const fullSide = config.tileSize * config.tilesPerSide;
  const output = new Uint16Array(fullSide * fullSide);
  for (let ty = 0; ty < config.tilesPerSide; ty += 1) {
    for (let tx = 0; tx < config.tilesPerSide; tx += 1) {
      const tile = tiles.get(id({ x: tx, y: ty, d: 0 }));
      if (!tile) throw new Error(`missing output ${tx},${ty}`);
      for (let y = 0; y < config.tileSize; y += 1) {
        for (let x = 0; x < config.tileSize; x += 1) {
          output[(ty * config.tileSize + y) * fullSide + tx * config.tileSize + x] = tile[y * config.tileSize + x];
        }
      }
    }
  }
  return output;
}

function referenceFill(width: number, height: number, input: number[]): number[] {
  const filled = input.slice();
  const closed = new Uint8Array(input.length);
  const heap = new RefHeap();
  const pit: number[] = [];
  const seed = (index: number): void => {
    if (closed[index]) return;
    closed[index] = 1;
    heap.push(index, filled[index]);
  };
  for (let x = 0; x < width; x += 1) {
    seed(x);
    seed((height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y += 1) {
    seed(y * width);
    seed(y * width + width - 1);
  }
  while (pit.length > 0 || heap.length > 0) {
    const current = pit.length > 0 ? pit.shift() as number : heap.pop();
    const x = current % width;
    const y = Math.floor(current / width);
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const neighbor = ny * width + nx;
        if (closed[neighbor]) continue;
        closed[neighbor] = 1;
        if (filled[neighbor] <= filled[current]) {
          filled[neighbor] = filled[current];
          pit.push(neighbor);
        } else {
          heap.push(neighbor, filled[neighbor]);
        }
      }
    }
  }
  return filled;
}

function referenceLakeFill(width: number, height: number, input: number[]): number[] {
  const filled = referenceFill(width, height, input);
  return filled.map((fill, index) => fill >= input[index] + 1 ? fill : 0);
}

function id(key: TileKey): string {
  return `d${key.d}/y${key.y}/x${key.x}`;
}

class RefHeap {
  private readonly values: Array<{ index: number; priority: number }> = [];

  get length(): number {
    return this.values.length;
  }

  push(index: number, priority: number): void {
    this.values.push({ index, priority });
    this.values.sort((a, b) => b.priority - a.priority);
  }

  pop(): number {
    const value = this.values.pop();
    if (!value) throw new Error('empty heap');
    return value.index;
  }
}
