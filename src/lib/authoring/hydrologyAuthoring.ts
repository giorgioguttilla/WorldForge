import type { TileManager } from '../heightmap/tileManager';
import { r16ToElevation, type WorldConfig } from '../heightmap/worldConfig';
import type { HydrologyPointV1, HydrologySceneV2, RiverReachV2, RiverSourceConstraintV2, WaterBodyV1 } from './authoringDocument';
import { decodeDInfinityRecipients, type HydrologyTopologyV3 } from './hydrologyBake';

interface Cell { x: number; y: number }
interface BasinRecord {
  id: number;
  fillHeight: number;
  areaCells: number;
  maxDepth: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}
interface Terminal { type: 'water-body' | 'edge' | 'stuck'; waterBodyId?: string }
interface DraftReach {
  cells: number[];
  terminal: Terminal | null;
  downstreamStartCell?: number;
}

const D8_DX = new Int8Array([0, 1, 0, 1, -1, 0, -1, 1, -1]);
const D8_DY = new Int8Array([0, 0, 1, 1, 0, -1, -1, -1, 1]);
export const RIVER_SIMPLIFY_TOLERANCE_CELLS = 0.6;
export const LAKE_RING_SIMPLIFY_TOLERANCE_CELLS = 0.75;

export type WaterFillResult =
  | { ok: true; hydrology: HydrologySceneV2; waterBody: WaterBodyV1; created: boolean }
  | { ok: false; reason: string };

export type RiverSourceResult =
  | { ok: true; hydrology: HydrologySceneV2; source: RiverSourceConstraintV2; createdWaterBodies: number; replaced: boolean }
  | { ok: false; reason: string };

export async function addWaterFillAtWorld(
  manager: TileManager,
  hydrology: HydrologySceneV2,
  worldX: number,
  worldZ: number
): Promise<WaterFillResult> {
  const setup = await createSampler(manager, worldX, worldZ);
  if (!setup.ok) return setup;
  const basinId = await setup.sampler.basin(setup.cell);
  if (basinId === 0) return { ok: false, reason: 'That point is not inside a calculated basin. Bake the terrain first or choose a filled area.' };
  const existing = hydrology.waterBodies.find((body) => body.basinId === basinId);
  if (existing) return { ok: true, hydrology, waterBody: existing, created: false };
  const waterBody = await materializeBasin(setup.sampler, basinId, hydrology.waterBodies.length + 1);
  if (!waterBody) return { ok: false, reason: 'The baked basin record is unavailable. Re-bake the terrain and try again.' };
  return {
    ok: true,
    hydrology: { ...hydrology, waterBodies: [...hydrology.waterBodies, waterBody] },
    waterBody,
    created: true
  };
}

export async function addRiverSourceAtWorld(
  manager: TileManager,
  hydrology: HydrologySceneV2,
  worldX: number,
  worldZ: number
): Promise<RiverSourceResult> {
  const setup = await createSampler(manager, worldX, worldZ);
  if (!setup.ok) return setup;
  const sourceCellId = setup.sampler.cellId(setup.cell);
  const existing = hydrology.riverSources.find((item) => setup.sampler.cellId({ x: item.sourceCellX, y: item.sourceCellY }) === sourceCellId);
  const source: RiverSourceConstraintV2 = existing
    ? { ...existing, createdAt: new Date().toISOString() }
    : {
        id: crypto.randomUUID(),
        name: `River source ${hydrology.riverSources.length + 1}`,
        createdAt: new Date().toISOString(),
        sourceCellX: setup.cell.x,
        sourceCellY: setup.cell.y,
        discharge: 1
      };
  const sources = existing
    ? hydrology.riverSources.map((item) => item.id === existing.id ? source : item)
    : [...hydrology.riverSources, source];
  const rebuilt = await rebuildRiverNetwork(setup.sampler, { ...hydrology, riverSources: sources });
  return {
    ok: true,
    hydrology: rebuilt.hydrology,
    source,
    createdWaterBodies: rebuilt.createdWaterBodies,
    replaced: Boolean(existing)
  };
}

