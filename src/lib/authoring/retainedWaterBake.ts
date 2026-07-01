import type { TileKey } from '../heightmap/tileKey';
import { r16ToElevation, type WorldConfig } from '../heightmap/worldConfig';
import type { ErosionSettingsV1, LakeAssetV1 } from './authoringDocument';
import { normalizeErosionSettings } from './authoringDocument';

export interface RetainedWaterBakeIO {
  readTile(key: TileKey): Promise<Uint16Array>;
  writeRetainedWaterMaskTile?(key: TileKey, samples: Uint16Array): Promise<void>;
}

export interface RetainedWaterBakeResult {
  maxRetainedWaterMask: number;
  lakes: LakeAssetV1[];
}

interface LakeBounds {
  lake: LakeAssetV1;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

interface LakeRaster {
  lake: LakeAssetV1;
  minSampleX: number;
  minSampleY: number;
  maxSampleX: number;
  maxSampleY: number;
  width: number;
  flooded: Uint8Array;
  fallbackBounds: Omit<LakeBounds, 'lake'> | null;
}

const CARDINAL_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1]
];

export async function bakeRetainedWaterMasks(
  config: WorldConfig,
  settingsInput: ErosionSettingsV1,
  lakes: LakeAssetV1[],
  io: RetainedWaterBakeIO,
  onProgress?: (current: number, total: number) => void
): Promise<RetainedWaterBakeResult> {
  const settings = normalizeErosionSettings(settingsInput);
  if (!settings.outputWaterMask || !io.writeRetainedWaterMaskTile) {
    return { maxRetainedWaterMask: 0, lakes };
  }

  const lakeRasters = await buildLakeRasters(config, lakes, io);
  const refinedLakes = lakeRasters.map((raster) => refineLakeFromRaster(config, raster) ?? raster.lake);
  const total = config.tilesPerSide * config.tilesPerSide;
  let completed = 0;
  let maxRetainedWaterMask = 0;

  for (let tileY = 0; tileY < config.tilesPerSide; tileY += 1) {
    for (let tileX = 0; tileX < config.tilesPerSide; tileX += 1) {
      const key = { x: tileX, y: tileY, d: 0 };
      const relevantLakes = lakeRasters.filter((entry) => rasterOverlapsTile(config, entry, tileX, tileY));
      const mask = new Uint16Array(config.tileSize * config.tileSize);

      if (relevantLakes.length > 0) {
        const heights = await io.readTile(key);
        for (let sampleY = 0; sampleY < config.tileSize; sampleY += 1) {
          const worldZ = sampleToWorld(config, tileY * config.tileSize + sampleY);
          for (let sampleX = 0; sampleX < config.tileSize; sampleX += 1) {
            const worldX = sampleToWorld(config, tileX * config.tileSize + sampleX);
            let retainedDepth = 0;
            for (const raster of relevantLakes) {
              const globalX = tileX * config.tileSize + sampleX;
              const globalY = tileY * config.tileSize + sampleY;
              if (!isRasterFlooded(raster, globalX, globalY, worldX, worldZ)) continue;
              const { lake } = raster;
              const height = r16ToElevation(heights[sampleY * config.tileSize + sampleX], config.worldHeight);
              retainedDepth = Math.max(retainedDepth, lake.waterElevation - height);
            }
            if (retainedDepth <= 0) continue;
            const encoded = Math.max(0, Math.min(65535, Math.round((retainedDepth / settings.waterMaskScale) * 65535)));
            mask[sampleY * config.tileSize + sampleX] = encoded;
            maxRetainedWaterMask = Math.max(maxRetainedWaterMask, encoded);
          }
        }
      }

      await io.writeRetainedWaterMaskTile(key, mask);
      completed += 1;
      onProgress?.(completed, total);
    }
  }

  return { maxRetainedWaterMask, lakes: refinedLakes };
}

async function buildLakeRasters(config: WorldConfig, lakes: LakeAssetV1[], io: RetainedWaterBakeIO): Promise<LakeRaster[]> {
  const rasters: LakeRaster[] = [];
  const tileCache = new Map<string, Promise<Uint16Array>>();
  for (const lake of lakes) {
    const raster = await buildLakeRaster(config, lake, io, tileCache);
    if (raster) rasters.push(raster);
  }
  return rasters;
}

