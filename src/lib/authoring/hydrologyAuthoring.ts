import type { TileManager } from '../heightmap/tileManager';
import { r16ToElevation, type WorldConfig } from '../heightmap/worldConfig';
import type { HydrologyPointV1, HydrologySceneV1, HydrologyVectorV1, RiverSegmentV1, RiverTraceSettingsV1, RiverV1, WaterBodyV1 } from './authoringDocument';

interface Cell {
  x: number;
  y: number;
}

interface FillRegion {
  level: number;
  cells: Cell[];
  cellIds: Set<number>;
  rings: HydrologyPointV1[][];
  maxDepth: number;
  outlet: SpillOutlet | null;
}

interface SpillOutlet {
  inside: Cell;
  rim: Cell;
  dx: number;
  dy: number;
}

const DOWNHILL_ACCELERATION = 1.25;
const DOWNHILL_STEERING = 0.75;
const SLOPE_RESPONSE_R16 = 256;
const OUTLET_MOMENTUM_FRACTION = 0.6;
export const RIVER_SIMPLIFY_TOLERANCE_CELLS = 0.18;
const MAX_RIVER_SEGMENTS = 128;

export type WaterFillResult =
  | { ok: true; hydrology: HydrologySceneV1; waterBody: WaterBodyV1; created: boolean }
  | { ok: false; reason: string };

export type RiverSourceResult =
  | { ok: true; hydrology: HydrologySceneV1; river: RiverV1; createdWaterBodies: number; replaced: boolean }
  | { ok: false; reason: string };

export async function addWaterFillAtWorld(
  manager: TileManager,
  hydrology: HydrologySceneV1,
  worldX: number,
  worldZ: number
): Promise<WaterFillResult> {
  const config = manager.config;
  if (!config) return { ok: false, reason: 'Create or open a world first.' };
  const sampler = new HydrologyMapSampler(manager, config);
  const cell = worldToCell(config, worldX, worldZ);
  if (!cell) return { ok: false, reason: 'Click inside the terrain map.' };
  const region = await collectFillRegion(sampler, cell);
  if (!region) return { ok: false, reason: 'That point is not inside a calculated fill region. Bake the terrain first or choose a filled area.' };
  const existing = findBodyForRegion(hydrology, region, sampler.side);
  if (existing) return { ok: true, hydrology, waterBody: existing, created: false };
  const waterBody = createWaterBody(region, hydrology.waterBodies.length + 1);
  return {
    ok: true,
    hydrology: { ...hydrology, waterBodies: [...hydrology.waterBodies, waterBody] },
    waterBody,
    created: true
  };
}