/** Reprojects durable source constraints after a terrain bake changes the receiver graph. */
export async function rebuildRiverNetworkFromSources(manager: TileManager, hydrology: HydrologySceneV2): Promise<HydrologySceneV2> {
  const config = manager.config;
  if (!config || hydrology.riverSources.length === 0) return hydrology;
  const topology = await manager.readHydrologyTopology();
  if (!topology) return { ...hydrology, reaches: [] };
  return (await rebuildRiverNetwork(new HydrologyMapSampler(manager, config, topology), hydrology)).hydrology;
}

async function createSampler(manager: TileManager, worldX: number, worldZ: number): Promise<
  | { ok: true; sampler: HydrologyMapSampler; cell: Cell }
  | { ok: false; reason: string }
> {
  const config = manager.config;
  if (!config) return { ok: false, reason: 'Create or open a world first.' };
  const cell = worldToCell(config, worldX, worldZ);
  if (!cell) return { ok: false, reason: 'Click inside the terrain map.' };
  const topology = await manager.readHydrologyTopology();
  if (!topology) return { ok: false, reason: 'Hydrology graph data is unavailable. Bake the terrain first.' };
  return { ok: true, sampler: new HydrologyMapSampler(manager, config, topology), cell };
}

async function rebuildRiverNetwork(
  sampler: HydrologyMapSampler,
  scene: HydrologySceneV2
): Promise<{ hydrology: HydrologySceneV2; createdWaterBodies: number }> {
  const nextByCell = new Map<number, number>();
  const networkCells = new Set<number>();
  const terminals = new Map<number, Terminal>();
  const sourceCells = new Set(scene.riverSources.map((source) => sampler.cellId({ x: source.sourceCellX, y: source.sourceCellY })));
  const waterBodies = [...scene.waterBodies];
  const bodyByBasin = new Map(waterBodies.flatMap((body) => body.basinId ? [[body.basinId, body] as const] : []));
  let createdWaterBodies = 0;

  for (const source of scene.riverSources) {
    let current = sampler.cellId({ x: source.sourceCellX, y: source.sourceCellY });
    const visited = new Set<number>();
    for (let step = 0; step < sampler.side * sampler.side; step += 1) {
      if (networkCells.has(current)) break;
      networkCells.add(current);
      if (visited.has(current)) {
        terminals.set(current, { type: 'stuck' });
        break;
      }
      visited.add(current);
      const cell = sampler.cellFromId(current);
      const basinId = await sampler.basin(cell);
      if (basinId !== 0) {
        let body = bodyByBasin.get(basinId);
        if (!body) {
          body = await materializeBasin(sampler, basinId, waterBodies.length + 1) ?? undefined;
          if (body) {
            waterBodies.push(body);
            bodyByBasin.set(basinId, body);
            createdWaterBodies += 1;
          }
        }
        terminals.set(current, body ? { type: 'water-body', waterBodyId: body.id } : { type: 'stuck' });
        break;
      }
      if (sampler.isEdge(cell)) {
        terminals.set(current, { type: 'edge' });
        break;
      }
      const next = await sampler.receiver(cell);
      if (!next) {
        terminals.set(current, { type: 'stuck' });
        break;
      }
      const nextId = sampler.cellId(next);
      nextByCell.set(current, nextId);
      if (networkCells.has(nextId)) break;
      current = nextId;
    }
  }

  const indegree = new Map<number, number>();
  for (const next of nextByCell.values()) indegree.set(next, (indegree.get(next) ?? 0) + 1);
  const breakpoints = new Set<number>(sourceCells);
  for (const cell of networkCells) {
    if ((indegree.get(cell) ?? 0) !== 1 || terminals.has(cell) || !nextByCell.has(cell)) breakpoints.add(cell);
  }
  const drafts: DraftReach[] = [];
  for (const start of breakpoints) {
    const firstNext = nextByCell.get(start);
    if (firstNext === undefined) continue;
    const cells = [start];
    let current = start;
    const seen = new Set<number>([start]);
    while (true) {
      const next = nextByCell.get(current);
      if (next === undefined || seen.has(next)) break;
      cells.push(next);
      seen.add(next);
      current = next;
      if (breakpoints.has(current)) break;
    }
    const terminal = terminals.get(current) ?? null;
    drafts.push({ cells, terminal, downstreamStartCell: terminal ? undefined : current });
  }

  const idByStart = new Map<number, string>();
  for (const draft of drafts) idByStart.set(draft.cells[0], stableReachId(draft.cells));
  const reaches: RiverReachV2[] = [];
  for (const draft of drafts) {
    const densePoints = await Promise.all(draft.cells.map(async (id) => {
      const cell = sampler.cellFromId(id);
      const point = cellCenterToWorld(sampler.config, cell);
      point.heightR16 = await sampler.height(cell);
      return point;
    }));
    if (draft.terminal?.type === 'water-body') {
      const body = waterBodies.find((item) => item.id === draft.terminal?.waterBodyId);
      if (body) densePoints[densePoints.length - 1].heightR16 = body.waterLevelR16;
    }
    const flowValues = await Promise.all(draft.cells.map((id) => sampler.flow(sampler.cellFromId(id))));
    const maxFlowStrengthR16 = flowValues.reduce((max, value) => Math.max(max, value), 0);
    const downstreamReachId = draft.downstreamStartCell === undefined ? undefined : idByStart.get(draft.downstreamStartCell);
    reaches.push({
      id: idByStart.get(draft.cells[0]) as string,
      startCellId: draft.cells[0],
      endCellId: draft.cells[draft.cells.length - 1],
      points: simplifyRiverPolyline(smoothRiverLateralJitter(densePoints), RIVER_SIMPLIFY_TOLERANCE_CELLS * sampler.config.unitSize, sampler.config.worldHeight),
      downstreamReachId,
      targetWaterBodyId: draft.terminal?.waterBodyId,
      termination: downstreamReachId ? 'reach' : draft.terminal?.type ?? 'stuck',
      sourceIds: [],
      discharge: 0,
      maxFlowStrengthR16,
      widthHint: 1
    });
  }

  const reachById = new Map(reaches.map((reach) => [reach.id, reach]));
  const reachByStart = new Map(reaches.map((reach) => [reach.startCellId, reach]));
  for (const source of scene.riverSources) {
    let reach = reachByStart.get(sampler.cellId({ x: source.sourceCellX, y: source.sourceCellY }));
    const visited = new Set<string>();
    while (reach && !visited.has(reach.id)) {
      visited.add(reach.id);
      reach.discharge += source.discharge;
      reach.sourceIds.push(source.id);
      reach = reach.downstreamReachId ? reachById.get(reach.downstreamReachId) : undefined;
    }
  }
  for (const reach of reaches) {
    reach.widthHint = Math.max(1, 1 + reach.maxFlowStrengthR16 / 16384 + Math.sqrt(reach.discharge));
  }
  return { hydrology: { ...scene, waterBodies, reaches }, createdWaterBodies };
}