async function buildLakeRaster(
  config: WorldConfig,
  lake: LakeAssetV1,
  io: RetainedWaterBakeIO,
  tileCache: Map<string, Promise<Uint16Array>>
): Promise<LakeRaster | null> {
  const bounds = boundsForLake(lake);
  const fullSide = config.tileSize * config.tilesPerSide;
  const marginSamples = Math.max(2, Math.ceil(estimateLakePointSpacing(lake) / Math.max(0.0001, config.unitSize)) * 2);
  const minSampleX = clampInt(Math.floor(worldToSample(config, bounds.minX)) - marginSamples, 0, fullSide - 1);
  const maxSampleX = clampInt(Math.ceil(worldToSample(config, bounds.maxX)) + marginSamples, 0, fullSide - 1);
  const minSampleY = clampInt(Math.floor(worldToSample(config, bounds.minZ)) - marginSamples, 0, fullSide - 1);
  const maxSampleY = clampInt(Math.ceil(worldToSample(config, bounds.maxZ)) + marginSamples, 0, fullSide - 1);
  const width = maxSampleX - minSampleX + 1;
  const height = maxSampleY - minSampleY + 1;
  const sampleCount = width * height;

  if (sampleCount <= 0) return null;
  if (sampleCount > 8_000_000) {
    return { lake, minSampleX, minSampleY, maxSampleX, maxSampleY, width, flooded: new Uint8Array(0), fallbackBounds: bounds };
  }

  let seed = -1;
  let seedHeight = Number.POSITIVE_INFINITY;
  for (let y = minSampleY; y <= maxSampleY; y += 1) {
    const worldZ = sampleToWorld(config, y);
    for (let x = minSampleX; x <= maxSampleX; x += 1) {
      const worldX = sampleToWorld(config, x);
      if (!pointInPolygon(worldX, worldZ, lake.points)) continue;
      const elevation = await readElevation(config, io, tileCache, x, y);
      if (elevation > lake.waterElevation || elevation >= seedHeight) continue;
      seedHeight = elevation;
      seed = (y - minSampleY) * width + (x - minSampleX);
    }
  }

  const flooded = new Uint8Array(sampleCount);
  if (seed < 0) return { lake, minSampleX, minSampleY, maxSampleX, maxSampleY, width, flooded, fallbackBounds: bounds };

  const queue = new Int32Array(sampleCount);
  let head = 0;
  let tail = 0;
  flooded[seed] = 1;
  queue[tail] = seed;
  tail += 1;

  while (head < tail) {
    const localIndex = queue[head];
    head += 1;
    const localX = localIndex % width;
    const localY = Math.floor(localIndex / width);
    for (const [dx, dy] of CARDINAL_OFFSETS) {
      const nx = localX + dx;
      const ny = localY + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const neighborIndex = ny * width + nx;
      if (flooded[neighborIndex]) continue;
      const elevation = await readElevation(config, io, tileCache, minSampleX + nx, minSampleY + ny);
      if (elevation > lake.waterElevation) continue;
      flooded[neighborIndex] = 1;
      queue[tail] = neighborIndex;
      tail += 1;
    }
  }

  return { lake, minSampleX, minSampleY, maxSampleX, maxSampleY, width, flooded, fallbackBounds: null };
}

function isRasterFlooded(raster: LakeRaster, globalX: number, globalY: number, worldX: number, worldZ: number): boolean {
  if (globalX < raster.minSampleX || globalX > raster.maxSampleX || globalY < raster.minSampleY || globalY > raster.maxSampleY) return false;
  if (raster.fallbackBounds) return pointInPolygon(worldX, worldZ, raster.lake.points);
  const localX = globalX - raster.minSampleX;
  const localY = globalY - raster.minSampleY;
  return raster.flooded[localY * raster.width + localX] > 0;
}

function refineLakeFromRaster(config: WorldConfig, raster: LakeRaster): LakeAssetV1 | null {
  if (raster.fallbackBounds || raster.flooded.length === 0) return null;
  const points = outlineFloodRaster(config, raster);
  if (points.length < 3) return null;
  const area = countFloodedSamples(raster) * config.unitSize * config.unitSize;
  return {
    ...raster.lake,
    area,
    points
  };
}

