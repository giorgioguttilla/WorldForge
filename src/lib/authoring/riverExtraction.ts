import type { TileKey } from '../heightmap/tileKey';
import { r16ToElevation, type WorldConfig } from '../heightmap/worldConfig';
import type { RiverAssetV1, RiverPointV1 } from './authoringDocument';

export interface RiverExtractionIO {
  readTile(key: TileKey): Promise<Uint16Array>;
  readWaterMaskTile?(key: TileKey): Promise<Uint16Array | null>;
}

interface CoarseCell {
  height: number;
  water: number;
  samples: number;
}

interface TraceCell {
  x: number;
  y: number;
}

const TARGET_COARSE_SIDE = 512;
const MAX_RIVERS = 72;
const MAX_TRACE_STEPS = 420;
const MIN_TRACE_POINTS = 10;
const SOURCE_BIN_COUNT = 8;

export async function extractRiverAssets(
  config: WorldConfig,
  io: RiverExtractionIO,
  generatedAt = new Date().toISOString()
): Promise<RiverAssetV1[]> {
  if (!io.readWaterMaskTile) return [];
  const coarse = await buildCoarseDrainageGrid(config, io);
  const candidates = selectRiverSources(coarse);
  const claimed = new Uint8Array(coarse.side * coarse.side);
  const rivers: RiverAssetV1[] = [];

  for (const candidate of candidates) {
    if (rivers.length >= MAX_RIVERS) break;
    if (isClaimedNear(claimed, coarse.side, candidate.x, candidate.y, 3)) continue;
    const trace = traceDownhill(coarse, candidate.x, candidate.y);
    if (trace.length < MIN_TRACE_POINTS) continue;
    markClaimed(claimed, coarse.side, trace, 2);
    const simplified = simplifyTrace(trace, coarse);
    if (simplified.length < 2) continue;
    const points = simplified.map((cell) => riverPointFromCell(config, coarse, cell));
    rivers.push({
      id: crypto.randomUUID(),
      name: `River ${rivers.length + 1}`,
      generatedAt,
      source: 'erosion-water-mask-v1',
      maxDischarge: Math.max(...points.map((point) => point.discharge)),
      meanSlope: meanTraceSlope(simplified, coarse),
      points
    });
  }

  return rivers;
}