async function materializeBasin(sampler: HydrologyMapSampler, basinId: number, index: number): Promise<WaterBodyV1 | null> {
  const record = sampler.basinRecord(basinId);
  if (!record) return null;
  const cells = await sampler.cellsForBasin(record);
  if (cells.length === 0) return null;
  const ids = new Set(cells.map((cell) => sampler.cellId(cell)));
  return {
    id: crypto.randomUUID(),
    name: `Water body ${index}`,
    createdAt: new Date().toISOString(),
    sourceCellX: cells[0].x,
    sourceCellY: cells[0].y,
    waterLevelR16: record.fillHeight,
    areaCells: record.areaCells || cells.length,
    maxDepthR16: record.maxDepth,
    rings: buildRegionRings(sampler.config, cells, ids, sampler.side),
    basinId
  };
}

class HydrologyMapSampler {
  readonly side: number;
  private readonly heights = new Map<string, Promise<Uint16Array>>();
  private readonly basins = new Map<string, Promise<Uint32Array | null>>();
  private readonly receivers = new Map<string, Promise<Uint16Array | null>>();
  private readonly flows = new Map<string, Promise<Uint16Array | null>>();
  private readonly basinIndex = new Map<number, number>();

  constructor(private readonly manager: TileManager, readonly config: WorldConfig, private readonly topology: HydrologyTopologyV3) {
    this.side = config.tileSize * config.tilesPerSide;
    for (let index = 0; index < topology.basinIds.length; index += 1) this.basinIndex.set(topology.basinIds[index], index);
  }