function outlineFloodRaster(config: WorldConfig, raster: LakeRaster): Array<{ x: number; z: number }> {
  const height = raster.maxSampleY - raster.minSampleY + 1;
  const unusedEdges = new Set<string>();
  const adjacency = new Map<string, Set<string>>();
  const vertices = new Map<string, { x: number; z: number }>();
  const addEdge = (ax: number, ay: number, bx: number, by: number) => {
    const ak = `${ax}:${ay}`;
    const bk = `${bx}:${by}`;
    unusedEdges.add(rasterEdgeKey(ak, bk));
    if (!adjacency.has(ak)) adjacency.set(ak, new Set());
    if (!adjacency.has(bk)) adjacency.set(bk, new Set());
    adjacency.get(ak)?.add(bk);
    adjacency.get(bk)?.add(ak);
    vertices.set(ak, rasterVertexToWorld(config, raster, ax, ay));
    vertices.set(bk, rasterVertexToWorld(config, raster, bx, by));
  };

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < raster.width; x += 1) {
      if (!raster.flooded[y * raster.width + x]) continue;
      if (!isLocalFlooded(raster, x, y - 1)) addEdge(x, y, x + 1, y);
      if (!isLocalFlooded(raster, x + 1, y)) addEdge(x + 1, y, x + 1, y + 1);
      if (!isLocalFlooded(raster, x, y + 1)) addEdge(x + 1, y + 1, x, y + 1);
      if (!isLocalFlooded(raster, x - 1, y)) addEdge(x, y + 1, x, y);
    }
  }

  const loops: Array<Array<{ x: number; z: number }>> = [];
  while (unusedEdges.size > 0) {
    const first = unusedEdges.values().next().value;
    if (!first) break;
    const [start, next] = first.split('|');
    const loopKeys = [start, next];
    unusedEdges.delete(rasterEdgeKey(start, next));
    let previous = start;
    let current = next;
    const guardLimit = unusedEdges.size + 4;
    for (let guard = 0; guard < guardLimit; guard += 1) {
      if (current === start) break;
      const following = [...(adjacency.get(current) ?? [])].find((candidate) => unusedEdges.has(rasterEdgeKey(current, candidate)) && candidate !== previous)
        ?? [...(adjacency.get(current) ?? [])].find((candidate) => unusedEdges.has(rasterEdgeKey(current, candidate)));
      if (!following) break;
      unusedEdges.delete(rasterEdgeKey(current, following));
      previous = current;
      current = following;
      loopKeys.push(current);
    }
    if (loopKeys.length >= 4 && loopKeys[0] === loopKeys[loopKeys.length - 1]) {
      const loop = loopKeys.slice(0, -1).map((key) => vertices.get(key)).filter((point): point is { x: number; z: number } => Boolean(point));
      if (loop.length >= 3) loops.push(loop);
    }
  }

  const largest = loops.sort((a, b) => Math.abs(polygonArea(b)) - Math.abs(polygonArea(a)))[0] ?? [];
  return simplifyRasterPolygon(largest, Math.max(config.unitSize, Math.min(config.unitSize * 4, estimateLakePointSpacing(raster.lake) * 0.04)));
}

function rasterEdgeKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function isLocalFlooded(raster: LakeRaster, x: number, y: number): boolean {
  const height = raster.maxSampleY - raster.minSampleY + 1;
  return x >= 0 && y >= 0 && x < raster.width && y < height && raster.flooded[y * raster.width + x] > 0;
}

function rasterVertexToWorld(config: WorldConfig, raster: LakeRaster, x: number, y: number): { x: number; z: number } {
  const worldSize = config.tileSize * config.tilesPerSide * config.unitSize;
  return {
    x: (raster.minSampleX + x - 0.5) * config.unitSize - worldSize / 2,
    z: (raster.minSampleY + y - 0.5) * config.unitSize - worldSize / 2
  };
}

function countFloodedSamples(raster: LakeRaster): number {
  let count = 0;
  for (const sample of raster.flooded) count += sample > 0 ? 1 : 0;
  return count;
}

function simplifyRasterPolygon(points: Array<{ x: number; z: number }>, tolerance: number): Array<{ x: number; z: number }> {
  if (points.length <= 512) return points;
  const simplified = ramerDouglasPeucker(points, tolerance);
  if (simplified.length < 16) return downsamplePolygon(points, 256);
  if (simplified.length <= 256) return simplified;
  return downsamplePolygon(simplified, 256);
}

function downsamplePolygon(points: Array<{ x: number; z: number }>, maxPoints: number): Array<{ x: number; z: number }> {
  if (points.length <= maxPoints) return points;
  const stride = Math.ceil(points.length / maxPoints);
  return points.filter((_, index) => index % stride === 0);
}

