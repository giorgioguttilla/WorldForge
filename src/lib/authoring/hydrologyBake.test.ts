import { describe, expect, it } from 'vitest';
import type { TileKey } from '../heightmap/tileKey';
import type { WorldConfig } from '../heightmap/worldConfig';
import { decodeDInfinityRecipients, runHydrologyBasinBake } from './hydrologyBake';

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

  it('calculates non-rectangular fill regions without generating scene objects', async () => {
    const samples = [
      10, 10, 10, 10, 10,
      10, 2, 10, 10, 10,
      10, 2, 2, 2, 10,
      10, 10, 10, 10, 10,
      10, 10, 10, 10, 10
    ];
    const result = await bakeSmallMap(config(5, 1), samples);

    expect([...result.lakeFill]).toEqual(referenceLakeFill(5, 5, samples));
    expect(result.summary).not.toHaveProperty('generatedHydrology');
  });

  it('writes exact accumulation and derives flow strength from conditioned receivers', async () => {
    const samples = [
      9, 8, 7, 6,
      8, 7, 6, 5,
      7, 6, 5, 4,
      6, 5, 4, 3
    ];
    const result = await bakeSmallMap(config(2, 2), samples);

    expectReceiverGraphIsAcyclic(4, result.receivers);
    expectAccumulationMatchesReceivers(4, result.receivers, result.flowAccumulation);
    expect([...result.flowStrength]).toEqual(encodeFlowStrength(result.flowAccumulation));
    expect(result.summary.flowStrength).toBe('log1p-contributing-area-r16');
    expect(result.summary.flowAccumulation).toBe('contributing-area-f32');
    expect(result.summary.receiverDirections).toBe('conditioned-flat-resolved-d-infinity-u16');
    expect(result.summary.flowTileCount).toBe(4);
    expect(result.summary.maxFlowAccumulation).toBeGreaterThan(1);
    expect(result).not.toHaveProperty('generatedHydrology');
  });

  it('splits flow continuously between D-infinity neighbors', async () => {
    const side = 5;
    const samples = Array.from({ length: side * side }, (_, index) => {
      const x = index % side;
      const y = Math.floor(index / side);
      return 100 - x * 2 - y;
    });
    const result = await bakeSmallMap(config(side, 1), samples);
    const split = decodeDInfinityRecipients(result.receivers[2 * side + 2]);

    expect(split).not.toBeNull();
    expect(split?.weightA).toBeGreaterThan(0);
    expect(split?.weightB).toBeGreaterThan(0);
    expectAccumulationMatchesReceivers(side, result.receivers, result.flowAccumulation);
  });

  it('routes filled basins through persisted cross-tile spill topology', async () => {
    const samples = [
      10, 10, 10, 10,
      10, 2, 2, 9,
      10, 2, 2, 8,
      10, 10, 7, 6
    ];
    const result = await bakeSmallMap(config(2, 2), samples);

    expect([...result.lakeFill]).toEqual(referenceLakeFill(4, 4, samples));
    expectReceiverGraphIsAcyclic(4, result.receivers);
    expectAccumulationMatchesReceivers(4, result.receivers, result.flowAccumulation);
    const filledIds = [...result.basinIds].filter((id) => id !== 0);
    expect(new Set(filledIds).size).toBe(1);
    expect(filledIds.length).toBe(result.summary.lakeCellCount);
    expect(result.summary.basinCount).toBe(1);
    expect(result.topology.nodeCount).toBe(1);
    expect([...result.topology.basinIds]).toEqual([...new Set(filledIds)]);
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

  it('keeps flow strength deterministic without workers', async () => {
    const samples = [
      9, 9, 9, 9,
      9, 1, 1, 8,
      9, 1, 1, 7,
      9, 8, 7, 6
    ];
    const first = await bakeSmallMap(config(2, 2), samples);
    const second = await bakeSmallMap(config(2, 2), samples);

    expect([...second.flowStrength]).toEqual([...first.flowStrength]);
    expect(second.summary.maxFlowAccumulation).toBe(first.summary.maxFlowAccumulation);
  });

  it('is invariant to tile subdivision for basins, receivers, and accumulation', async () => {
    const side = 32;
    const samples = Array.from({ length: side * side }, (_, index) => {
      const x = index % side;
      const y = Math.floor(index / side);
      const dx = (x - 15.5) / 12;
      const dy = (y - 15.5) / 10;
      if (dx * dx + dy * dy <= 1) return 4 + ((x + y) & 1);
      return 220 - x * 2 - y;
    });
    const oneTile = await bakeSmallMap(config(32, 1), samples);
    const sixteenTiles = await bakeSmallMap(config(8, 4), samples);

    expect([...sixteenTiles.lakeFill]).toEqual([...oneTile.lakeFill]);
    expect([...sixteenTiles.basinIds]).toEqual([...oneTile.basinIds]);
    expect([...sixteenTiles.receivers]).toEqual([...oneTile.receivers]);
    expect([...sixteenTiles.flowAccumulation]).toEqual([...oneTile.flowAccumulation]);
    expect([...sixteenTiles.flowStrength]).toEqual([...oneTile.flowStrength]);
  });
});

