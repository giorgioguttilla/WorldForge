import type { TileKey } from '../heightmap/tileKey';
import { r16ToElevation, type WorldConfig } from '../heightmap/worldConfig';
import type { LakeAssetV1, LakePointV1, RiverAssetV1, RiverPointV1 } from './authoringDocument';

export interface RiverExtractionIO {
  readTile(key: TileKey): Promise<Uint16Array>;
  readWaterMaskTile?(key: TileKey): Promise<Uint16Array | null>;
}

interface CoarseCell {
  height: number;
  water: number;
  samples: number;
}

interface CoarseGrid {
  side: number;
  stride: number;
  cells: CoarseCell[];
  maxWater: number;
}

interface FlowNetwork {
  receiver: Int32Array;
  accumulation: Float32Array;
  upstreamRiverCounts: Uint16Array;
  riverMask: Uint8Array;
  maxAccumulation: number;
}

interface TraceCell {
  x: number;
  y: number;
}

export interface HydrologyAssetsV1 {
  rivers: RiverAssetV1[];
  lakes: LakeAssetV1[];
}

const TARGET_COARSE_SIDE = 512;
const MAX_RIVERS = 120;
const MAX_LAKES = 48;
const MAX_TRACE_STEPS = 800;
const MIN_TRACE_POINTS = 8;

export async function extractRiverAssets(
  config: WorldConfig,
  io: RiverExtractionIO,
  generatedAt = new Date().toISOString()
): Promise<RiverAssetV1[]> {
  return (await extractHydrologyAssets(config, io, generatedAt)).rivers;
}

export async function extractHydrologyAssets(
  config: WorldConfig,
  io: RiverExtractionIO,
  generatedAt = new Date().toISOString()
): Promise<HydrologyAssetsV1> {
  const coarse = await buildCoarseDrainageGrid(config, io);
  if (!coarse.cells.some((cell) => cell.samples > 0)) return { rivers: [], lakes: [] };

  const network = buildFlowNetwork(coarse);
  const lakes = extractLakeAssets(config, coarse, network, generatedAt);
  const sources = selectNetworkSources(coarse, network);
  const claimed = new Uint8Array(coarse.side * coarse.side);
  const rivers: RiverAssetV1[] = [];

  for (const source of sources) {
    if (rivers.length >= MAX_RIVERS) break;
    const sourceIndex = source.y * coarse.side + source.x;
    if (claimed[sourceIndex]) continue;
    const trace = traceRiverNetwork(coarse, network, source.x, source.y, claimed);
    if (trace.length < MIN_TRACE_POINTS) continue;
    markTraceClaimed(claimed, coarse.side, trace);
    const simplified = simplifyTrace(trace, coarse);
    if (simplified.length < 2) continue;
    const points = simplified.map((cell) => riverPointFromCell(config, coarse, network, cell));
    rivers.push({
      id: crypto.randomUUID(),
      name: `River ${rivers.length + 1}`,
      generatedAt,
      source: 'heightmap-flow-v2',
      maxDischarge: Math.max(...points.map((point) => point.discharge)),
      meanSlope: meanTraceSlope(simplified, coarse),
      points
    });
  }

  return { rivers, lakes };
}