function ramerDouglasPeucker(points: Array<{ x: number; z: number }>, tolerance: number): Array<{ x: number; z: number }> {
  if (points.length < 3) return points;
  let maxDistance = 0;
  let splitIndex = 0;
  const first = points[0];
  const last = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i += 1) {
    const distance = pointLineDistance(points[i], first, last);
    if (distance > maxDistance) {
      maxDistance = distance;
      splitIndex = i;
    }
  }
  if (maxDistance <= tolerance) return [first, last];
  const left = ramerDouglasPeucker(points.slice(0, splitIndex + 1), tolerance);
  const right = ramerDouglasPeucker(points.slice(splitIndex), tolerance);
  return left.slice(0, -1).concat(right);
}

function pointLineDistance(point: { x: number; z: number }, a: { x: number; z: number }, b: { x: number; z: number }): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const denom = dx * dx + dz * dz;
  if (denom <= 0.000001) return Math.hypot(point.x - a.x, point.z - a.z);
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.z - a.z) * dz) / denom));
  return Math.hypot(point.x - (a.x + dx * t), point.z - (a.z + dz * t));
}

function polygonArea(points: Array<{ x: number; z: number }>): number {
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a.x * b.z - b.x * a.z;
  }
  return area * 0.5;
}

async function readElevation(
  config: WorldConfig,
  io: RetainedWaterBakeIO,
  tileCache: Map<string, Promise<Uint16Array>>,
  globalX: number,
  globalY: number
): Promise<number> {
  const tileX = Math.floor(globalX / config.tileSize);
  const tileY = Math.floor(globalY / config.tileSize);
  const key = `${tileX}:${tileY}`;
  let tilePromise = tileCache.get(key);
  if (!tilePromise) {
    tilePromise = io.readTile({ x: tileX, y: tileY, d: 0 });
    tileCache.set(key, tilePromise);
  }
  const tile = await tilePromise;
  const localX = globalX - tileX * config.tileSize;
  const localY = globalY - tileY * config.tileSize;
  return r16ToElevation(tile[localY * config.tileSize + localX], config.worldHeight);
}

function boundsForLake(lake: LakeAssetV1): Omit<LakeBounds, 'lake'> {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const point of lake.points) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minZ = Math.min(minZ, point.z);
    maxZ = Math.max(maxZ, point.z);
  }
  return { minX, maxX, minZ, maxZ };
}

function boundsForTile(config: WorldConfig, tileX: number, tileY: number): Omit<LakeBounds, 'lake'> {
  const worldSize = config.tileSize * config.tilesPerSide * config.unitSize;
  const tileSize = config.tileSize * config.unitSize;
  const minX = tileX * tileSize - worldSize / 2;
  const minZ = tileY * tileSize - worldSize / 2;
  return {
    minX,
    minZ,
    maxX: minX + tileSize,
    maxZ: minZ + tileSize
  };
}

function boundsOverlap(a: Omit<LakeBounds, 'lake'>, b: Omit<LakeBounds, 'lake'>): boolean {
  return a.maxX >= b.minX && a.minX <= b.maxX && a.maxZ >= b.minZ && a.minZ <= b.maxZ;
}

function rasterOverlapsTile(config: WorldConfig, raster: LakeRaster, tileX: number, tileY: number): boolean {
  const minSampleX = tileX * config.tileSize;
  const minSampleY = tileY * config.tileSize;
  const maxSampleX = minSampleX + config.tileSize - 1;
  const maxSampleY = minSampleY + config.tileSize - 1;
  return raster.maxSampleX >= minSampleX && raster.minSampleX <= maxSampleX && raster.maxSampleY >= minSampleY && raster.minSampleY <= maxSampleY;
}

function sampleToWorld(config: WorldConfig, sample: number): number {
  const worldSize = config.tileSize * config.tilesPerSide * config.unitSize;
  return sample * config.unitSize - worldSize / 2;
}

function worldToSample(config: WorldConfig, world: number): number {
  const worldSize = config.tileSize * config.tilesPerSide * config.unitSize;
  return (world + worldSize / 2) / config.unitSize;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function estimateLakePointSpacing(lake: LakeAssetV1): number {
  if (lake.points.length < 2) return 1;
  let total = 0;
  for (let i = 0; i < lake.points.length; i += 1) {
    const a = lake.points[i];
    const b = lake.points[(i + 1) % lake.points.length];
    total += Math.hypot(a.x - b.x, a.z - b.z);
  }
  return total / lake.points.length;
}

function pointInPolygon(x: number, z: number, polygon: Array<{ x: number; z: number }>): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const pi = polygon[i];
    const pj = polygon[j];
    if ((pi.z > z) === (pj.z > z)) continue;
    const intersectX = ((pj.x - pi.x) * (z - pi.z)) / (pj.z - pi.z) + pi.x;
    if (x < intersectX) inside = !inside;
  }
  return inside;
}