export async function addRiverSourceAtWorld(
  manager: TileManager,
  hydrology: HydrologySceneV1,
  worldX: number,
  worldZ: number
): Promise<RiverSourceResult> {
  const config = manager.config;
  if (!config) return { ok: false, reason: 'Create or open a world first.' };
  const sampler = new HydrologyMapSampler(manager, config);
  const start = worldToCell(config, worldX, worldZ);
  if (!start) return { ok: false, reason: 'Click inside the terrain map.' };

  let scene = hydrology;
  let createdWaterBodies = 0;
  const waterBodyIds: string[] = [];
  const segments: RiverSegmentV1[] = [];
  let segmentStart = start;
  let segmentMomentum: HydrologyVectorV1 = { x: 0, z: 0 };
  let sourceWaterBody: WaterBodyV1 | undefined;
  let maxFlowStrengthR16 = 0;
  let mouth: RiverV1['mouth'] = 'stuck';

  for (let segmentIndex = 0; segmentIndex < MAX_RIVER_SEGMENTS; segmentIndex += 1) {
    const traced = await traceMomentumSegment(sampler, segmentStart, segmentMomentum, scene.riverTrace, sourceWaterBody);
    maxFlowStrengthR16 = Math.max(maxFlowStrengthR16, traced.maxFlowStrengthR16);
    if (traced.selfTerminated) break;

    if (traced.hitRegion) {
      let targetBody = findBodyForRegion(scene, traced.hitRegion, sampler.side);
      if (!targetBody) {
        targetBody = createWaterBody(traced.hitRegion, scene.waterBodies.length + 1);
        scene = { ...scene, waterBodies: [...scene.waterBodies, targetBody] };
        createdWaterBodies += 1;
      }
      if (!waterBodyIds.includes(targetBody.id)) waterBodyIds.push(targetBody.id);
      if (traced.points.length >= 2) segments.push(createRiverSegment(traced, config, sourceWaterBody?.id, targetBody.id));
      if (!traced.hitRegion.outlet) break;
      sourceWaterBody = targetBody;
      segmentStart = traced.hitRegion.outlet.rim;
      segmentMomentum = seedOutletMomentum(traced.hitRegion.outlet, scene.riverTrace.maxMomentum);
      continue;
    }

    if (traced.points.length >= 2) segments.push(createRiverSegment(traced, config, sourceWaterBody?.id));
    if (traced.termination === 'edge') mouth = 'edge';
    break;
  }

  if (segments.length === 0) return { ok: false, reason: 'The river source terminated before producing a segment.' };
  const existingRiverIndex = scene.rivers.findIndex((candidate) => {
    const firstPoint = candidate.segments[0]?.points[0];
    const source = firstPoint ? worldToCell(config, firstPoint.x, firstPoint.z) : null;
    return source?.x === start.x && source.y === start.y;
  });
  const existingRiver = existingRiverIndex >= 0 ? scene.rivers[existingRiverIndex] : undefined;
  const river: RiverV1 = {
    id: existingRiver?.id ?? crypto.randomUUID(),
    name: existingRiver?.name ?? `River ${scene.rivers.length + 1}`,
    createdAt: existingRiver?.createdAt ?? new Date().toISOString(),
    segments,
    mouth,
    waterBodyIds,
    maxFlowStrengthR16,
    widthHint: Math.max(1, 1 + maxFlowStrengthR16 / 16384)
  };
  const rivers = existingRiverIndex >= 0
    ? scene.rivers.map((candidate, index) => index === existingRiverIndex ? river : candidate)
    : [...scene.rivers, river];
  return {
    ok: true,
    hydrology: { ...scene, rivers },
    river,
    createdWaterBodies,
    replaced: existingRiverIndex >= 0
  };
}

interface MomentumTraceResult {
  points: HydrologyPointV1[];
  initialMomentum: HydrologyVectorV1;
  finalMomentum: HydrologyVectorV1;
  termination: RiverSegmentV1['termination'];
  hitRegion?: FillRegion;
  selfTerminated: boolean;
  maxFlowStrengthR16: number;
}

async function traceMomentumSegment(
  sampler: HydrologyMapSampler,
  start: Cell,
  initialMomentum: HydrologyVectorV1,
  settings: RiverTraceSettingsV1,
  sourceWaterBody?: WaterBodyV1
): Promise<MomentumTraceResult> {
  const points: HydrologyPointV1[] = [];
  const visited = new Set<number>();
  let current = start;
  let momentum = { ...initialMomentum };
  let maxFlowStrengthR16 = 0;
  let height = await sampler.height(current);
  const initialTermination = await sampleCell(current, height);
  if (initialTermination) return initialTermination;

  for (let tick = 0; tick < sampler.side * sampler.side; tick += 1) {
    const slope = await downhillSlope(sampler, current, height, momentum);
    momentum = accumulateMomentum(momentum, slope, settings.maxMomentum);
    const resultant = {
      x: momentum.x + slope.x * slope.strength * DOWNHILL_STEERING,
      z: momentum.z + slope.z * slope.strength * DOWNHILL_STEERING
    };
    const traversed = cellsAlongVector(current, resultant, sampler.side);
    if (traversed.length === 0) return traceResult('stuck');
    for (const next of traversed) {
      current = next;
      height = await sampler.height(current);
      const termination = await sampleCell(current, height);
      if (termination) return termination;
    }
  }
  return traceResult('stuck');

  async function sampleCell(cell: Cell, terrainHeight: number): Promise<MomentumTraceResult | null> {
    const id = sampler.cellId(cell);
    if (visited.has(id)) return traceResult('stuck');
    visited.add(id);
    maxFlowStrengthR16 = Math.max(maxFlowStrengthR16, await sampler.flow(cell));
    const fillLevel = await sampler.fill(cell);
    if (fillLevel > 0) {
      const region = await collectFillRegion(sampler, cell, momentum);
      if (!region) return traceResult('stuck');
      points.push(cellToWorld(sampler.config, cell, region.level));
      const selfTerminated = Boolean(sourceWaterBody && region.cellIds.has(sourceWaterBody.sourceCellY * sampler.side + sourceWaterBody.sourceCellX));
      return { ...traceResult('water-body'), hitRegion: region, selfTerminated };
    }
    points.push(cellToWorld(sampler.config, cell, terrainHeight));
    return isEdge(cell, sampler.side) ? traceResult('edge') : null;
  }

  function traceResult(termination: RiverSegmentV1['termination']): MomentumTraceResult {
    return {
      points,
      initialMomentum: { ...initialMomentum },
      finalMomentum: { ...momentum },
      termination,
      selfTerminated: false,
      maxFlowStrengthR16
    };
  }
}