async function buildCoarseDrainageGrid(config: WorldConfig, io: RiverExtractionIO): Promise<CoarseGrid> {
  const fullSide = config.tileSize * config.tilesPerSide;
  const side = Math.max(16, Math.min(TARGET_COARSE_SIDE, fullSide));
  const stride = Math.max(1, Math.ceil(fullSide / side));
  const cells = Array.from({ length: side * side }, (): CoarseCell => ({ height: 0, water: 0, samples: 0 }));
  let maxWater = 0;

  for (let tileY = 0; tileY < config.tilesPerSide; tileY += 1) {
    for (let tileX = 0; tileX < config.tilesPerSide; tileX += 1) {
      const key = { x: tileX, y: tileY, d: 0 };
      const mask = await io.readWaterMaskTile?.(key);
      const heights = await io.readTile(key);
      const offsetX = tileX * config.tileSize;
      const offsetY = tileY * config.tileSize;
      const startX = (stride - (offsetX % stride)) % stride;
      const startY = (stride - (offsetY % stride)) % stride;
      for (let y = startY; y < config.tileSize; y += stride) {
        const globalY = offsetY + y;
        const coarseY = Math.min(side - 1, Math.floor(globalY / stride));
        for (let x = startX; x < config.tileSize; x += stride) {
          const globalX = offsetX + x;
          const coarseX = Math.min(side - 1, Math.floor(globalX / stride));
          const sampleIndex = y * config.tileSize + x;
          const coarseIndex = coarseY * side + coarseX;
          const cell = cells[coarseIndex];
          const water = mask?.[sampleIndex] ?? 0;
          cell.height += r16ToElevation(heights[sampleIndex], config.worldHeight);
          cell.water = Math.max(cell.water, water);
          cell.samples += 1;
          maxWater = Math.max(maxWater, water);
        }
      }
    }
  }

  for (const cell of cells) {
    if (cell.samples > 0) cell.height /= cell.samples;
  }

  return { side, stride, cells, maxWater };
}

function buildFlowNetwork(coarse: CoarseGrid): FlowNetwork {
  const count = coarse.side * coarse.side;
  const receiver = new Int32Array(count).fill(-1);
  const accumulation = new Float32Array(count);
  const order: number[] = [];

  for (let index = 0; index < count; index += 1) {
    const cell = coarse.cells[index];
    if (cell.samples === 0) continue;
    const x = index % coarse.side;
    const y = Math.floor(index / coarse.side);
    receiver[index] = nextDownhillIndex(coarse, x, y);
    accumulation[index] = 1 + Math.sqrt(cell.water / 65535) * 1.5;
    order.push(index);
  }

  order.sort((a, b) => coarse.cells[b].height - coarse.cells[a].height);
  for (const index of order) {
    const next = receiver[index];
    if (next >= 0) accumulation[next] += accumulation[index];
  }

  let maxAccumulation = 0;
  for (let index = 0; index < count; index += 1) {
    if (coarse.cells[index].samples === 0) continue;
    maxAccumulation = Math.max(maxAccumulation, accumulation[index]);
  }

  const riverMask = buildRiverMask(coarse, accumulation, maxAccumulation);
  const upstreamRiverCounts = new Uint16Array(count);
  for (let index = 0; index < count; index += 1) {
    if (!riverMask[index]) continue;
    const next = receiver[index];
    if (next >= 0 && riverMask[next]) upstreamRiverCounts[next] += 1;
  }

  return { receiver, accumulation, upstreamRiverCounts, riverMask, maxAccumulation };
}

function nextDownhillIndex(coarse: CoarseGrid, x: number, y: number): number {
  const center = cellAt(coarse, x, y);
  let bestIndex = -1;
  let bestScore = 0;
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= coarse.side || ny >= coarse.side) continue;
      const neighbor = cellAt(coarse, nx, ny);
      if (neighbor.samples === 0) continue;
      const drop = center.height - neighbor.height;
      if (drop <= 0) continue;
      const distanceScale = dx !== 0 && dy !== 0 ? 0.70710678 : 1;
      const score = drop * distanceScale + (neighbor.water / 65535) * 0.02;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = ny * coarse.side + nx;
      }
    }
  }
  return bestIndex;
}

