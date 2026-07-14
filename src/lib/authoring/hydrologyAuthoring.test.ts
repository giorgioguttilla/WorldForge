import { describe, expect, it } from 'vitest';
import type { TileManager } from '../heightmap/tileManager';
import type { WorldConfig } from '../heightmap/worldConfig';
import type { HydrologySceneV1 } from './authoringDocument';
import { LAKE_RING_SIMPLIFY_TOLERANCE_CELLS, RIVER_SIMPLIFY_TOLERANCE_CELLS, addRiverSourceAtWorld, addWaterFillAtWorld, simplifyLakeRing, simplifyRiverPolyline, smoothRiverLateralJitter } from './hydrologyAuthoring';

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
    expect(first.waterBody.rings[0].every((point) => Number.isInteger(point.x) && Number.isInteger(point.z))).toBe(true);

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
    expect(result.river.segments[0].points.at(-1)).toMatchObject({ heightR16: 7 });
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

  it('checks every cell along a momentum-driven segment for narrow water bodies', async () => {
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
    expect(result.river.segments[1].points.at(-1)).toMatchObject({ x: 2.5, z: 0, heightR16: 10 });
  });

  it('lets a strong lateral downhill slope turn momentum that is already near its speed cap', async () => {
    const side = 11;
    const heights = new Array(side * side).fill(20000);
    for (let x = 1; x < side; x += 1) heights[5 * side + x] = 11000 - x * 1000;
    for (let x = 6; x < side - 1; x += 1) heights[4 * side + x] = 0;

    const result = await addRiverSourceAtWorld(
      mockManager(heights, new Array(side * side).fill(0), new Array(side * side).fill(0)),
      EMPTY,
      -4,
      0
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const points = result.river.segments.flatMap((segment) => segment.points);
    expect(points.some((point) => point.z < 0)).toBe(true);
    const directions = points.slice(1).map((point, index) => {
      const previous = points[index];
      const dx = point.x - previous.x;
      const dz = point.z - previous.z;
      const magnitude = Math.hypot(dx, dz);
      return magnitude > 0 ? { x: dx / magnitude, z: dz / magnitude } : { x: 0, z: 0 };
    });
    const turns = directions.slice(1, -1).map((direction, index) => {
      const previous = directions[index];
      return Math.acos(Math.max(-1, Math.min(1, previous.x * direction.x + previous.z * direction.z)));
    });
    expect(Math.max(...turns)).toBeLessThanOrEqual(Math.PI / 18 + 1e-6);
  });

  it('terminates a recursive child safely when it cannot escape the outlet terrain', async () => {
    const side = 21;
    const center = 10 * side + 10;
    const heights = new Array(side * side).fill(20000);
    heights[center] = 0;
    heights[center + 1] = 10000;
    const fill = new Array(side * side).fill(0);
    fill[center] = 10000;
    const lowMomentumScene: HydrologySceneV1 = { ...EMPTY, riverTrace: { maxMomentum: 0.5 } };

    const result = await addRiverSourceAtWorld(mockManager(heights, fill, new Array(side * side).fill(0)), lowMomentumScene, -1, 0);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.river.segments).toHaveLength(2);
    expect(result.river.segments[0].termination).toBe('water-body');
    expect(result.river.segments[1].termination).toBe('stuck');
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

    const shallowSquiggle = Array.from({ length: 41 }, (_, x) => ({
      x,
      z: x === 0 || x === 40 ? 0 : (x % 2 === 0 ? -0.35 : 0.35),
      heightR16: 40000 - x * 100
    }));
    const simplifiedSquiggle = simplifyRiverPolyline(shallowSquiggle, RIVER_SIMPLIFY_TOLERANCE_CELLS);
    expect(simplifiedSquiggle).toEqual([shallowSquiggle[0], shallowSquiggle.at(-1)]);

    const verticalBend = [
      { x: 0, z: 0, heightR16: 0 },
      { x: 1, z: 0, heightR16: 65535 },
      { x: 2, z: 0, heightR16: 0 }
    ];
    expect(simplifyRiverPolyline(verticalBend, RIVER_SIMPLIFY_TOLERANCE_CELLS, 100)).toHaveLength(3);
  });

  it('filters lateral raster oscillation without moving endpoints or changing terrain heights', () => {
    const points = Array.from({ length: 9 }, (_, x) => ({
      x,
      z: x % 2 === 0 ? -1 : 1,
      heightR16: 30000 - x * 100
    }));
    const filtered = smoothRiverLateralJitter(points);

    expect(filtered[0]).toEqual(points[0]);
    expect(filtered.at(-1)).toEqual(points.at(-1));
    expect(filtered.map((point) => point.heightR16)).toEqual(points.map((point) => point.heightR16));
    expect(filtered[4].z).toBe(0);
    expect(filtered[4].x).toBe(points[4].x);
  });

  it('approximates closed lake stair steps with diagonal polygon edges', () => {
    const stairStepRing = [
      { x: 0, z: 0 }, { x: 1, z: 0 }, { x: 1, z: 1 },
      { x: 2, z: 1 }, { x: 2, z: 2 }, { x: 3, z: 2 },
      { x: 3, z: 3 }, { x: 0, z: 3 }, { x: 0, z: 0 }
    ];

    const simplified = simplifyLakeRing(stairStepRing, LAKE_RING_SIMPLIFY_TOLERANCE_CELLS);

    expect(simplified[0]).toEqual(simplified.at(-1));
    expect(simplified.length).toBeLessThan(stairStepRing.length);
    expect(simplified.slice(1).some((point, index) => {
      const previous = simplified[index];
      return point.x !== previous.x && point.z !== previous.z;
    })).toBe(true);
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