async function buildCoarseDrainageGrid(config: WorldConfig, io: RiverExtractionIO): Promise<{ side: number; stride: number; cells: CoarseCell[]; maxWater: number }> {
  const fullSide = config.tileSize * config.tilesPerSide;
  const side = Math.max(16, Math.min(TARGET_COARSE_SIDE, fullSide));
  const stride = Math.max(1, Math.ceil(fullSide / side));
  const cells = Array.from({ length: side * side }, (): CoarseCell => ({ height: 0, water: 0, samples: 0 }));
  let maxWater = 0;

  for (let tileY = 0; tileY < config.tilesPerSide; tileY += 1) {
    for (let tileX = 0; tileX < config.tilesPerSide; tileX += 1) {
      const key = { x: tileX, y: tileY, d: 0 };
      const mask = await io.readWaterMaskTile?.(key);
      if (!mask) continue;
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
          const water = mask[sampleIndex];
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

function selectRiverSources(coarse: { side: number; cells: CoarseCell[]; maxWater: number }): TraceCell[] {
  if (coarse.maxWater <= 0) return [];
  const waterValues = coarse.cells.map((cell) => cell.water).filter((value) => value > 0).sort((a, b) => a - b);
  if (waterValues.length === 0) return [];
  const threshold = Math.max(coarse.maxWater * 0.08, 768);
  const candidates: Array<TraceCell & { water: number }> = [];

  for (let y = 1; y < coarse.side - 1; y += 1) {
    for (let x = 1; x < coarse.side - 1; x += 1) {
      const water = cellAt(coarse, x, y).water;
      if (cellAt(coarse, x, y).samples === 0) continue;
      if (water < threshold) continue;
      if (!isLocalWaterPeak(coarse, x, y, water)) continue;
      candidates.push({ x, y, water });
    }
  }

  return spatiallyBalanceSources(candidates, coarse.side).slice(0, MAX_RIVERS * 8);
}

function spatiallyBalanceSources(candidates: Array<TraceCell & { water: number }>, side: number): TraceCell[] {
  const bins = Array.from({ length: SOURCE_BIN_COUNT * SOURCE_BIN_COUNT }, () => [] as Array<TraceCell & { water: number }>);
  for (const candidate of candidates) {
    const binX = Math.min(SOURCE_BIN_COUNT - 1, Math.floor((candidate.x / side) * SOURCE_BIN_COUNT));
    const binY = Math.min(SOURCE_BIN_COUNT - 1, Math.floor((candidate.y / side) * SOURCE_BIN_COUNT));
    bins[binY * SOURCE_BIN_COUNT + binX].push(candidate);
  }
  for (const bin of bins) bin.sort((a, b) => b.water - a.water);

  const balanced: Array<TraceCell & { water: number }> = [];
  const maxDepth = Math.max(0, ...bins.map((bin) => bin.length));
  for (let depth = 0; depth < maxDepth; depth += 1) {
    for (const bin of bins) {
      const candidate = bin[depth];
      if (candidate) balanced.push(candidate);
    }
  }

  return balanced.map(({ x, y }) => ({ x, y }));
}

function traceDownhill(coarse: { side: number; cells: CoarseCell[] }, startX: number, startY: number): TraceCell[] {
  const trace: TraceCell[] = [];
  const visited = new Set<string>();
  let x = startX;
  let y = startY;

  for (let step = 0; step < MAX_TRACE_STEPS; step += 1) {
    const key = `${x}:${y}`;
    if (visited.has(key)) break;
    visited.add(key);
    trace.push({ x, y });
    const next = nextDownhillCell(coarse, x, y);
    if (!next) break;
    x = next.x;
    y = next.y;
    if (x <= 0 || y <= 0 || x >= coarse.side - 1 || y >= coarse.side - 1) {
      trace.push({ x, y });
      break;
    }
  }

  return trace;
}

function nextDownhillCell(coarse: { side: number; cells: CoarseCell[] }, x: number, y: number): TraceCell | null {
  const center = cellAt(coarse, x, y);
  let best: (TraceCell & { score: number }) | null = null;
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
      const diagonal = dx !== 0 && dy !== 0 ? 0.70710678 : 1;
      const score = drop * diagonal + (neighbor.water / 65535) * 0.02;
      if (!best || score > best.score) best = { x: nx, y: ny, score };
    }
  }
  return best ? { x: best.x, y: best.y } : null;
}

function simplifyTrace(trace: TraceCell[], coarse: { side: number; cells: CoarseCell[] }): TraceCell[] {
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

function riverPointFromCell(config: WorldConfig, coarse: { side: number; stride: number; cells: CoarseCell[] }, cell: TraceCell): RiverPointV1 {
  const fullSide = config.tileSize * config.tilesPerSide;
  const worldSize = fullSide * config.unitSize;
  const sampleX = Math.min(fullSide - 1, (cell.x + 0.5) * coarse.stride);
  const sampleY = Math.min(fullSide - 1, (cell.y + 0.5) * coarse.stride);
  const water = cellAt(coarse, cell.x, cell.y).water;
  return {
    x: sampleX * config.unitSize - worldSize / 2,
    z: sampleY * config.unitSize - worldSize / 2,
    elevation: cellAt(coarse, cell.x, cell.y).height,
    discharge: water,
    width: config.unitSize * coarse.stride * (0.75 + Math.sqrt(water / 65535) * 3.25)
  };
}

function meanTraceSlope(trace: TraceCell[], coarse: { side: number; cells: CoarseCell[] }): number {
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

function isLocalWaterPeak(coarse: { side: number; cells: CoarseCell[] }, x: number, y: number, water: number): boolean {
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      if (dx === 0 && dy === 0) continue;
      if (cellAt(coarse, x + dx, y + dy).water > water) return false;
    }
  }
  return true;
}

function isClaimedNear(claimed: Uint8Array, side: number, x: number, y: number, radius: number): boolean {
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= side || ny >= side) continue;
      if (claimed[ny * side + nx]) return true;
    }
  }
  return false;
}

function markClaimed(claimed: Uint8Array, side: number, trace: TraceCell[], radius: number): void {
  for (const cell of trace) {
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        const x = cell.x + dx;
        const y = cell.y + dy;
        if (x < 0 || y < 0 || x >= side || y >= side) continue;
        claimed[y * side + x] = 1;
      }
    }
  }
}

function cellAt(coarse: { side: number; cells: CoarseCell[] }, x: number, y: number): CoarseCell {
  return coarse.cells[y * coarse.side + x];
}