interface DownhillSlope extends HydrologyVectorV1 {
  strength: number;
}

async function downhillSlope(
  sampler: HydrologyMapSampler,
  cell: Cell,
  height: number,
  forward: HydrologyVectorV1
): Promise<DownhillSlope> {
  let best: Cell | undefined;
  let bestHeight = height;
  let bestAlignment = Number.NEGATIVE_INFINITY;
  const forwardMagnitude = Math.hypot(forward.x, forward.z);
  for (const next of allNeighbors(cell, sampler.side)) {
    const nextHeight = await sampler.height(next);
    if (nextHeight >= height) continue;
    const dx = next.x - cell.x;
    const dz = next.y - cell.y;
    const distance = Math.hypot(dx, dz);
    const alignment = forwardMagnitude > 0
      ? (dx * forward.x + dz * forward.z) / (distance * forwardMagnitude)
      : 0;
    if (
      nextHeight < bestHeight ||
      (nextHeight === bestHeight && alignment > bestAlignment) ||
      (nextHeight === bestHeight && alignment === bestAlignment && sampler.cellId(next) < sampler.cellId(best ?? next))
    ) {
      best = next;
      bestHeight = nextHeight;
      bestAlignment = alignment;
    }
  }
  if (!best) return { x: 0, z: 0, strength: 0 };
  const dx = best.x - cell.x;
  const dz = best.y - cell.y;
  const distance = Math.hypot(dx, dz);
  return {
    x: dx / distance,
    z: dz / distance,
    strength: 1 - Math.exp(-((height - bestHeight) / distance) / SLOPE_RESPONSE_R16)
  };
}

function accumulateMomentum(momentum: HydrologyVectorV1, slope: DownhillSlope, maxMomentum: number): HydrologyVectorV1 {
  const currentMagnitude = Math.hypot(momentum.x, momentum.z);
  const remainingFraction = Math.max(0, 1 - currentMagnitude / Math.max(0.001, maxMomentum));
  const acceleration = DOWNHILL_ACCELERATION * slope.strength * remainingFraction;
  const next = { x: momentum.x + slope.x * acceleration, z: momentum.z + slope.z * acceleration };
  const magnitude = Math.hypot(next.x, next.z);
  if (magnitude <= maxMomentum || magnitude === 0) return next;
  const scale = maxMomentum / magnitude;
  return { x: next.x * scale, z: next.z * scale };
}

function cellsAlongVector(cell: Cell, vector: HydrologyVectorV1, side: number): Cell[] {
  const magnitude = Math.hypot(vector.x, vector.z);
  if (magnitude < 1e-6) return [];
  const distance = Math.max(1, magnitude);
  const directionX = vector.x / magnitude;
  const directionY = vector.z / magnitude;
  const steps = Math.ceil(distance);
  const cells: Cell[] = [];
  for (let step = 1; step <= steps; step += 1) {
    const travel = Math.min(distance, step);
    const next = { x: Math.round(cell.x + directionX * travel), y: Math.round(cell.y + directionY * travel) };
    if (next.x < 0 || next.y < 0 || next.x >= side || next.y >= side) break;
    const previous = cells[cells.length - 1];
    if ((!previous || previous.x !== next.x || previous.y !== next.y) && (next.x !== cell.x || next.y !== cell.y)) cells.push(next);
  }
  return cells;
}

