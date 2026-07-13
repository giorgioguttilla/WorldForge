import { describe, expect, it } from 'vitest';
import type { TileManager } from '../heightmap/tileManager';
import type { WorldConfig } from '../heightmap/worldConfig';
import type { HydrologySceneV1 } from './authoringDocument';
import { RIVER_SIMPLIFY_TOLERANCE_CELLS, addRiverSourceAtWorld, addWaterFillAtWorld, simplifyRiverPolyline } from './hydrologyAuthoring';

const EMPTY: HydrologySceneV1 = { version: 1, riverTrace: { maxMomentum: 6 }, waterBodies: [], rivers: [] };

describe('authored hydrology tools', () => {
  it('materializes only the connected clicked fill region and avoids duplicates', async () => {
    const fill = [
      0, 0, 0, 0, 0,
      0, 10, 0, 12, 0,
      0, 10, 10, 12, 0,
      0, 0, 0, 0, 0,
      0, 0, 0, 0, 0
    ];
    const manager = mockManager(new Array(25).fill(2), fill, new Array(25).fill(0));
    const first = await addWaterFillAtWorld(manager, EMPTY, -1, -1);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.created).toBe(true);
    expect(first.waterBody).toMatchObject({ areaCells: 3, waterLevelR16: 10, maxDepthR16: 8 });
    expect(first.waterBody.rings[0][0]).toEqual(first.waterBody.rings[0].at(-1));

    const second = await addWaterFillAtWorld(manager, first.hydrology, 0, 0);
    expect(second.ok && second.created).toBe(false);
    if (second.ok) expect(second.hydrology.waterBodies).toHaveLength(1);
  });

  it('routes downhill, creates a lake on contact, and resumes from its lowest rim', async () => {
    const heights = [
      9, 9, 9, 9, 9,
      9, 8, 2, 7, 6,
      9, 8, 2, 3, 4,
      9, 8, 7, 2, 1,
      9, 8, 7, 6, 0
    ];
    const fill = [
      0, 0, 0, 0, 0,
      0, 0, 7, 0, 0,
      0, 0, 7, 0, 0,
      0, 0, 0, 0, 0,
      0, 0, 0, 0, 0
    ];
    const flow = heights.map((_, index) => index * 1000);
    const result = await addRiverSourceAtWorld(mockManager(heights, fill, flow), EMPTY, -1, -1);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.createdWaterBodies).toBe(1);
    expect(result.hydrology.waterBodies).toHaveLength(1);
    expect(result.river.waterBodyIds).toEqual([result.hydrology.waterBodies[0].id]);
    expect(result.river.mouth).toBe('edge');
    expect(result.river.segments).toHaveLength(2);
    expect(result.river.segments[0]).toMatchObject({ termination: 'water-body', targetWaterBodyId: result.hydrology.waterBodies[0].id });
    expect(result.river.segments[0].points.at(-1)).toMatchObject({ x: 0, heightR16: 7 });
    expect(result.river.segments[1]).toMatchObject({ termination: 'edge', sourceWaterBodyId: result.hydrology.waterBodies[0].id });
    expect(Math.hypot(result.river.segments[1].initialMomentum.x, result.river.segments[1].initialMomentum.z)).toBeGreaterThan(0);
    expect(result.river.segments[1].points.at(-1)).toMatchObject({ x: 2, z: 2, heightR16: 0 });
    for (const segment of result.river.segments) expect(Math.hypot(segment.finalMomentum.x, segment.finalMomentum.z)).toBeLessThanOrEqual(EMPTY.riverTrace.maxMomentum + 1e-9);
    expect(Math.hypot(result.river.segments[0].finalMomentum.x, result.river.segments[0].finalMomentum.z)).toBeGreaterThan(0);

    const rerouted = await addRiverSourceAtWorld(mockManager(heights, fill, flow), result.hydrology, -1, -1);
    expect(rerouted.ok && rerouted.replaced).toBe(true);
    if (rerouted.ok) {
      expect(rerouted.hydrology.rivers).toHaveLength(1);
      expect(rerouted.river.id).toBe(result.river.id);
    }
  });

  it('carries outward spill momentum across an equal-height lake rim', async () => {
    const heights = [
      10, 10, 10, 10, 10,
      10, 10, 10, 10, 10,
      10, 10, 2, 10, 10,
      10, 10, 10, 10, 10,
      10, 10, 10, 10, 10
    ];
    const fill = new Array(25).fill(0);
    fill[12] = 10;
    const flow = new Array(25).fill(0);
    flow[6] = 65535;

    const result = await addRiverSourceAtWorld(mockManager(heights, fill, flow), EMPTY, 0, -1);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.river.mouth).toBe('edge');
    const points = result.river.segments.flatMap((segment) => segment.points);
    expect(points.some((point) => point.x === 0 && point.z === 2)).toBe(true);
    expect(result.river.segments.at(-1)?.points.at(-1)).toMatchObject({ x: 0, z: 2 });
  });

  it('does not use flow strength to choose the route or equal-height outlet', async () => {
    const heights = [
      10, 10, 10, 10, 10,
      10, 10, 10, 10, 10,
      10, 10, 2, 10, 10,
      10, 10, 10, 10, 10,
      10, 10, 10, 10, 10
    ];
    const fill = new Array(25).fill(0);
    fill[12] = 10;
    const noFlow = new Array(25).fill(0);
    const highFlow = new Array(25).fill(65535);

    const first = await addRiverSourceAtWorld(mockManager(heights, fill, noFlow), EMPTY, 0, -1);
    const second = await addRiverSourceAtWorld(mockManager(heights, fill, highFlow), EMPTY, 0, -1);

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.river.segments.map((segment) => segment.points)).toEqual(first.river.segments.map((segment) => segment.points));
    expect(second.river.segments.map((segment) => segment.termination)).toEqual(first.river.segments.map((segment) => segment.termination));
    expect(second.river.widthHint).not.toBe(first.river.widthHint);
  });

  it('uses outlet momentum to carry a child segment over a discrete rim rise', async () => {
    const heights = [
      20, 20, 20, 20, 20,
      20, 20, 20, 20, 20,
      20, 20, 2, 10, 15,
      20, 20, 20, 20, 20,
      20, 20, 20, 20, 20
    ];
    const fill = new Array(25).fill(0);
    fill[12] = 10;
    const flow = new Array(25).fill(0);
    flow[13] = 65535;

    const result = await addRiverSourceAtWorld(mockManager(heights, fill, flow), EMPTY, -1, 0);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.river.mouth).toBe('edge');
    expect(result.river.segments.at(-1)?.points.at(-1)).toMatchObject({ x: 2, z: 0, heightR16: 15 });
  });

  it('recursively terminates and restarts segments across multiple water bodies', async () => {
    const heights = new Array(49).fill(20);
    heights.splice(21, 7, 20, 15, 0, 10, 0, 10, 9);
    const fill = new Array(49).fill(0);
    fill[23] = 10;
    fill[25] = 10;
    const flow = new Array(49).fill(0);
    flow[24] = 50000;
    flow[26] = 60000;

    const result = await addRiverSourceAtWorld(mockManager(heights, fill, flow), EMPTY, -2, 0);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hydrology.waterBodies).toHaveLength(2);
    expect(result.river.segments).toHaveLength(3);
    expect(result.river.segments.map((segment) => segment.termination)).toEqual(['water-body', 'water-body', 'edge']);
    expect(result.river.segments[1].sourceWaterBodyId).toBe(result.river.segments[0].targetWaterBodyId);
    expect(result.river.segments[2].sourceWaterBodyId).toBe(result.river.segments[1].targetWaterBodyId);
  });

  it('checks every crossed cell when momentum carries a segment multiple cells per tick', async () => {
    const heights = new Array(81).fill(10);
    heights[40] = 2;
    heights[43] = 2;
    const fill = new Array(81).fill(0);
    fill[40] = 10;
    fill[43] = 10;

    const result = await addRiverSourceAtWorld(mockManager(heights, fill, new Array(81).fill(0)), EMPTY, -1, 0);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hydrology.waterBodies).toHaveLength(2);
    expect(result.river.segments.map((segment) => segment.termination)).toEqual(['water-body', 'water-body']);
    expect(result.river.mouth).toBe('edge');
    expect(result.river.segments[1].points.at(-1)).toMatchObject({ x: 3, z: 0, heightR16: 10 });
  });

  it('discards a child segment that immediately returns to its spawning water body', async () => {
    const heights = new Array(25).fill(20000);
    heights[12] = 0;
    heights[13] = 10000;
    const fill = new Array(25).fill(0);
    fill[12] = 10000;
    const lowMomentumScene: HydrologySceneV1 = { ...EMPTY, riverTrace: { maxMomentum: 0.5 } };

    const result = await addRiverSourceAtWorld(mockManager(heights, fill, new Array(25).fill(0)), lowMomentumScene, -1, 0);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.river.segments).toHaveLength(1);
    expect(result.river.segments[0].termination).toBe('water-body');
    expect(result.river.mouth).toBe('stuck');
  });

  it('does not create water outside a fill region', async () => {
    const result = await addWaterFillAtWorld(mockManager(new Array(25).fill(1), new Array(25).fill(0), new Array(25).fill(0)), EMPTY, 0, 0);
    expect(result).toMatchObject({ ok: false });
  });

  it('simplifies generated river polylines while preserving exact endpoints and meaningful bends', () => {
    const straight = Array.from({ length: 101 }, (_, x) => ({ x, z: 0, heightR16: 100 - x }));
    const simplifiedStraight = simplifyRiverPolyline(straight, RIVER_SIMPLIFY_TOLERANCE_CELLS);
    expect(simplifiedStraight).toEqual([straight[0], straight.at(-1)]);

    const bent = [
      { x: 0, z: 0 },
      { x: 1, z: 0 },
      { x: 2, z: 0 },
      { x: 3, z: 1 },
      { x: 4, z: 2 }
    ];
    const simplifiedBent = simplifyRiverPolyline(bent, RIVER_SIMPLIFY_TOLERANCE_CELLS);
    expect(simplifiedBent[0]).toEqual(bent[0]);
    expect(simplifiedBent.at(-1)).toEqual(bent.at(-1));
    expect(simplifiedBent).toContainEqual({ x: 2, z: 0 });
    expect(simplifiedBent.length).toBeLessThan(bent.length);

    const verticalBend = [
      { x: 0, z: 0, heightR16: 0 },
      { x: 1, z: 0, heightR16: 65535 },
      { x: 2, z: 0, heightR16: 0 }
    ];
    expect(simplifyRiverPolyline(verticalBend, RIVER_SIMPLIFY_TOLERANCE_CELLS, 100)).toHaveLength(3);
  });
});

function mockManager(heights: number[], fills: number[], flows: number[]): TileManager {
  const tileSize = Math.sqrt(heights.length);
  if (!Number.isInteger(tileSize) || fills.length !== heights.length || flows.length !== heights.length) throw new Error('Mock maps must be equal-sized squares.');
  const config: WorldConfig = {
    id: 'world',
    name: 'World',
    tileSize,
    tilesPerSide: 1,
    unitSize: 1,
    unit: 'meter',
    worldHeight: 65535,
    water: { visible: false, level: 0 },
    createdAt: 'now',
    updatedAt: 'now',
    version: 1
  };
  return {
    config,
    async readTile() { return Uint16Array.from(heights); },
    async readLakeFillHeightTile() { return Uint16Array.from(fills); },
    async readFlowStrengthTile() { return Uint16Array.from(flows); }
  } as unknown as TileManager;
}
