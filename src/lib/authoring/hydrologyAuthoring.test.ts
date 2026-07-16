import { describe, expect, it } from 'vitest';
import type { TileManager } from '../heightmap/tileManager';
import type { HydrologySceneV2 } from './authoringDocument';
import { encodeDInfinityAngle, type HydrologyTopologyV3 } from './hydrologyBake';
import { addRiverSourceAtWorld, addWaterFillAtWorld, rebuildRiverNetworkFromSources, simplifyLakeRing, simplifyRiverPolyline, smoothRiverLateralJitter } from './hydrologyAuthoring';

const SIDE = 5;
const EMPTY: HydrologySceneV2 = { version: 2, channelThreshold: 512, waterBodies: [], riverSources: [], reaches: [], basinNodes: [] };

describe('authored graph hydrology tools', () => {
  it('does not spend work extracting disconnected channels without an authored trunk', async () => {
    const accumulation = grid();
    accumulation[2 * SIDE + 1] = 2;
    accumulation[2 * SIDE + 2] = 3;
    accumulation[2 * SIDE + 3] = 4;
    accumulation[2 * SIDE + 4] = 5;
    const hydrology = await rebuildRiverNetworkFromSources(mockManager({
      accumulation,
      receivers: receiverGrid([[1, 2, 0], [2, 2, 0], [3, 2, 0]])
    }), { ...EMPTY, channelThreshold: 2 });
    expect(hydrology.riverSources).toHaveLength(0);
    expect(hydrology.reaches).toHaveLength(0);
  });

  it('compresses automatic tributaries into reaches split at their confluence', async () => {
    const accumulation = grid();
    for (const [x, y, value] of [[1, 1, 2], [3, 1, 2], [2, 2, 4], [2, 3, 5], [2, 4, 6]] as Array<[number, number, number]>) {
      accumulation[y * SIDE + x] = value;
    }
    const result = await addRiverSourceAtWorld(mockManager({
      accumulation,
      receivers: receiverGrid([[1, 1, Math.PI / 4], [3, 1, Math.PI * 3 / 4], [2, 2, Math.PI / 2], [2, 3, Math.PI / 2]])
    }), { ...EMPTY, channelThreshold: 2 }, 0, 0);
    if (!result.ok) throw new Error(result.reason);
    const hydrology = result.hydrology;
    expect(hydrology.reaches).toHaveLength(3);
    const downstream = hydrology.reaches.find((reach) => reach.startCellId === 12);
    expect(downstream).toMatchObject({ endCellId: 22, discharge: 7, termination: 'edge' });
    expect(hydrology.reaches.filter((reach) => reach.downstreamReachId === downstream?.id)).toHaveLength(2);
  });

  it('finds an inward tributary across a tile boundary without scanning the world', async () => {
    const side = 4;
    const accumulation = new Array(side * side).fill(0);
    for (const [x, value] of [[1, 2], [2, 4], [3, 5]] as Array<[number, number]>) accumulation[side + x] = value;
    const receivers = new Array(side * side).fill(65535);
    for (const x of [1, 2]) receivers[side + x] = encodeDInfinityAngle(0);
    const result = await addRiverSourceAtWorld(mockTiledManager(side, 2, accumulation, receivers), { ...EMPTY, channelThreshold: 2 }, 0, -1);
    if (!result.ok) throw new Error(result.reason);
    expect(result.hydrology.reaches).toHaveLength(2);
    expect(result.hydrology.reaches.some((reach) => reach.startCellId === 5 && reach.endCellId === 6)).toBe(true);
    expect(result.hydrology.reaches.some((reach) => reach.startCellId === 6 && reach.endCellId === 7 && reach.discharge === 6)).toBe(true);
  });

  it('unions an authored source into the automatic graph and adds downstream discharge', async () => {
    const accumulation = grid();
    for (const [x, value] of [[1, 2], [2, 3], [3, 4], [4, 5]] as Array<[number, number]>) accumulation[2 * SIDE + x] = value;
    const manager = mockManager({
      accumulation,
      receivers: receiverGrid([[1, 2, 0], [2, 2, 0], [3, 2, 0]])
    });
    const automatic = await rebuildRiverNetworkFromSources(manager, { ...EMPTY, channelThreshold: 2 });
    const result = await addRiverSourceAtWorld(manager, automatic, 0, 0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const downstream = result.hydrology.reaches.find((reach) => reach.startCellId === 12);
    expect(downstream).toMatchObject({ endCellId: 14, discharge: 6, termination: 'edge' });
    expect(downstream?.sourceIds).toEqual([result.source.id]);
  });

  it('materializes the clicked durable basin record and avoids duplicates', async () => {
    const basins = grid();
    for (const [x, y] of [[1, 1], [2, 1], [1, 2], [2, 2]]) basins[y * SIDE + x] = 7;
    const manager = mockManager({ basins, basinRecords: [{ id: 7, fill: 120, depth: 30, bounds: [1, 1, 2, 2] }] });

    const first = await addWaterFillAtWorld(manager, EMPTY, -1, -1);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.waterBody).toMatchObject({ basinId: 7, areaCells: 4, waterLevelR16: 120, maxDepthR16: 30 });
    expect(first.waterBody.rings[0].length).toBeGreaterThanOrEqual(4);

    const second = await addWaterFillAtWorld(manager, first.hydrology, 0, 0);
    expect(second.ok && second.created).toBe(false);
    if (second.ok) expect(second.hydrology.waterBodies).toHaveLength(1);
  });

  it('stores a source constraint and follows dominant baked receivers to the edge', async () => {
    const receivers = receiverGrid([[1, 2, 0], [2, 2, 0], [3, 2, 0]]);
    const result = await addRiverSourceAtWorld(mockManager({ receivers }), EMPTY, -1, 0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hydrology.riverSources).toHaveLength(1);
    expect(result.hydrology.reaches).toHaveLength(1);
    expect(result.hydrology.reaches[0]).toMatchObject({ startCellId: 11, endCellId: 14, termination: 'edge', discharge: 1 });
  });

  it('unions tributaries into shared reaches and accumulates downstream discharge', async () => {
    const receivers = receiverGrid([[1, 2, 0], [2, 2, 0], [3, 2, 0], [2, 1, Math.PI / 2]]);
    const manager = mockManager({ receivers });
    const first = await addRiverSourceAtWorld(manager, EMPTY, -1, 0);
    if (!first.ok) throw new Error(first.reason);
    const second = await addRiverSourceAtWorld(manager, first.hydrology, 0, -1);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.hydrology.riverSources).toHaveLength(2);
    expect(second.hydrology.reaches).toHaveLength(3);
    const shared = second.hydrology.reaches.find((reach) => reach.startCellId === 12);
    expect(shared).toMatchObject({ discharge: 2, termination: 'edge' });
    expect(shared?.sourceIds).toHaveLength(2);
  });

  it('continues through a basin using its baked spill edge and carries discharge across it', async () => {
    const basins = grid(); basins[2 * SIDE + 2] = 9;
    const receivers = receiverGrid([[1, 2, 0], [3, 2, 0]]);
    const result = await addRiverSourceAtWorld(mockManager({
      basins,
      receivers,
      basinRecords: [{ id: 9, fill: 200, depth: 12, bounds: [2, 2, 2, 2], outlet: [12, 13, 0] }]
    }), EMPTY, -1, 0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.createdWaterBodies).toBe(1);
    expect(result.basinDiagnostics).toEqual({ total: 1, continuous: 1, terminal: 0 });
    expect(result.hydrology.reaches).toHaveLength(2);
    expect(result.hydrology.reaches[0]).toMatchObject({ endCellId: 12, termination: 'water-body', targetBasinId: 9, discharge: 1 });
    expect(result.hydrology.reaches[1]).toMatchObject({ startCellId: 13, termination: 'edge', discharge: 1 });
    expect(result.hydrology.basinNodes[0]).toMatchObject({
      basinId: 9,
      status: 'continuous',
      spillCellId: 12,
      downstreamCellId: 13,
      inflowDischarge: 1,
      outflowDischarge: 1
    });
  });

  it('terminates only when the baked basin has no valid spill edge', async () => {
    const basins = grid(); basins[2 * SIDE + 3] = 9;
    const receivers = receiverGrid([[1, 2, 0], [2, 2, 0]]);
    const result = await addRiverSourceAtWorld(mockManager({
      basins,
      receivers,
      basinRecords: [{ id: 9, fill: 200, depth: 12, bounds: [3, 2, 3, 2] }]
    }), EMPTY, -1, 0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.createdWaterBodies).toBe(1);
    expect(result.basinDiagnostics).toEqual({ total: 1, continuous: 0, terminal: 1 });
    expect(result.hydrology.waterBodies[0].basinId).toBe(9);
    expect(result.hydrology.reaches.at(-1)).toMatchObject({ endCellId: 13, termination: 'water-body' });
    expect(result.hydrology.basinNodes[0]).toMatchObject({ basinId: 9, status: 'terminal', outflowDischarge: 0 });
  });

  it('routes a long chain through multiple continuous basins without momentum', async () => {
    const basins = grid();
    basins[1 * SIDE + 2] = 7;
    basins[3 * SIDE + 3] = 9;
    const receivers = receiverGrid([
      [1, 1, 0],
      [3, 1, Math.PI / 2],
      [3, 2, Math.PI / 2],
      [2, 3, Math.PI],
      [1, 3, Math.PI]
    ]);
    const result = await addRiverSourceAtWorld(mockManager({
      basins,
      receivers,
      basinRecords: [
        { id: 7, fill: 180, depth: 8, bounds: [2, 1, 2, 1], outlet: [7, 8, 0] },
        { id: 9, fill: 140, depth: 10, bounds: [3, 3, 3, 3], outlet: [18, 17, 0] }
      ]
    }), EMPTY, -1, -1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.basinDiagnostics).toEqual({ total: 2, continuous: 2, terminal: 0 });
    expect(result.hydrology.waterBodies).toHaveLength(2);
    expect(result.hydrology.basinNodes).toHaveLength(2);
    expect(result.hydrology.reaches).toHaveLength(3);
    expect(result.hydrology.reaches.every((reach) => reach.discharge === 1)).toBe(true);
  });

  it('rejects a malformed outlet that returns directly into its source basin', async () => {
    const basins = grid(); basins[2 * SIDE + 2] = 9;
    const result = await addRiverSourceAtWorld(mockManager({
      basins,
      receivers: receiverGrid([[1, 2, 0]]),
      basinRecords: [{ id: 9, fill: 200, depth: 12, bounds: [2, 2, 2, 2], outlet: [12, 12, 9] }]
    }), EMPTY, -1, 0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.basinDiagnostics).toEqual({ total: 1, continuous: 0, terminal: 1 });
    expect(result.hydrology.basinNodes[0].outletReachId).toBeUndefined();
  });

  it('reuses a durable source at the same cell instead of duplicating it', async () => {
    const manager = mockManager({ receivers: receiverGrid([[1, 2, 0], [2, 2, 0], [3, 2, 0]]) });
    const first = await addRiverSourceAtWorld(manager, EMPTY, -1, 0);
    if (!first.ok) throw new Error(first.reason);
    const second = await addRiverSourceAtWorld(manager, first.hydrology, -1, 0);
    expect(second.ok && second.replaced).toBe(true);
    if (second.ok) expect(second.hydrology.riverSources).toHaveLength(1);
  });

  it('fails cleanly when graph data has not been baked', async () => {
    const manager = mockManager({ topology: null });
    const result = await addRiverSourceAtWorld(manager, EMPTY, 0, 0);
    expect(result).toEqual({ ok: false, reason: 'Hydrology graph data is unavailable. Bake the terrain first.' });
  });
});