function seedOutletMomentum(outlet: SpillOutlet, maxMomentum: number): HydrologyVectorV1 {
  const magnitude = Math.hypot(outlet.dx, outlet.dy) || 1;
  const speed = Math.min(maxMomentum, Math.max(0.1, maxMomentum * OUTLET_MOMENTUM_FRACTION));
  return { x: outlet.dx / magnitude * speed, z: outlet.dy / magnitude * speed };
}

function createRiverSegment(trace: MomentumTraceResult, config: WorldConfig, sourceWaterBodyId?: string, targetWaterBodyId?: string): RiverSegmentV1 {
  return {
    id: crypto.randomUUID(),
    sourceWaterBodyId,
    targetWaterBodyId,
    points: simplifyRiverPolyline(trace.points, RIVER_SIMPLIFY_TOLERANCE_CELLS * config.unitSize, config.worldHeight),
    initialMomentum: trace.initialMomentum,
    finalMomentum: trace.finalMomentum,
    termination: trace.termination
  };
}

export function simplifyRiverPolyline(points: HydrologyPointV1[], tolerance: number, worldHeight = 65535): HydrologyPointV1[] {
  if (points.length <= 2 || tolerance <= 0) return points.map((point) => ({ ...point }));
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  const toleranceSq = tolerance * tolerance;
  while (stack.length > 0) {
    const [start, end] = stack.pop() as [number, number];
    let split = -1;
    let maxDistanceSq = toleranceSq;
    for (let i = start + 1; i < end; i += 1) {
      const distanceSq = distanceToRiverSegmentSq(points[i], points[start], points[end], worldHeight);
      if (distanceSq <= maxDistanceSq) continue;
      maxDistanceSq = distanceSq;
      split = i;
    }
    if (split < 0) continue;
    keep[split] = 1;
    stack.push([start, split], [split, end]);
  }
  return points.filter((_, index) => keep[index] === 1).map((point) => ({ ...point }));
}

function distanceToRiverSegmentSq(point: HydrologyPointV1, start: HydrologyPointV1, end: HydrologyPointV1, worldHeight: number): number {
  const dx = end.x - start.x;
  const dy = pointElevation(end, worldHeight) - pointElevation(start, worldHeight);
  const dz = end.z - start.z;
  const lengthSq = dx * dx + dy * dy + dz * dz;
  const pointDy = pointElevation(point, worldHeight) - pointElevation(start, worldHeight);
  if (lengthSq === 0) return (point.x - start.x) ** 2 + pointDy ** 2 + (point.z - start.z) ** 2;
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + pointDy * dy + (point.z - start.z) * dz) / lengthSq));
  const closestX = start.x + dx * t;
  const closestY = pointElevation(start, worldHeight) + dy * t;
  const closestZ = start.z + dz * t;
  return (point.x - closestX) ** 2 + (pointElevation(point, worldHeight) - closestY) ** 2 + (point.z - closestZ) ** 2;
}

function pointElevation(point: HydrologyPointV1, worldHeight: number): number {
  return r16ToElevation(point.heightR16 ?? 0, worldHeight);
}

class HydrologyMapSampler {
  readonly side: number;
  private readonly heights = new Map<string, Promise<Uint16Array>>();
  private readonly fills = new Map<string, Promise<Uint16Array | null>>();
  private readonly flows = new Map<string, Promise<Uint16Array | null>>();

  constructor(private readonly manager: TileManager, readonly config: WorldConfig) {
    this.side = config.tileSize * config.tilesPerSide;
  }

  cellId(cell: Cell): number {
    return cell.y * this.side + cell.x;
  }

  cellFromId(id: number): Cell {
    return { x: id % this.side, y: Math.floor(id / this.side) };
  }

  async height(cell: Cell): Promise<number> {
    const { tile, index } = this.locate(cell);
    return (await this.cached(this.heights, tile, () => this.manager.readTile({ ...tile, d: 0 })))[index];
  }

  async fill(cell: Cell): Promise<number> {
    const { tile, index } = this.locate(cell);
    return (await this.cached(this.fills, tile, () => this.manager.readLakeFillHeightTile({ ...tile, d: 0 })))?.[index] ?? 0;
  }