  cellId(cell: Cell): number { return cell.y * this.side + cell.x; }
  cellFromId(id: number): Cell { return { x: id % this.side, y: Math.floor(id / this.side) }; }
  isEdge(cell: Cell): boolean { return cell.x === 0 || cell.y === 0 || cell.x === this.side - 1 || cell.y === this.side - 1; }

  async height(cell: Cell): Promise<number> {
    const { tile, index } = this.locate(cell);
    return (await this.cached(this.heights, tile, () => this.manager.readTile({ ...tile, d: 0 })))[index];
  }
  async basin(cell: Cell): Promise<number> {
    const { tile, index } = this.locate(cell);
    return (await this.cached(this.basins, tile, () => this.manager.readBasinIdTile({ ...tile, d: 0 })))?.[index] ?? 0;
  }
  async flow(cell: Cell): Promise<number> {
    const { tile, index } = this.locate(cell);
    return (await this.cached(this.flows, tile, () => this.manager.readFlowStrengthTile({ ...tile, d: 0 })))?.[index] ?? 0;
  }
  async receiver(cell: Cell): Promise<Cell | null> {
    const { tile, index } = this.locate(cell);
    const encoded = (await this.cached(this.receivers, tile, () => this.manager.readReceiverDirectionTile({ ...tile, d: 0 })))?.[index];
    const recipients = encoded === undefined ? null : decodeDInfinityRecipients(encoded);
    if (!recipients) return null;
    const code = recipients.weightB > recipients.weightA ? recipients.codeB : recipients.codeA;
    const next = { x: cell.x + D8_DX[code], y: cell.y + D8_DY[code] };
    return next.x >= 0 && next.y >= 0 && next.x < this.side && next.y < this.side ? next : null;
  }
  basinRecord(id: number): BasinRecord | null {
    const index = this.basinIndex.get(id);
    if (index === undefined) return null;
    return {
      id,
      fillHeight: this.topology.fillHeights[index],
      areaCells: this.topology.areaCells[index],
      maxDepth: this.topology.maxDepths[index],
      minX: this.topology.minCellX[index], minY: this.topology.minCellY[index],
      maxX: this.topology.maxCellX[index], maxY: this.topology.maxCellY[index]
    };
  }
  async cellsForBasin(record: BasinRecord): Promise<Cell[]> {
    const size = this.config.tileSize;
    const minTileX = Math.floor(record.minX / size), maxTileX = Math.floor(record.maxX / size);
    const minTileY = Math.floor(record.minY / size), maxTileY = Math.floor(record.maxY / size);
    const jobs: Array<Promise<{ x: number; y: number; values: Uint32Array | null }>> = [];
    for (let y = minTileY; y <= maxTileY; y += 1) for (let x = minTileX; x <= maxTileX; x += 1) {
      jobs.push(this.cached(this.basins, { x, y }, () => this.manager.readBasinIdTile({ x, y, d: 0 })).then((values) => ({ x, y, values })));
    }
    const cells: Cell[] = [];
    for (const tile of await Promise.all(jobs)) {
      if (!tile.values) continue;
      for (let localY = 0; localY < size; localY += 1) for (let localX = 0; localX < size; localX += 1) {
        const globalX = tile.x * size + localX, globalY = tile.y * size + localY;
        if (globalX < record.minX || globalX > record.maxX || globalY < record.minY || globalY > record.maxY) continue;
        if (tile.values[localY * size + localX] === record.id) cells.push({ x: globalX, y: globalY });
      }
    }
    return cells;
  }
  private locate(cell: Cell): { tile: { x: number; y: number }; index: number } {
    const tileX = Math.floor(cell.x / this.config.tileSize), tileY = Math.floor(cell.y / this.config.tileSize);
    const localX = cell.x - tileX * this.config.tileSize, localY = cell.y - tileY * this.config.tileSize;
    return { tile: { x: tileX, y: tileY }, index: localY * this.config.tileSize + localX };
  }
  private cached<T>(cache: Map<string, Promise<T>>, tile: { x: number; y: number }, read: () => Promise<T>): Promise<T> {
    const key = `${tile.x},${tile.y}`;
    let value = cache.get(key);
    if (!value) { value = read(); cache.set(key, value); }
    return value;
  }
}

