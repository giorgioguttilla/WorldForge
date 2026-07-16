import type { TileManager } from '../heightmap/tileManager';
import { r16ToElevation, type WorldConfig } from '../heightmap/worldConfig';
import type { HydrologyPointV1, HydrologySceneV2, RiverBasinNodeV2, RiverReachV2, RiverSourceConstraintV2, WaterBodyV1 } from './authoringDocument';
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
  spillCellId?: number;
  downstreamCellId?: number;
  downstreamBasinId?: number;
}
interface Terminal { type: 'water-body' | 'edge' | 'stuck'; waterBodyId?: string; basinId?: number }
interface DraftReach {
  cells: number[];
  terminal: Terminal | null;
  downstreamStartCell?: number;
}

const CELL_ID_CHUNK_SIZE = 262144;

/**
 * Sparse, tile-backed cell membership. A world-sized bitmap is still enormous
 * for large projects, so allocate bits only for tiles touched by the network.
 */
class TiledCellSet implements Iterable<number> {
  private readonly membership = new Map<number, Uint8Array>();
  private readonly chunks: Array<{ values: Uint32Array; length: number }> = [];
  size = 0;

  constructor(private readonly side: number, private readonly tileSize: number, private readonly trackEntries = true) {}

  has(cellId: number): boolean {
    const location = this.locate(cellId);
    const bits = this.membership.get(location.tileId);
    return bits ? (bits[location.localId >>> 3] & (1 << (location.localId & 7))) !== 0 : false;
  }

  add(cellId: number): boolean {
    const location = this.locate(cellId);
    let bits = this.membership.get(location.tileId);
    if (!bits) {
      bits = new Uint8Array(Math.ceil(this.tileSize * this.tileSize / 8));
      this.membership.set(location.tileId, bits);
    }
    const byte = location.localId >>> 3;
    const bit = 1 << (location.localId & 7);
    if ((bits[byte] & bit) !== 0) return false;
    bits[byte] |= bit;
    this.size += 1;
    if (!this.trackEntries) return true;
    let chunk = this.chunks[this.chunks.length - 1];
    if (!chunk || chunk.length === chunk.values.length) {
      chunk = { values: new Uint32Array(CELL_ID_CHUNK_SIZE), length: 0 };
      this.chunks.push(chunk);
    }
    chunk.values[chunk.length] = cellId;
    chunk.length += 1;
    return true;
  }

  *[Symbol.iterator](): Iterator<number> {
    for (const chunk of this.chunks) for (let index = 0; index < chunk.length; index += 1) yield chunk.values[index];
  }

  private locate(cellId: number): { tileId: number; localId: number } {
    const x = cellId % this.side;
    const y = Math.floor(cellId / this.side);
    const tileX = Math.floor(x / this.tileSize);
    const tileY = Math.floor(y / this.tileSize);
    return {
      tileId: tileY * Math.ceil(this.side / this.tileSize) + tileX,
      localId: (y - tileY * this.tileSize) * this.tileSize + x - tileX * this.tileSize
    };
  }
}

const D8_DX = new Int8Array([0, 1, 0, 1, -1, 0, -1, 1, -1]);
const D8_DY = new Int8Array([0, 0, 1, 1, 0, -1, -1, -1, 1]);
const NO_FLOW_TARGET = 0xffffffff;
export const RIVER_SIMPLIFY_TOLERANCE_CELLS = 0.6;
export const LAKE_RING_SIMPLIFY_TOLERANCE_CELLS = 0.75;
const AUTOMATIC_TRIBUTARY_MIN_CELLS = 6;

export type WaterFillResult =
  | { ok: true; hydrology: HydrologySceneV2; waterBody: WaterBodyV1; created: boolean }
  | { ok: false; reason: string };

export type RiverSourceResult =
  | { ok: true; hydrology: HydrologySceneV2; source: RiverSourceConstraintV2; createdWaterBodies: number; replaced: boolean; basinDiagnostics: BasinRoutingDiagnostics; channelDiagnostics: ChannelExtractionDiagnostics }
  | { ok: false; reason: string };