async function bakeSmallMap(config: WorldConfig, samples: number[]): Promise<{
  lakeFill: Uint16Array;
  basinIds: Uint32Array;
  receivers: Uint16Array;
  flowStrength: Uint16Array;
  flowAccumulation: Float32Array;
  topology: { nodeCount: number; basinIds: Uint32Array; downstreamIds: Uint32Array; spillCells: Uint32Array; downstreamCells: Uint32Array };
  summary: Awaited<ReturnType<typeof runHydrologyBasinBake>>['summary'];
}> {
  const tiles = new Map<string, Uint16Array>();
  const lakeFillTiles = new Map<string, Uint16Array>();
  const drainageSurfaceTiles = new Map<string, Uint16Array>();
  const basinIdTiles = new Map<string, Uint32Array>();
  const flatDistanceTiles = new Map<string, Uint32Array>();
  const receiverTiles = new Map<string, Uint16Array>();
  const flowStrengthTiles = new Map<string, Uint16Array>();
  const flowAccumulationTiles = new Map<string, Float32Array>();
  let topology: { nodeCount: number; basinIds: Uint32Array; downstreamIds: Uint32Array; spillCells: Uint32Array; downstreamCells: Uint32Array } | undefined;
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
    },
    async readLakeFillHeightTile(key) {
      return lakeFillTiles.get(id(key)) ?? null;
    },
    async writeDrainageSurfaceTile(key, tile) {
      drainageSurfaceTiles.set(id(key), tile);
    },
    async readDrainageSurfaceTile(key) {
      return drainageSurfaceTiles.get(id(key)) ?? null;
    },
    async writeBasinIdTile(key, tile) {
      basinIdTiles.set(id(key), tile);
    },
    async readBasinIdTile(key) {
      return basinIdTiles.get(id(key)) ?? null;
    },
    async writeFlatDistanceTile(key, tile) {
      flatDistanceTiles.set(id(key), tile);
    },
    async readFlatDistanceTile(key) {
      return flatDistanceTiles.get(id(key)) ?? null;
    },
    async writeReceiverDirectionTile(key, tile) {
      receiverTiles.set(id(key), tile);
    },
    async readReceiverDirectionTile(key) {
      return receiverTiles.get(id(key)) ?? null;
    },
    async writeFlowStrengthTile(key, tile) {
      flowStrengthTiles.set(id(key), tile);
    },
    async writeFlowAccumulationTile(key, tile) {
      flowAccumulationTiles.set(id(key), tile);
    },
    async readFlowAccumulationTile(key) {
      return flowAccumulationTiles.get(id(key)) ?? null;
    },
    async writeHydrologyTopology(value) {
      topology = value;
    }
  }, undefined, { useWorkers: false });

  return {
    lakeFill: stitch(config, lakeFillTiles),
    basinIds: stitchU32(config, basinIdTiles),
    receivers: stitchU16(config, receiverTiles),
    flowStrength: stitch(config, flowStrengthTiles),
    flowAccumulation: stitchF32(config, flowAccumulationTiles),
    topology: topology ?? { nodeCount: 0, basinIds: new Uint32Array(), downstreamIds: new Uint32Array(), spillCells: new Uint32Array(), downstreamCells: new Uint32Array() },
    summary: result.summary
  };
}

function stitchU16(config: WorldConfig, tiles: Map<string, Uint16Array>): Uint16Array {
  return stitchTyped(config, tiles, Uint16Array);
}

function stitchU32(config: WorldConfig, tiles: Map<string, Uint32Array>): Uint32Array {
  return stitchTyped(config, tiles, Uint32Array);
}

function stitchF32(config: WorldConfig, tiles: Map<string, Float32Array>): Float32Array {
  return stitchTyped(config, tiles, Float32Array);
}