describe('hydrology geometry cleanup', () => {
  it('simplifies river bends in xyz rather than xz alone', () => {
    const points = [{ x: 0, z: 0, heightR16: 0 }, { x: 1, z: 0, heightR16: 30000 }, { x: 2, z: 0, heightR16: 0 }];
    expect(simplifyRiverPolyline(points, 0.1, 100)).toHaveLength(3);
  });

  it('smooths lateral raster jitter but preserves endpoints and elevations', () => {
    const points = Array.from({ length: 7 }, (_, index) => ({ x: index, z: index % 2, heightR16: index }));
    const smoothed = smoothRiverLateralJitter(points);
    expect(smoothed[0]).toEqual(points[0]);
    expect(smoothed.at(-1)).toEqual(points.at(-1));
    expect(smoothed[3].heightR16).toBe(3);
    expect(smoothed[3].z).toBeLessThan(points[3].z);
  });

  it('keeps simplified lake rings closed', () => {
    const ring = [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 2, z: 2 }, { x: 0, z: 2 }, { x: 0, z: 0 }];
    const simplified = simplifyLakeRing(ring, 0.2);
    expect(simplified[0]).toEqual(simplified.at(-1));
    expect(simplified.length).toBeGreaterThanOrEqual(4);
  });
});

function grid(): number[] { return new Array(SIDE * SIDE).fill(0); }
function receiverGrid(entries: Array<[number, number, number]>): number[] {
  const values = new Array(SIDE * SIDE).fill(65535);
  for (const [x, y, angle] of entries) values[y * SIDE + x] = encodeDInfinityAngle(angle);
  return values;
}