export interface BasinRoutingDiagnostics {
  total: number;
  continuous: number;
  terminal: number;
}

export interface ChannelExtractionDiagnostics {
  threshold: number;
  automaticCells: number;
  automaticSources: number;
  confluences: number;
  reaches: number;
}

interface BasinWaterBalanceDecision {
  status: 'continuous' | 'terminal';
  outflowFraction: number;
  reason: 'uniform-pass-through' | 'no-baked-outlet';
}

/**
 * Future climate seam: replace this uniform policy with a solver that consumes
 * discharge, evaporation/infiltration, and a basin hypsometric curve. The graph
 * traversal and basin-node discharge propagation do not need to change.
 */
function evaluateBasinWaterBalance(record: BasinRecord): BasinWaterBalanceDecision {
  const hasOutlet = record.spillCellId !== undefined && record.downstreamCellId !== undefined;
  return hasOutlet
    ? { status: 'continuous', outflowFraction: 1, reason: 'uniform-pass-through' }
    : { status: 'terminal', outflowFraction: 0, reason: 'no-baked-outlet' };
}

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
    replaced: Boolean(existing),
    basinDiagnostics: rebuilt.basinDiagnostics,
    channelDiagnostics: rebuilt.channelDiagnostics
  };
}

/** Reprojects durable source constraints after a terrain bake changes the receiver graph. */
export async function rebuildRiverNetworkFromSources(manager: TileManager, hydrology: HydrologySceneV2): Promise<HydrologySceneV2> {
  const config = manager.config;
  if (!config) return hydrology;
  const topology = await manager.readHydrologyTopology();
  if (!topology) return { ...hydrology, reaches: [], basinNodes: [] };
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
): Promise<{ hydrology: HydrologySceneV2; createdWaterBodies: number; basinDiagnostics: BasinRoutingDiagnostics; channelDiagnostics: ChannelExtractionDiagnostics }> {
  const cellCount = sampler.side * sampler.side;
  const tileSize = sampler.config.tileSize;
  const terminals = new Map<number, Terminal>();
  const sourceCells = new Set(scene.riverSources.map((source) => sampler.cellId({ x: source.sourceCellX, y: source.sourceCellY })));
  const basinOutletCells = new Set<number>();
  const outletBasinByCell = new Map<number, number>();
  const waterBodies = [...scene.waterBodies];
  const bodyByBasin = new Map(waterBodies.flatMap((body) => body.basinId ? [[body.basinId, body] as const] : []));
  const basinDecisions = new Map<number, BasinWaterBalanceDecision>();
  let createdWaterBodies = 0;
  type ForcedTrace = { startCellId: number; visitedBasins: ReadonlySet<number> };
  const forcedTraces: ForcedTrace[] = scene.riverSources.map((source) => ({
    startCellId: sampler.cellId({ x: source.sourceCellX, y: source.sourceCellY }),
    visitedBasins: new Set<number>()
  }));
  const queuedBasinOutlets = new Set<number>();
  const forcedCells = new TiledCellSet(sampler.side, tileSize);
  const forcedBreakpoints = new TiledCellSet(sampler.side, tileSize);
  const nextByForcedCell = new Map<number, number>();
  for (const source of sourceCells) forcedBreakpoints.add(source);

  const enterBasin = async (inletCellId: number, basinId: number, visitedBasins: ReadonlySet<number>): Promise<void> => {
    let body = bodyByBasin.get(basinId);
    if (!body) {
      body = await materializeBasin(sampler, basinId, waterBodies.length + 1) ?? undefined;
      if (body) {
        waterBodies.push(body);
        bodyByBasin.set(basinId, body);
        createdWaterBodies += 1;
      }
    }
    if (!body) {
      terminals.set(inletCellId, { type: 'stuck' });
      return;
    }
    terminals.set(inletCellId, { type: 'water-body', waterBodyId: body.id, basinId });
    const record = sampler.basinRecord(basinId);
    if (!record) return;
    const decision = basinDecisions.get(basinId) ?? evaluateBasinWaterBalance(record);
    basinDecisions.set(basinId, decision);
    if (decision.status === 'terminal') return;
    if (visitedBasins.has(basinId)) {
      console.warn('[WorldForge hydrology] Basin outlet cycle detected; terminating this route.', { basinId });
      basinDecisions.set(basinId, { status: 'terminal', outflowFraction: 0, reason: 'no-baked-outlet' });
      return;
    }
    if (queuedBasinOutlets.has(basinId)) return;
    const downstream = record.downstreamCellId as number;
    const downstreamCell = sampler.cellFromId(downstream);
    if (!sampler.contains(downstreamCell) || await sampler.basin(downstreamCell) === basinId) {
      console.warn('[WorldForge hydrology] Invalid baked basin outlet; terminating this route.', { basinId, downstreamCellId: downstream });
      basinDecisions.set(basinId, { status: 'terminal', outflowFraction: 0, reason: 'no-baked-outlet' });
      return;
    }
    queuedBasinOutlets.add(basinId);
    basinOutletCells.add(downstream);
    forcedBreakpoints.add(downstream);
    outletBasinByCell.set(downstream, basinId);
    forcedTraces.push({ startCellId: downstream, visitedBasins: new Set([...visitedBasins, basinId]) });
  };

  const traceForcedDownstream = async (startCellId: number, visitedBasins: ReadonlySet<number>): Promise<void> => {
    if (forcedCells.has(startCellId)) {
      forcedBreakpoints.add(startCellId);
      return;
    }
    let current = startCellId;
    const visited = new Set<number>();
    for (let step = 0; step < cellCount; step += 1) {
      if (visited.has(current)) {
        terminals.set(current, { type: 'stuck' });
        forcedBreakpoints.add(current);
        return;
      }
      forcedCells.add(current);
      visited.add(current);
      const cell = sampler.cellFromId(current);
      const basinId = await sampler.basin(cell);
      if (basinId !== 0) {
        forcedBreakpoints.add(current);
        await enterBasin(current, basinId, visitedBasins);
        return;
      }
      if (sampler.isEdge(cell)) {
        terminals.set(current, { type: 'edge' });
        forcedBreakpoints.add(current);
        return;
      }
      const next = await sampler.receiver(cell);
      if (!next) {
        terminals.set(current, { type: 'stuck' });
        forcedBreakpoints.add(current);
        return;
      }
      const nextId = sampler.cellId(next);
      if (visited.has(nextId)) {
        terminals.set(current, { type: 'stuck' });
        forcedBreakpoints.add(current);
        return;
      }
      nextByForcedCell.set(current, nextId);
      if (forcedCells.has(nextId)) {
        forcedBreakpoints.add(nextId);
        return;
      }
      current = nextId;
    }
    terminals.set(current, { type: 'stuck' });
    forcedBreakpoints.add(current);
  };

  // First reconstruct the authored trunks and their recursive basin exits using
  // the baked downstream graph, exactly as Phase 3 did.
  for (let traceIndex = 0; traceIndex < forcedTraces.length; traceIndex += 1) {
    const trace = forcedTraces[traceIndex];
    await traceForcedDownstream(trace.startCellId, trace.visitedBasins);
  }

  for (const cell of basinOutletCells) forcedBreakpoints.add(cell);

  // Grow only threshold-qualified D-infinity branches whose vectors feed an
  // existing trunk/branch. Newly accepted cells become targets in turn, so the
  // search walks upstream without ever scanning unrelated parts of the world.
  const tributaryCells = new TiledCellSet(sampler.side, tileSize);
  const upstreamStack = [...forcedCells];
  while (upstreamStack.length > 0) {
    const targetId = upstreamStack.pop() as number;
    const target = sampler.cellFromId(targetId);
    if (!sampler.hasLoadedUpstreamNeighborhood(target)) await sampler.loadUpstreamNeighborhood(target);
    for (const upstream of sampler.upstreamChannelNeighborsLoaded(target, scene.channelThreshold)) {
      const upstreamId = sampler.cellId(upstream);
      if (forcedCells.has(upstreamId)) continue;
      forcedCells.add(upstreamId);
      tributaryCells.add(upstreamId);
      nextByForcedCell.set(upstreamId, targetId);
      upstreamStack.push(upstreamId);
    }
  }
  sampler.clearLoadedUpstreamTiles();

  const unprunedIndegree = new Map<number, number>();
  for (const next of nextByForcedCell.values()) if (forcedCells.has(next)) unprunedIndegree.set(next, (unprunedIndegree.get(next) ?? 0) + 1);
  const prunedTributaryCells = new TiledCellSet(sampler.side, tileSize, false);
  const minimumTributaryCells = Math.min(AUTOMATIC_TRIBUTARY_MIN_CELLS, Math.max(1, Math.floor(sampler.side / 64)));
  for (const headwater of tributaryCells) {
    if ((unprunedIndegree.get(headwater) ?? 0) !== 0 || prunedTributaryCells.has(headwater)) continue;
    const twig: number[] = [];
    let current = headwater;
    while (twig.length < minimumTributaryCells && tributaryCells.has(current) && !prunedTributaryCells.has(current)) {
      twig.push(current);
      const next = nextByForcedCell.get(current);
      if (next === undefined || !tributaryCells.has(next) || (unprunedIndegree.get(next) ?? 0) > 1) break;
      current = next;
    }
    if (twig.length < minimumTributaryCells) for (const cell of twig) prunedTributaryCells.add(cell);
  }

  const isActiveCell = (cellId: number): boolean => forcedCells.has(cellId) && !prunedTributaryCells.has(cellId);
  const forcedIndegree = new Map<number, number>();
  for (const [cell, next] of nextByForcedCell) if (isActiveCell(cell) && isActiveCell(next)) {
    forcedIndegree.set(next, (forcedIndegree.get(next) ?? 0) + 1);
  }
  for (const cell of forcedCells) {
    if (!isActiveCell(cell)) continue;
    if ((forcedIndegree.get(cell) ?? 0) !== 1 || terminals.has(cell) || !nextByForcedCell.has(cell)) forcedBreakpoints.add(cell);
  }

  const drafts: DraftReach[] = [];
  for (const start of forcedBreakpoints) {
    const firstNext = nextByForcedCell.get(start);
    if (firstNext === undefined) continue;
    const cells = [start];
    let current = start;
    for (let step = 0; step < cellCount; step += 1) {
      const next = nextByForcedCell.get(current);
      if (next === undefined || !isActiveCell(next)) break;
      cells.push(next);
      current = next;
      if (forcedBreakpoints.has(current)) break;
    }
    const terminal = terminals.get(current) ?? null;
    drafts.push({ cells, terminal, downstreamStartCell: terminal ? undefined : current });
  }

  const idByStart = new Map<number, string>();
  for (const draft of drafts) idByStart.set(draft.cells[0], stableReachId(draft.cells));
  const reaches: RiverReachV2[] = [];
  for (const draft of drafts) {
    const { points: densePoints, exactDischarge } = await sampler.sampleReach(draft.cells);
    const outletBasinId = outletBasinByCell.get(draft.cells[0]);
    if (outletBasinId !== undefined) {
      const outletRecord = sampler.basinRecord(outletBasinId);
      const outletBody = bodyByBasin.get(outletBasinId);
      if (outletRecord?.spillCellId !== undefined && outletBody) {
        densePoints.unshift({
          ...cellCenterToWorld(sampler.config, sampler.cellFromId(outletRecord.spillCellId)),
          heightR16: outletBody.waterLevelR16
        });
      }
    }
    if (draft.terminal?.type === 'water-body') {
      const body = waterBodies.find((item) => item.id === draft.terminal?.waterBodyId);
      if (body) densePoints[densePoints.length - 1].heightR16 = body.waterLevelR16;
    }
    const downstreamReachId = draft.downstreamStartCell === undefined ? undefined : idByStart.get(draft.downstreamStartCell);
    reaches.push({
      id: idByStart.get(draft.cells[0]) as string,
      startCellId: draft.cells[0],
      endCellId: draft.cells[draft.cells.length - 1],
      points: simplifyRiverPolyline(smoothRiverLateralJitter(densePoints), RIVER_SIMPLIFY_TOLERANCE_CELLS * sampler.config.unitSize, sampler.config.worldHeight),
      downstreamReachId,
      targetWaterBodyId: draft.terminal?.waterBodyId,
      targetBasinId: draft.terminal?.basinId,
      termination: downstreamReachId ? 'reach' : draft.terminal?.type ?? 'stuck',
      sourceIds: [],
      discharge: exactDischarge,
      maxFlowStrengthR16: 0,
      widthHint: 1
    });
  }

  const reachById = new Map(reaches.map((reach) => [reach.id, reach]));
  const reachByStart = new Map(reaches.map((reach) => [reach.startCellId, reach]));
  const basinNodes: RiverBasinNodeV2[] = [...basinDecisions.entries()].map(([basinId, decision]) => {
    const record = sampler.basinRecord(basinId) as BasinRecord;
    const body = bodyByBasin.get(basinId) as WaterBodyV1;
    return {
      id: `basin-${basinId}`,
      basinId,
      waterBodyId: body.id,
      status: decision.status,
      inletReachIds: reaches.filter((reach) => reach.targetBasinId === basinId).map((reach) => reach.id),
      outletReachId: decision.status === 'continuous' && record.downstreamCellId !== undefined ? reachByStart.get(record.downstreamCellId)?.id : undefined,
      spillCellId: record.spillCellId,
      downstreamCellId: record.downstreamCellId,
      sourceIds: [],
      inflowDischarge: 0,
      outflowDischarge: 0
    };
  });
  const basinById = new Map(basinNodes.map((node) => [node.basinId, node]));
  for (const basin of basinNodes) {
    basin.inflowDischarge = basin.inletReachIds.reduce((sum, reachId) => sum + (reachById.get(reachId)?.discharge ?? 0), 0);
    basin.outflowDischarge = basin.status === 'continuous'
      ? Math.max(basin.inflowDischarge, basin.outletReachId ? reachById.get(basin.outletReachId)?.discharge ?? 0 : 0)
      : 0;
  }
  for (const source of scene.riverSources) {
    const sourceCell = { x: source.sourceCellX, y: source.sourceCellY };
    let reach = reachByStart.get(sampler.cellId(sourceCell));
    let basin = reach ? undefined : basinById.get(await sampler.basin(sourceCell));
    const visited = new Set<string>();
    while (reach || basin) {
      if (reach) {
        if (visited.has(reach.id)) break;
        visited.add(reach.id);
        reach.discharge += source.discharge;
        reach.sourceIds.push(source.id);
        if (reach.downstreamReachId) {
          reach = reachById.get(reach.downstreamReachId);
          basin = undefined;
        } else if (reach.targetBasinId) {
          basin = basinById.get(reach.targetBasinId);
          reach = undefined;
        } else break;
      } else if (basin) {
        if (visited.has(basin.id)) break;
        visited.add(basin.id);
        basin.inflowDischarge += source.discharge;
        basin.sourceIds.push(source.id);
        const decision = basinDecisions.get(basin.basinId) as BasinWaterBalanceDecision;
        basin.outflowDischarge += source.discharge * decision.outflowFraction;
        reach = basin.outletReachId ? reachById.get(basin.outletReachId) : undefined;
        basin = undefined;
      }
    }
  }
  for (const reach of reaches) {
    reach.widthHint = Math.max(1, 1 + Math.log2(1 + reach.discharge) * 0.55);
  }
  const basinDiagnostics = {
    total: basinNodes.length,
    continuous: basinNodes.filter((node) => node.status === 'continuous').length,
    terminal: basinNodes.filter((node) => node.status === 'terminal').length
  };
  console.info('[WorldForge hydrology] Basin routing summary', {
    ...basinDiagnostics,
    continuousBasinIds: basinNodes.filter((node) => node.status === 'continuous').map((node) => node.basinId),
    terminalBasinIds: basinNodes.filter((node) => node.status === 'terminal').map((node) => node.basinId)
  });
  let automaticSourceCount = 0;
  for (const cell of tributaryCells) if (!prunedTributaryCells.has(cell) && (forcedIndegree.get(cell) ?? 0) === 0) automaticSourceCount += 1;
  let confluenceCount = 0;
  for (const count of forcedIndegree.values()) if (count > 1) confluenceCount += 1;
  const channelDiagnostics: ChannelExtractionDiagnostics = {
    threshold: scene.channelThreshold,
    automaticCells: tributaryCells.size - prunedTributaryCells.size,
    automaticSources: automaticSourceCount,
    confluences: confluenceCount,
    reaches: reaches.length
  };
  console.info('[WorldForge hydrology] Automatic channel extraction summary', {
    ...channelDiagnostics,
    prunedShortTributaryCells: prunedTributaryCells.size
  });
  return { hydrology: { ...scene, waterBodies, reaches, basinNodes }, createdWaterBodies, basinDiagnostics, channelDiagnostics };
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
  private readonly accumulations = new Map<string, Promise<Float32Array | null>>();
  private readonly loadedBasins = new Map<string, Uint32Array | null>();
  private readonly loadedReceivers = new Map<string, Uint16Array | null>();
  private readonly loadedAccumulations = new Map<string, Float32Array | null>();
  private readonly basinIndex = new Map<number, number>();

  constructor(private readonly manager: TileManager, readonly config: WorldConfig, private readonly topology: HydrologyTopologyV3) {
    this.side = config.tileSize * config.tilesPerSide;
    for (let index = 0; index < topology.basinIds.length; index += 1) this.basinIndex.set(topology.basinIds[index], index);
  }

  cellId(cell: Cell): number { return cell.y * this.side + cell.x; }
  cellFromId(id: number): Cell { return { x: id % this.side, y: Math.floor(id / this.side) }; }
  contains(cell: Cell): boolean { return cell.x >= 0 && cell.y >= 0 && cell.x < this.side && cell.y < this.side; }
  isEdge(cell: Cell): boolean { return cell.x === 0 || cell.y === 0 || cell.x === this.side - 1 || cell.y === this.side - 1; }

  async height(cell: Cell): Promise<number> {
    const { tile, index } = this.locate(cell);
    return (await this.cached(this.heights, tile, () => this.manager.readTile({ ...tile, d: 0 })))[index];
  }
  async basin(cell: Cell): Promise<number> {
    const { tile, index } = this.locate(cell);
    return (await this.cached(this.basins, tile, () => this.manager.readBasinIdTile({ ...tile, d: 0 })))?.[index] ?? 0;
  }
  async accumulation(cell: Cell): Promise<number> {
    const { tile, index } = this.locate(cell);
    return (await this.cached(this.accumulations, tile, () => this.manager.readFlowAccumulationTile({ ...tile, d: 0 })))?.[index] ?? 0;
  }
  hasLoadedUpstreamNeighborhood(cell: Cell): boolean {
    return this.upstreamNeighborhoodTiles(cell).every((tile) => {
      const key = `${tile.x},${tile.y}`;
      return this.loadedAccumulations.has(key) && this.loadedBasins.has(key) && this.loadedReceivers.has(key);
    });
  }
  async loadUpstreamNeighborhood(cell: Cell): Promise<void> {
    const required = this.upstreamNeighborhoodTiles(cell);
    const requiredKeys = new Set(required.map((tile) => `${tile.x},${tile.y}`));
    await Promise.all(required.map(async (tile) => {
      const key = `${tile.x},${tile.y}`;
      if (this.loadedAccumulations.has(key)) return;
      const [accumulation, basins, receivers] = await Promise.all([
        this.cached(this.accumulations, tile, () => this.manager.readFlowAccumulationTile({ ...tile, d: 0 })),
        this.cached(this.basins, tile, () => this.manager.readBasinIdTile({ ...tile, d: 0 })),
        this.cached(this.receivers, tile, () => this.manager.readReceiverDirectionTile({ ...tile, d: 0 }))
      ]);
      this.loadedAccumulations.set(key, accumulation);
      this.loadedBasins.set(key, basins);
      this.loadedReceivers.set(key, receivers);
    }));
    while (this.loadedAccumulations.size > 24) {
      const evict = [...this.loadedAccumulations.keys()].find((key) => !requiredKeys.has(key));
      if (evict === undefined) break;
      this.loadedAccumulations.delete(evict);
      this.loadedBasins.delete(evict);
      this.loadedReceivers.delete(evict);
    }
  }
  upstreamChannelNeighborsLoaded(target: Cell, threshold: number): Cell[] {
    const upstream: Array<{ cell: Cell; accumulation: number }> = [];
    for (let codeToCandidate = 1; codeToCandidate <= 8; codeToCandidate += 1) {
      const candidate = { x: target.x + D8_DX[codeToCandidate], y: target.y + D8_DY[codeToCandidate] };
      if (!this.contains(candidate) || this.loadedBasin(candidate) !== 0) continue;
      const accumulation = this.loadedAccumulation(candidate);
      if (accumulation < threshold) continue;
      const selected = this.dominantReceiverLoaded(candidate);
      if (selected?.x === target.x && selected.y === target.y) upstream.push({ cell: candidate, accumulation });
    }
    upstream.sort((a, b) => b.accumulation - a.accumulation || this.cellId(a.cell) - this.cellId(b.cell));
    return upstream.map((item) => item.cell);
  }
  clearLoadedUpstreamTiles(): void {
    this.loadedAccumulations.clear();
    this.loadedBasins.clear();
    this.loadedReceivers.clear();
  }
  private loadedBasin(cell: Cell): number {
    const { tile, index } = this.locate(cell);
    return this.loadedBasins.get(`${tile.x},${tile.y}`)?.[index] ?? 0;
  }
  private loadedAccumulation(cell: Cell): number {
    const { tile, index } = this.locate(cell);
    return this.loadedAccumulations.get(`${tile.x},${tile.y}`)?.[index] ?? 0;
  }
  async receiver(cell: Cell): Promise<Cell | null> {
    const { tile, index } = this.locate(cell);
    const encoded = (await this.cached(this.receivers, tile, () => this.manager.readReceiverDirectionTile({ ...tile, d: 0 })))?.[index];
    const recipients = encoded === undefined ? null : decodeDInfinityRecipients(encoded);
    if (!recipients) return null;
    const candidates = [
      { code: recipients.codeA, weight: recipients.weightA },
      { code: recipients.codeB, weight: recipients.weightB }
    ];
    const evaluated: Array<{ cell: Cell; accumulation: number; weight: number }> = [];
    for (const candidate of candidates) {
      if (candidate.weight <= 1e-6) continue;
      const next = { x: cell.x + D8_DX[candidate.code], y: cell.y + D8_DY[candidate.code] };
      if (!this.contains(next)) continue;
      const accumulation = await this.accumulation(next);
      evaluated.push({ cell: next, accumulation, weight: candidate.weight });
    }
    evaluated.sort((a, b) => b.accumulation - a.accumulation || b.weight - a.weight || this.cellId(a.cell) - this.cellId(b.cell));
    return evaluated[0]?.cell ?? null;
  }
  async sampleReach(cellIds: number[]): Promise<{ points: HydrologyPointV1[]; exactDischarge: number }> {
    const points: HydrologyPointV1[] = [];
    let exactDischarge = 0;
    for (let start = 0; start < cellIds.length;) {
      const firstCell = this.cellFromId(cellIds[start]);
      const firstLocation = this.locate(firstCell);
      let end = start + 1;
      while (end < cellIds.length) {
        const location = this.locate(this.cellFromId(cellIds[end]));
        if (location.tile.x !== firstLocation.tile.x || location.tile.y !== firstLocation.tile.y) break;
        end += 1;
      }
      const [heights, accumulations] = await Promise.all([
        this.cached(this.heights, firstLocation.tile, () => this.manager.readTile({ ...firstLocation.tile, d: 0 })),
        this.cached(this.accumulations, firstLocation.tile, () => this.manager.readFlowAccumulationTile({ ...firstLocation.tile, d: 0 }))
      ]);
      for (let index = start; index < end; index += 1) {
        const cell = this.cellFromId(cellIds[index]);
        const location = this.locate(cell);
        const point = cellCenterToWorld(this.config, cell);
        point.heightR16 = heights[location.index];
        points.push(point);
        exactDischarge = Math.max(exactDischarge, accumulations?.[location.index] ?? 0);
      }
      start = end;
    }
    return { points, exactDischarge };
  }
  basinRecord(id: number): BasinRecord | null {
    const index = this.basinIndex.get(id);
    if (index === undefined) return null;
    const spillCellId = this.topology.spillCells[index] === NO_FLOW_TARGET ? undefined : this.topology.spillCells[index];
    const downstreamCellId = this.topology.downstreamCells[index] === NO_FLOW_TARGET ? undefined : this.topology.downstreamCells[index];
    const downstreamBasinId = this.topology.downstreamIds[index] === NO_FLOW_TARGET ? undefined : this.topology.downstreamIds[index];
    return {
      id,
      fillHeight: this.topology.fillHeights[index],
      areaCells: this.topology.areaCells[index],
      maxDepth: this.topology.maxDepths[index],
      minX: this.topology.minCellX[index], minY: this.topology.minCellY[index],
      maxX: this.topology.maxCellX[index], maxY: this.topology.maxCellY[index],
      spillCellId,
      downstreamCellId,
      downstreamBasinId
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
  private upstreamNeighborhoodTiles(cell: Cell): Array<{ x: number; y: number }> {
    const tiles = new Map<string, { x: number; y: number }>();
    // Two cells covers both recipients of every candidate adjacent to `cell`.
    for (let y = Math.max(0, cell.y - 2); y <= Math.min(this.side - 1, cell.y + 2); y += 1) {
      for (let x = Math.max(0, cell.x - 2); x <= Math.min(this.side - 1, cell.x + 2); x += 1) {
        const tile = this.locate({ x, y }).tile;
        tiles.set(`${tile.x},${tile.y}`, tile);
      }
    }
    return [...tiles.values()];
  }
  private dominantReceiverLoaded(cell: Cell): Cell | null {
    const { tile, index } = this.locate(cell);
    const encoded = this.loadedReceivers.get(`${tile.x},${tile.y}`)?.[index];
    const recipients = encoded === undefined ? null : decodeDInfinityRecipients(encoded);
    if (!recipients) return null;
    let best: Cell | null = null;
    let bestAccumulation = -Infinity;
    let bestWeight = -Infinity;
    let bestId = Infinity;
    for (let recipientIndex = 0; recipientIndex < 2; recipientIndex += 1) {
      const code = recipientIndex === 0 ? recipients.codeA : recipients.codeB;
      const weight = recipientIndex === 0 ? recipients.weightA : recipients.weightB;
      if (weight <= 1e-6) continue;
      const next = { x: cell.x + D8_DX[code], y: cell.y + D8_DY[code] };
      if (!this.contains(next)) continue;
      const accumulation = this.loadedAccumulation(next);
      const id = this.cellId(next);
      if (accumulation > bestAccumulation ||
        (accumulation === bestAccumulation && (weight > bestWeight || (weight === bestWeight && id < bestId)))) {
        best = next;
        bestAccumulation = accumulation;
        bestWeight = weight;
        bestId = id;
      }
    }
    return best;
  }
  private cached<T>(cache: Map<string, Promise<T>>, tile: { x: number; y: number }, read: () => Promise<T>): Promise<T> {
    const key = `${tile.x},${tile.y}`;
    let value = cache.get(key);
    if (value) {
      // Refresh insertion order to make this a tiny LRU rather than retaining
      // every tile touched by a world-spanning river network.
      cache.delete(key);
      cache.set(key, value);
      return value;
    }
    while (cache.size >= 18) {
      const oldest = cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
    value = read();
    cache.set(key, value);
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