function stitchTyped<T extends Uint16Array | Uint32Array | Float32Array>(
  config: WorldConfig,
  tiles: Map<string, T>,
  Constructor: new (length: number) => T
): T {
  const fullSide = config.tileSize * config.tilesPerSide;
  const output = new Constructor(fullSide * fullSide);
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

const RECEIVER_DX = [0, 1, 0, 1, -1, 0, -1, 1, -1];
const RECEIVER_DY = [0, 0, 1, 1, 0, -1, -1, -1, 1];

function expectReceiverGraphIsAcyclic(width: number, receivers: Uint16Array): void {
  const indegree = new Uint32Array(receivers.length);
  const edges = Array.from({ length: receivers.length }, () => [] as number[]);
  for (let source = 0; source < receivers.length; source += 1) {
    const split = decodeDInfinityRecipients(receivers[source]);
    if (!split) continue;
    const x = source % width;
    const y = Math.floor(source / width);
    for (const [code, weight] of [[split.codeA, split.weightA], [split.codeB, split.weightB]] as const) {
      if (weight <= 0) continue;
      const nx = x + RECEIVER_DX[code];
      const ny = y + RECEIVER_DY[code];
      expect(nx).toBeGreaterThanOrEqual(0);
      expect(ny).toBeGreaterThanOrEqual(0);
      expect(nx).toBeLessThan(width);
      expect(ny).toBeLessThan(width);
      const target = ny * width + nx;
      edges[source].push(target);
      indegree[target] += 1;
    }
  }
  const queue = [...indegree.keys()].filter((cell) => indegree[cell] === 0);
  let visited = 0;
  for (let head = 0; head < queue.length; head += 1) {
    visited += 1;
    for (const target of edges[queue[head]]) if (--indegree[target] === 0) queue.push(target);
  }
  expect(visited, 'D-infinity receiver graph must be acyclic').toBe(receivers.length);
}

function expectAccumulationMatchesReceivers(width: number, receivers: Uint16Array, accumulation: Float32Array): void {
  const expected = new Float64Array(receivers.length);
  expected.fill(1);
  for (let source = 0; source < receivers.length; source += 1) {
    const contribution = accumulation[source];
    const split = decodeDInfinityRecipients(receivers[source]);
    if (!split) continue;
    const x = source % width;
    const y = Math.floor(source / width);
    for (const [code, weight] of [[split.codeA, split.weightA], [split.codeB, split.weightB]] as const) {
      if (weight <= 0) continue;
      const target = (y + RECEIVER_DY[code]) * width + x + RECEIVER_DX[code];
      expected[target] += contribution * weight;
    }
  }
  for (let i = 0; i < expected.length; i += 1) expect(accumulation[i]).toBeCloseTo(expected[i], 5);
}

function encodeFlowStrength(accumulation: Float32Array): number[] {
  const max = Math.max(...accumulation);
  const denominator = Math.log1p(Math.max(0, max - 1));
  return [...accumulation].map((flow) => {
    const effective = Math.max(0, flow - 1);
    return denominator > 0 && effective > 0 ? Math.min(65535, Math.round(65535 * Math.log1p(effective) / denominator)) : 0;
  });
}

function cellsAreNeighbors(width: number, a: number, b: number): boolean {
  const dx = Math.abs((a % width) - (b % width));
  const dy = Math.abs(Math.floor(a / width) - Math.floor(b / width));
  return dx <= 1 && dy <= 1 && dx + dy > 0;
}

function referenceFlowStrength(width: number, height: number, input: number[]): number[] {
  const receivers = new Int32Array(input.length);
  const indegree = new Uint32Array(input.length);
  receivers.fill(-1);
  const directions = [
    [1, 0], [0, 1], [1, 1], [-1, 0],
    [0, -1], [-1, -1], [1, -1], [-1, 1]
  ];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const current = input[index];
      let best = -1;
      let bestScore = -1;
      let bestEqual = false;
      for (const [dx, dy] of directions) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const neighborIndex = ny * width + nx;
        const neighbor = input[neighborIndex];
        if (neighbor < current) {
          const score = (current - neighbor) * (dx !== 0 && dy !== 0 ? 707 : 1000);
          if (bestEqual || score > bestScore) {
            best = neighborIndex;
            bestScore = score;
            bestEqual = false;
          }
        } else if (neighbor === current && bestScore < 0 && neighborIndex > index) {
          best = neighborIndex;
          bestScore = 0;
          bestEqual = true;
        }
      }
      receivers[index] = best;
      if (best >= 0) indegree[best] += 1;
    }
  }
  const queue = new Uint32Array(input.length);
  const order = new Uint32Array(input.length);
  let head = 0;
  let tail = 0;
  let orderLength = 0;
  for (let i = 0; i < indegree.length; i += 1) {
    if (indegree[i] === 0) queue[tail++] = i;
  }
  while (head < tail) {
    const current = queue[head++];
    order[orderLength++] = current;
    const receiver = receivers[current];
    if (receiver >= 0) {
      indegree[receiver] -= 1;
      if (indegree[receiver] === 0) queue[tail++] = receiver;
    }
  }
  const accumulation = new Float64Array(input.length);
  accumulation.fill(1);
  let maxFlow = 1;
  for (let i = 0; i < orderLength; i += 1) {
    const current = order[i];
    maxFlow = Math.max(maxFlow, accumulation[current]);
    const receiver = receivers[current];
    if (receiver >= 0) accumulation[receiver] += accumulation[current];
  }
  const denominator = Math.log1p(Math.max(0, maxFlow - 1));
  return [...accumulation].map((flow) => {
    const effective = Math.max(0, flow - 1);
    return denominator > 0 && effective > 0 ? Math.min(65535, Math.round(65535 * Math.log1p(effective) / denominator)) : 0;
  });
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