export function simplifyRiverPolyline(points: HydrologyPointV1[], tolerance: number, worldHeight = 65535): HydrologyPointV1[] {
  if (points.length <= 2 || tolerance <= 0) return points.map((point) => ({ ...point }));
  const keep = new Uint8Array(points.length); keep[0] = 1; keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  const toleranceSq = tolerance * tolerance;
  while (stack.length > 0) {
    const [start, end] = stack.pop() as [number, number];
    let split = -1, maxDistanceSq = toleranceSq;
    for (let i = start + 1; i < end; i += 1) {
      const distanceSq = distanceToRiverSegmentSq(points[i], points[start], points[end], worldHeight);
      if (distanceSq > maxDistanceSq) { maxDistanceSq = distanceSq; split = i; }
    }
    if (split >= 0) { keep[split] = 1; stack.push([start, split], [split, end]); }
  }
  return points.filter((_, index) => keep[index] === 1).map((point) => ({ ...point }));
}

export function smoothRiverLateralJitter(points: HydrologyPointV1[]): HydrologyPointV1[] {
  if (points.length < 5) return points.map((point) => ({ ...point }));
  return points.map((point, index) => index < 2 || index > points.length - 3 ? { ...point } : {
    ...point,
    x: (points[index - 2].x + 4 * points[index - 1].x + 6 * point.x + 4 * points[index + 1].x + points[index + 2].x) / 16,
    z: (points[index - 2].z + 4 * points[index - 1].z + 6 * point.z + 4 * points[index + 1].z + points[index + 2].z) / 16
  });
}

export function simplifyLakeRing(ring: HydrologyPointV1[], tolerance: number): HydrologyPointV1[] {
  if (ring.length < 5 || tolerance <= 0) return ring.map((point) => ({ ...point }));
  const open = ring.slice(0, -1); if (open.length < 4) return ring.map((point) => ({ ...point }));
  const anchor = open[0]; let split = 1, farthest = 0;
  for (let index = 1; index < open.length; index += 1) {
    const distance = (open[index].x - anchor.x) ** 2 + (open[index].z - anchor.z) ** 2;
    if (distance > farthest) { farthest = distance; split = index; }
  }
  const first = simplifyRiverPolyline(open.slice(0, split + 1), tolerance);
  const second = simplifyRiverPolyline([...open.slice(split), anchor], tolerance);
  const simplified = [...first.slice(0, -1), ...second.slice(0, -1)];
  return simplified.length < 3 ? ring.map((point) => ({ ...point })) : [...simplified, { ...simplified[0] }];
}