function mockManager(options: {
  basins?: number[];
  receivers?: number[];
  flows?: number[];
  accumulation?: number[];
  basinRecords?: Array<{ id: number; fill: number; depth: number; bounds: [number, number, number, number]; outlet?: [number, number, number] }>;
  topology?: HydrologyTopologyV3 | null;
} = {}): TileManager {
  const basins = Uint32Array.from(options.basins ?? grid());
  const records = options.basinRecords ?? [];
  const spillCells = new Uint32Array(records.length); spillCells.fill(0xffffffff);
  const downstreamCells = new Uint32Array(records.length); downstreamCells.fill(0xffffffff);
  const downstreamIds = new Uint32Array(records.length); downstreamIds.fill(0xffffffff);
  records.forEach((record, index) => {
    if (!record.outlet) return;
    spillCells[index] = record.outlet[0];
    downstreamCells[index] = record.outlet[1];
    downstreamIds[index] = record.outlet[2];
  });
  const topology: HydrologyTopologyV3 = options.topology ?? {
    version: 3,
    width: SIDE,
    height: SIDE,
    nodeCount: records.length,
    receiverEncoding: 'd-infinity-angle-u16-turn65528',
    basinIds: Uint32Array.from(records.map((record) => record.id)),
    fillHeights: Uint16Array.from(records.map((record) => record.fill)),
    downstreamIds,
    spillCells,
    downstreamCells,
    areaCells: Uint32Array.from(records.map((record) => basins.filter((id) => id === record.id).length)),
    maxDepths: Uint16Array.from(records.map((record) => record.depth)),
    minCellX: Uint32Array.from(records.map((record) => record.bounds[0])),
    minCellY: Uint32Array.from(records.map((record) => record.bounds[1])),
    maxCellX: Uint32Array.from(records.map((record) => record.bounds[2])),
    maxCellY: Uint32Array.from(records.map((record) => record.bounds[3]))
  };
  return {
    config: { tileSize: SIDE, tilesPerSide: 1, unitSize: 1, worldHeight: 1000 },
    readTile: async () => Uint16Array.from({ length: SIDE * SIDE }, (_, index) => 1000 - index),
    readBasinIdTile: async () => basins,
    readReceiverDirectionTile: async () => Uint16Array.from(options.receivers ?? new Array(SIDE * SIDE).fill(65535)),
    readFlowStrengthTile: async () => Uint16Array.from(options.flows ?? grid()),
    readFlowAccumulationTile: async () => Float32Array.from(options.accumulation ?? grid()),
    readHydrologyTopology: async () => options.topology === null ? null : topology
  } as unknown as TileManager;
}