function buildRiverMask(coarse: CoarseGrid, accumulation: Float32Array, maxAccumulation: number): Uint8Array {
  const riverMask = new Uint8Array(coarse.side * coarse.side);
  if (maxAccumulation <= 0) return riverMask;
  const scores: number[] = [];
  for (let index = 0; index < coarse.cells.length; index += 1) {
    const cell = coarse.cells[index];
    if (cell.samples === 0) continue;
    scores.push(riverScore(coarse, accumulation, index));
  }
  scores.sort((a, b) => a - b);
  const percentile = scores[Math.floor(scores.length * 0.9)] ?? 0;
  const threshold = Math.max(12, percentile, maxAccumulation * 0.012);

  for (let index = 0; index < coarse.cells.length; index += 1) {
    const cell = coarse.cells[index];
    if (cell.samples === 0) continue;
    if (riverScore(coarse, accumulation, index) >= threshold) riverMask[index] = 1;
  }
  return riverMask;
}

function riverScore(coarse: CoarseGrid, accumulation: Float32Array, index: number): number {
  const wetness = coarse.maxWater > 0 ? Math.sqrt(coarse.cells[index].water / coarse.maxWater) : 0;
  return accumulation[index] * (0.9 + wetness * 0.25);
}

function selectNetworkSources(coarse: CoarseGrid, network: FlowNetwork): TraceCell[] {
  const sources: Array<TraceCell & { score: number }> = [];
  for (let index = 0; index < network.riverMask.length; index += 1) {
    if (!network.riverMask[index]) continue;
    if (network.upstreamRiverCounts[index] > 0) continue;
    const x = index % coarse.side;
    const y = Math.floor(index / coarse.side);
    sources.push({ x, y, score: network.accumulation[index] });
  }
  return sources
    .sort((a, b) => b.score - a.score)
    .map(({ x, y }) => ({ x, y }));
}

function traceRiverNetwork(coarse: CoarseGrid, network: FlowNetwork, startX: number, startY: number, claimed: Uint8Array): TraceCell[] {
  const trace: TraceCell[] = [];
  const visited = new Set<number>();
  let index = startY * coarse.side + startX;

  for (let step = 0; step < MAX_TRACE_STEPS; step += 1) {
    if (index < 0 || visited.has(index)) break;
    visited.add(index);
    trace.push({ x: index % coarse.side, y: Math.floor(index / coarse.side) });
    const next = network.receiver[index];
    if (next < 0) break;
    if (claimed[next] && network.upstreamRiverCounts[next] > 1) break;
    if (!network.riverMask[next] && trace.length >= MIN_TRACE_POINTS) break;
    index = next;
  }

  return trace;
}

function extractLakeAssets(config: WorldConfig, coarse: CoarseGrid, network: FlowNetwork, generatedAt: string): LakeAssetV1[] {
  const sinkForCell = computeSinkMap(coarse, network);
  const sinkAccumulation = new Map<number, number>();
  for (let index = 0; index < sinkForCell.length; index += 1) {
    const sink = sinkForCell[index];
    if (sink < 0) continue;
    sinkAccumulation.set(sink, (sinkAccumulation.get(sink) ?? 0) + network.accumulation[index]);
  }

  const candidates = [...sinkAccumulation.entries()]
    .filter(([sink, accumulation]) => {
      if (isEdgeIndex(coarse.side, sink)) return false;
      return accumulation >= Math.max(18, network.maxAccumulation * 0.025);
    })
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_LAKES * 4);

  const lakes: LakeAssetV1[] = [];
  for (const [sink, accumulation] of candidates) {
    if (lakes.length >= MAX_LAKES) break;
    const basin = collectBasinCells(sinkForCell, sink);
    if (basin.length < 4) continue;
    const lake = createLakeFromBasin(config, coarse, basin, sink, accumulation, network.maxAccumulation, generatedAt, lakes.length + 1);
    if (lake) lakes.push(lake);
  }
  return lakes;
}