function buildRegionRings(config: WorldConfig, cells: Cell[], ids: Set<number>, side: number): HydrologyPointV1[][] {
  type Edge = { ax: number; ay: number; bx: number; by: number; cellX: number; cellY: number };
  const edges: Edge[] = [];
  for (const cell of cells) {
    const has = (x: number, y: number) => x >= 0 && y >= 0 && x < side && y < side && ids.has(y * side + x);
    if (!has(cell.x, cell.y - 1)) edges.push({ ax: cell.x, ay: cell.y, bx: cell.x + 1, by: cell.y, cellX: cell.x, cellY: cell.y });
    if (!has(cell.x + 1, cell.y)) edges.push({ ax: cell.x + 1, ay: cell.y, bx: cell.x + 1, by: cell.y + 1, cellX: cell.x, cellY: cell.y });
    if (!has(cell.x, cell.y + 1)) edges.push({ ax: cell.x + 1, ay: cell.y + 1, bx: cell.x, by: cell.y + 1, cellX: cell.x, cellY: cell.y });
    if (!has(cell.x - 1, cell.y)) edges.push({ ax: cell.x, ay: cell.y + 1, bx: cell.x, by: cell.y, cellX: cell.x, cellY: cell.y });
  }
  const byStart = new Map<string, Edge[]>();
  for (const edge of edges) byStart.set(`${edge.ax},${edge.ay}`, [...(byStart.get(`${edge.ax},${edge.ay}`) ?? []), edge]);
  const used = new Set<Edge>(), rings: HydrologyPointV1[][] = [];
  for (const first of edges) {
    if (used.has(first)) continue;
    const boundaryCells: Cell[] = [], corners: Cell[] = [{ x: first.ax, y: first.ay }];
    let edge: Edge | undefined = first;
    while (edge && !used.has(edge)) {
      used.add(edge);
      const previous = boundaryCells[boundaryCells.length - 1];
      if (!previous || previous.x !== edge.cellX || previous.y !== edge.cellY) boundaryCells.push({ x: edge.cellX, y: edge.cellY });
      corners.push({ x: edge.bx, y: edge.by });
      if (edge.bx === first.ax && edge.by === first.ay) break;
      edge = (byStart.get(`${edge.bx},${edge.by}`) ?? []).find((candidate) => !used.has(candidate));
    }
    const last = corners[corners.length - 1];
    if (corners.length >= 4 && last.x === first.ax && last.y === first.ay) {
      const ring = boundaryCells.length >= 3
        ? [...boundaryCells, boundaryCells[0]].map((cell) => cellCenterToWorld(config, cell))
        : corners.map((corner) => cornerToWorld(config, corner));
      rings.push(simplifyLakeRing(ring, LAKE_RING_SIMPLIFY_TOLERANCE_CELLS * config.unitSize));
    }
  }
  return rings.sort((a, b) => Math.abs(ringArea(b)) - Math.abs(ringArea(a)));
}

function stableReachId(cells: number[]): string {
  let hash = 2166136261;
  for (const cell of cells) { hash ^= cell; hash = Math.imul(hash, 16777619); }
  return `reach-${(hash >>> 0).toString(36)}-${cells[0].toString(36)}-${cells[cells.length - 1].toString(36)}`;
}
function distanceToRiverSegmentSq(point: HydrologyPointV1, start: HydrologyPointV1, end: HydrologyPointV1, worldHeight: number): number {
  const dx = end.x - start.x, dy = pointElevation(end, worldHeight) - pointElevation(start, worldHeight), dz = end.z - start.z;
  const lengthSq = dx * dx + dy * dy + dz * dz, pointDy = pointElevation(point, worldHeight) - pointElevation(start, worldHeight);
  if (lengthSq === 0) return (point.x - start.x) ** 2 + pointDy ** 2 + (point.z - start.z) ** 2;
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + pointDy * dy + (point.z - start.z) * dz) / lengthSq));
  return (point.x - start.x - dx * t) ** 2 + (pointElevation(point, worldHeight) - pointElevation(start, worldHeight) - dy * t) ** 2 + (point.z - start.z - dz * t) ** 2;
}
function pointElevation(point: HydrologyPointV1, worldHeight: number): number { return r16ToElevation(point.heightR16 ?? 0, worldHeight); }
function worldToCell(config: WorldConfig, x: number, z: number): Cell | null {
  const side = config.tileSize * config.tilesPerSide, worldSize = side * config.unitSize;
  const cellX = Math.floor((x + worldSize / 2) / config.unitSize), cellY = Math.floor((z + worldSize / 2) / config.unitSize);
  return cellX >= 0 && cellY >= 0 && cellX < side && cellY < side ? { x: cellX, y: cellY } : null;
}
function cellCenterToWorld(config: WorldConfig, cell: Cell): HydrologyPointV1 {
  const worldSize = config.tileSize * config.tilesPerSide * config.unitSize;
  return { x: (cell.x + 0.5) * config.unitSize - worldSize / 2, z: (cell.y + 0.5) * config.unitSize - worldSize / 2 };
}
function cornerToWorld(config: WorldConfig, corner: Cell): HydrologyPointV1 {
  const worldSize = config.tileSize * config.tilesPerSide * config.unitSize;
  return { x: corner.x * config.unitSize - worldSize / 2, z: corner.y * config.unitSize - worldSize / 2 };
}
function ringArea(ring: HydrologyPointV1[]): number {
  let area = 0; for (let i = 0; i < ring.length - 1; i += 1) area += ring[i].x * ring[i + 1].z - ring[i + 1].x * ring[i].z; return area / 2;
}
