import { describe, expect, it } from 'vitest';
import type { TileManager } from '../heightmap/tileManager';
import type { HydrologySceneV2 } from './authoringDocument';
import { encodeDInfinityAngle, type HydrologyTopologyV3 } from './hydrologyBake';
import { addRiverSourceAtWorld, addWaterFillAtWorld, simplifyLakeRing, simplifyRiverPolyline, smoothRiverLateralJitter } from './hydrologyAuthoring';

const SIDE = 5;
const EMPTY: HydrologySceneV2 = { version: 2, waterBodies: [], riverSources: [], reaches: [], basinNodes: [] };

describe('authored graph hydrology tools', () => {
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
    readHydrologyTopology: async () => options.topology === null ? null : topology
  } as unknown as TileManager;
}