function computeSinkMap(coarse: CoarseGrid, network: FlowNetwork): Int32Array {
  const sinkForCell = new Int32Array(coarse.side * coarse.side).fill(-2);
  const resolve = (start: number): number => {
    const stack: number[] = [];
    let index = start;
    while (index >= 0) {
      const known = sinkForCell[index];
      if (known >= -1 && known !== -2) {
        for (const item of stack) sinkForCell[item] = known;
        return known;
      }
      stack.push(index);
      const next = network.receiver[index];
      if (next < 0) {
        for (const item of stack) sinkForCell[item] = index;
        return index;
      }
      index = next;
    }
    for (const item of stack) sinkForCell[item] = -1;
    return -1;
  };

  for (let index = 0; index < sinkForCell.length; index += 1) {
    if (coarse.cells[index].samples === 0) {
      sinkForCell[index] = -1;
      continue;
    }
    resolve(index);
  }
  return sinkForCell;
}

function collectBasinCells(sinkForCell: Int32Array, sink: number): number[] {
  const basin: number[] = [];
  for (let index = 0; index < sinkForCell.length; index += 1) {
    if (sinkForCell[index] === sink) basin.push(index);
  }
  return basin;
}

function createLakeFromBasin(
  config: WorldConfig,
  coarse: CoarseGrid,
  basin: number[],
  sink: number,
  accumulation: number,
  maxAccumulation: number,
  generatedAt: string,
  index: number
): LakeAssetV1 | null {
  const basinSet = new Set(basin);
  const rim = findBasinRim(coarse, basinSet);
  if (!rim) return null;
  const sinkHeight = coarse.cells[sink].height;
  const relief = rim.height - sinkHeight;
  if (relief <= config.unitSize * coarse.stride * 0.04) return null;

  const fillFraction = 0.48 + Math.min(0.38, (accumulation / Math.max(1, maxAccumulation)) * 0.38);
  const waterElevation = sinkHeight + relief * fillFraction;
  const flooded = basin.filter((cellIndex) => coarse.cells[cellIndex].height <= waterElevation);
  if (flooded.length < 3) return null;

  const polygon = outlineCellsAsRadialPolygon(config, coarse, flooded);
  if (polygon.length < 3) return null;
  const cellArea = (config.unitSize * coarse.stride) ** 2;
  return {
    id: crypto.randomUUID(),
    name: `Lake ${index}`,
    generatedAt,
    source: 'heightmap-depression-v2',
    waterElevation,
    area: flooded.length * cellArea,
    maxDepth: Math.max(0, waterElevation - sinkHeight),
    points: polygon,
    outlet: coarseIndexToWorldPoint(config, coarse, rim.outlet)
  };
}

function findBasinRim(coarse: CoarseGrid, basin: Set<number>): { height: number; outlet: number } | null {
  let best: { height: number; outlet: number } | null = null;
  for (const index of basin) {
    const x = index % coarse.side;
    const y = Math.floor(index / coarse.side);
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= coarse.side || ny >= coarse.side) continue;
        const neighborIndex = ny * coarse.side + nx;
        if (basin.has(neighborIndex)) continue;
        const neighbor = coarse.cells[neighborIndex];
        if (neighbor.samples === 0) continue;
        if (!best || neighbor.height < best.height) best = { height: neighbor.height, outlet: neighborIndex };
      }
    }
  }
  return best;
}

function outlineCellsAsRadialPolygon(config: WorldConfig, coarse: CoarseGrid, cells: number[]): LakePointV1[] {
  let cx = 0;
  let cz = 0;
  const points = cells.map((index) => coarseIndexToWorldPoint(config, coarse, index));
  for (const point of points) {
    cx += point.x;
    cz += point.z;
  }
  cx /= points.length;
  cz /= points.length;

  const binCount = Math.min(64, Math.max(16, Math.ceil(Math.sqrt(points.length) * 4)));
  const bins: Array<(LakePointV1 & { distance: number }) | null> = Array.from({ length: binCount }, () => null);
  for (const point of points) {
    const angle = Math.atan2(point.z - cz, point.x - cx);
    const bin = Math.min(binCount - 1, Math.floor(((angle + Math.PI) / (Math.PI * 2)) * binCount));
    const distance = Math.hypot(point.x - cx, point.z - cz);
    if (!bins[bin] || distance > bins[bin].distance) bins[bin] = { ...point, distance };
  }
  return bins
    .filter((point): point is LakePointV1 & { distance: number } => Boolean(point))
    .map(({ x, z }) => ({ x, z }));
}