function mockTiledManager(side: number, tileSize: number, accumulation: number[], receivers: number[]): TileManager {
  const tilesPerSide = side / tileSize;
  const tile = <T extends Uint16Array | Uint32Array | Float32Array>(values: number[], x: number, y: number, make: (items: number[]) => T): T => {
    const items: number[] = [];
    for (let localY = 0; localY < tileSize; localY += 1) for (let localX = 0; localX < tileSize; localX += 1) {
      items.push(values[(y * tileSize + localY) * side + x * tileSize + localX]);
    }
    return make(items);
  };
  const topology: HydrologyTopologyV3 = {
    version: 3,
    width: side,
    height: side,
    nodeCount: 0,
    receiverEncoding: 'd-infinity-angle-u16-turn65528',
    basinIds: new Uint32Array(),
    fillHeights: new Uint16Array(),
    downstreamIds: new Uint32Array(),
    spillCells: new Uint32Array(),
    downstreamCells: new Uint32Array(),
    areaCells: new Uint32Array(),
    maxDepths: new Uint16Array(),
    minCellX: new Uint32Array(), minCellY: new Uint32Array(),
    maxCellX: new Uint32Array(), maxCellY: new Uint32Array()
  };
  const zeros = new Array(side * side).fill(0);
  return {
    config: { tileSize, tilesPerSide, unitSize: 1, worldHeight: 1000 },
    readTile: async ({ x, y }: { x: number; y: number }) => tile(new Array(side * side).fill(100), x, y, (items) => Uint16Array.from(items)),
    readBasinIdTile: async ({ x, y }: { x: number; y: number }) => tile(zeros, x, y, (items) => Uint32Array.from(items)),
    readReceiverDirectionTile: async ({ x, y }: { x: number; y: number }) => tile(receivers, x, y, (items) => Uint16Array.from(items)),
    readFlowAccumulationTile: async ({ x, y }: { x: number; y: number }) => tile(accumulation, x, y, (items) => Float32Array.from(items)),
    readHydrologyTopology: async () => topology
  } as unknown as TileManager;
}