  async flow(cell: Cell): Promise<number> {
    const { tile, index } = this.locate(cell);
    return (await this.cached(this.flows, tile, () => this.manager.readFlowStrengthTile({ ...tile, d: 0 })))?.[index] ?? 0;
  }

  private locate(cell: Cell): { tile: { x: number; y: number }; index: number } {
    const tileX = Math.floor(cell.x / this.config.tileSize);
    const tileY = Math.floor(cell.y / this.config.tileSize);
    const localX = cell.x - tileX * this.config.tileSize;
    const localY = cell.y - tileY * this.config.tileSize;
    return { tile: { x: tileX, y: tileY }, index: localY * this.config.tileSize + localX };
  }

  private cached<T>(cache: Map<string, Promise<T>>, tile: { x: number; y: number }, read: () => Promise<T>): Promise<T> {
    const key = `${tile.x},${tile.y}`;
    let value = cache.get(key);
    if (!value) {
      value = read();
      cache.set(key, value);
    }
    return value;
  }
}

async function collectFillRegion(sampler: HydrologyMapSampler, start: Cell, preferredDirection?: HydrologyVectorV1): Promise<FillRegion | null> {
  const level = await sampler.fill(start);
  if (level === 0) return null;
  const cells: Cell[] = [];
  const cellIds = new Set<number>([sampler.cellId(start)]);
  const queue: Cell[] = [start];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const cell = queue[cursor];
    cells.push(cell);
    for (const next of orthogonalNeighbors(cell, sampler.side)) {
      const id = sampler.cellId(next);
      if (cellIds.has(id) || await sampler.fill(next) !== level) continue;
      cellIds.add(id);
      queue.push(next);
    }
  }

  let maxDepth = 0;
  let outlet: SpillOutlet | null = null;
  let outletHeight = Number.POSITIVE_INFINITY;
  let outletAlignment = Number.NEGATIVE_INFINITY;
  const preferredMagnitude = preferredDirection ? Math.hypot(preferredDirection.x, preferredDirection.z) : 0;
  for (const cell of cells) {
    maxDepth = Math.max(maxDepth, level - await sampler.height(cell));
    for (const next of allNeighbors(cell, sampler.side)) {
      if (cellIds.has(sampler.cellId(next))) continue;
      const height = await sampler.height(next);
      const dx = next.x - cell.x;
      const dy = next.y - cell.y;
      const outwardMagnitude = Math.hypot(dx, dy) || 1;
      const alignment = preferredMagnitude > 0 && preferredDirection
        ? (dx * preferredDirection.x + dy * preferredDirection.z) / (outwardMagnitude * preferredMagnitude)
        : 0;
      if (
        height < outletHeight ||
        (height === outletHeight && alignment > outletAlignment) ||
        (height === outletHeight && alignment === outletAlignment && sampler.cellId(next) < sampler.cellId(outlet?.rim ?? next))
      ) {
        outlet = { inside: cell, rim: next, dx, dy };
        outletHeight = height;
        outletAlignment = alignment;
      }
    }
  }
  return { level, cells, cellIds, rings: buildRegionRings(sampler.config, cells, cellIds, sampler.side), maxDepth, outlet };
}


function createWaterBody(region: FillRegion, index: number): WaterBodyV1 {
  const source = region.cells[0];
  return {
    id: crypto.randomUUID(),
    name: `Water body ${index}`,
    createdAt: new Date().toISOString(),
    sourceCellX: source.x,
    sourceCellY: source.y,
    waterLevelR16: region.level,
    areaCells: region.cells.length,
    maxDepthR16: region.maxDepth,
    rings: region.rings
  };
}

function findBodyForRegion(scene: HydrologySceneV1, region: FillRegion, side: number): WaterBodyV1 | undefined {
  return scene.waterBodies.find((body) => body.sourceCellX !== undefined && body.sourceCellY !== undefined && region.cellIds.has(body.sourceCellY * side + body.sourceCellX));
}