function simplifyTrace(trace: TraceCell[], coarse: CoarseGrid): TraceCell[] {
  const simplified: TraceCell[] = [];
  let previousDirection = '';
  for (let i = 0; i < trace.length; i += 1) {
    const point = trace[i];
    const next = trace[i + 1];
    const direction = next ? `${Math.sign(next.x - point.x)}:${Math.sign(next.y - point.y)}` : 'end';
    if (i === 0 || i === trace.length - 1 || direction !== previousDirection || i % 5 === 0) {
      simplified.push(point);
    }
    previousDirection = direction;
  }
  return simplified.filter((point, index) => {
    if (index === 0) return true;
    const previous = simplified[index - 1];
    return Math.hypot(point.x - previous.x, point.y - previous.y) >= 1 || index === simplified.length - 1;
  }).filter((point) => cellAt(coarse, point.x, point.y).samples > 0);
}

function riverPointFromCell(config: WorldConfig, coarse: CoarseGrid, network: FlowNetwork, cell: TraceCell): RiverPointV1 {
  const fullSide = config.tileSize * config.tilesPerSide;
  const worldSize = fullSide * config.unitSize;
  const sampleX = Math.min(fullSide - 1, (cell.x + 0.5) * coarse.stride);
  const sampleY = Math.min(fullSide - 1, (cell.y + 0.5) * coarse.stride);
  const index = cell.y * coarse.side + cell.x;
  const accumulation01 = network.maxAccumulation > 0 ? network.accumulation[index] / network.maxAccumulation : 0;
  const discharge = Math.max(cellAt(coarse, cell.x, cell.y).water, Math.min(65535, Math.round(accumulation01 * 65535)));
  return {
    x: sampleX * config.unitSize - worldSize / 2,
    z: sampleY * config.unitSize - worldSize / 2,
    elevation: cellAt(coarse, cell.x, cell.y).height,
    discharge,
    width: config.unitSize * coarse.stride * (0.9 + Math.sqrt(discharge / 65535) * 4.2)
  };
}

function meanTraceSlope(trace: TraceCell[], coarse: CoarseGrid): number {
  if (trace.length < 2) return 0;
  let total = 0;
  let count = 0;
  for (let i = 0; i < trace.length - 1; i += 1) {
    const a = cellAt(coarse, trace[i].x, trace[i].y);
    const b = cellAt(coarse, trace[i + 1].x, trace[i + 1].y);
    total += Math.max(0, a.height - b.height);
    count += 1;
  }
  return count > 0 ? total / count : 0;
}

function coarseIndexToWorldPoint(config: WorldConfig, coarse: CoarseGrid, index: number): LakePointV1 {
  const fullSide = config.tileSize * config.tilesPerSide;
  const worldSize = fullSide * config.unitSize;
  const x = index % coarse.side;
  const y = Math.floor(index / coarse.side);
  const sampleX = Math.min(fullSide - 1, (x + 0.5) * coarse.stride);
  const sampleY = Math.min(fullSide - 1, (y + 0.5) * coarse.stride);
  return {
    x: sampleX * config.unitSize - worldSize / 2,
    z: sampleY * config.unitSize - worldSize / 2
  };
}

function isEdgeIndex(side: number, index: number): boolean {
  const x = index % side;
  const y = Math.floor(index / side);
  return x <= 0 || y <= 0 || x >= side - 1 || y >= side - 1;
}

function markTraceClaimed(claimed: Uint8Array, side: number, trace: TraceCell[]): void {
  for (const cell of trace) claimed[cell.y * side + cell.x] = 1;
}

function cellAt(coarse: CoarseGrid, x: number, y: number): CoarseCell {
  return coarse.cells[y * coarse.side + x];
}