function buildRegionRings(config: WorldConfig, cells: Cell[], ids: Set<number>, side: number): HydrologyPointV1[][] {
  type Edge = { ax: number; ay: number; bx: number; by: number };
  const edges: Edge[] = [];
  for (const cell of cells) {
    const has = (x: number, y: number) => x >= 0 && y >= 0 && x < side && y < side && ids.has(y * side + x);
    if (!has(cell.x, cell.y - 1)) edges.push({ ax: cell.x, ay: cell.y, bx: cell.x + 1, by: cell.y });
    if (!has(cell.x + 1, cell.y)) edges.push({ ax: cell.x + 1, ay: cell.y, bx: cell.x + 1, by: cell.y + 1 });
    if (!has(cell.x, cell.y + 1)) edges.push({ ax: cell.x + 1, ay: cell.y + 1, bx: cell.x, by: cell.y + 1 });
    if (!has(cell.x - 1, cell.y)) edges.push({ ax: cell.x, ay: cell.y + 1, bx: cell.x, by: cell.y });
  }
  const byStart = new Map<string, Edge[]>();
  for (const edge of edges) {
    const key = `${edge.ax},${edge.ay}`;
    byStart.set(key, [...(byStart.get(key) ?? []), edge]);
  }
  const used = new Set<Edge>();
  const rings: HydrologyPointV1[][] = [];
  for (const first of edges) {
    if (used.has(first)) continue;
    const corners: Cell[] = [{ x: first.ax, y: first.ay }];
    let edge: Edge | undefined = first;
    while (edge && !used.has(edge)) {
      used.add(edge);
      corners.push({ x: edge.bx, y: edge.by });
      if (edge.bx === first.ax && edge.by === first.ay) break;
      edge = (byStart.get(`${edge.bx},${edge.by}`) ?? []).find((candidate) => !used.has(candidate));
    }
    const last = corners[corners.length - 1];
    if (corners.length >= 4 && last.x === first.ax && last.y === first.ay) rings.push(corners.map((corner) => cornerToWorld(config, corner)));
  }
  return rings.sort((a, b) => Math.abs(ringArea(b)) - Math.abs(ringArea(a)));
}

function worldToCell(config: WorldConfig, x: number, z: number): Cell | null {
  const side = config.tileSize * config.tilesPerSide;
  const worldSize = side * config.unitSize;
  const cellX = Math.floor((x + worldSize / 2) / config.unitSize);
  const cellY = Math.floor((z + worldSize / 2) / config.unitSize);
  return cellX >= 0 && cellY >= 0 && cellX < side && cellY < side ? { x: cellX, y: cellY } : null;
}

function cellToWorld(config: WorldConfig, cell: Cell, heightR16: number): HydrologyPointV1 {
  const worldSize = config.tileSize * config.tilesPerSide * config.unitSize;
  return { x: (cell.x + 0.5) * config.unitSize - worldSize / 2, z: (cell.y + 0.5) * config.unitSize - worldSize / 2, heightR16 };
}

function cornerToWorld(config: WorldConfig, corner: Cell): HydrologyPointV1 {
  const worldSize = config.tileSize * config.tilesPerSide * config.unitSize;
  return { x: corner.x * config.unitSize - worldSize / 2, z: corner.y * config.unitSize - worldSize / 2 };
}

function orthogonalNeighbors(cell: Cell, side: number): Cell[] {
  return [{ x: cell.x, y: cell.y - 1 }, { x: cell.x + 1, y: cell.y }, { x: cell.x, y: cell.y + 1 }, { x: cell.x - 1, y: cell.y }]
    .filter((next) => next.x >= 0 && next.y >= 0 && next.x < side && next.y < side);
}

function allNeighbors(cell: Cell, side: number): Cell[] {
  const result: Cell[] = [];
  for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
    if (dx === 0 && dy === 0) continue;
    const next = { x: cell.x + dx, y: cell.y + dy };
    if (next.x >= 0 && next.y >= 0 && next.x < side && next.y < side) result.push(next);
  }
  return result;
}

function isEdge(cell: Cell, side: number): boolean {
  return cell.x === 0 || cell.y === 0 || cell.x === side - 1 || cell.y === side - 1;
}

function ringArea(ring: HydrologyPointV1[]): number {
  let area = 0;
  for (let i = 0; i < ring.length - 1; i += 1) area += ring[i].x * ring[i + 1].z - ring[i + 1].x * ring[i].z;
  return area / 2;
}
