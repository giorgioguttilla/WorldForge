import { downsample2x2Children } from '../heightmap/lodBuilder';
import { ancestorsForDirtyTile, childTileKeys, tileKeyToId, type TileKey } from '../heightmap/tileKey';
import type { WorldConfig } from '../heightmap/worldConfig';
import type { AuthoringDocumentV1, BakeMetadataV1 } from './authoringDocument';
import {
  clamp,
  elevationToR16,
  filterPreparedStructuralDocumentForBounds,
  prepareStructuralDocument,
  preparedLandformWeightAt,
  preparedLandformSplineSpaceAt,
  preparedMountainWeightAt,
  preparedMountainSplineSpaceAt,
  stableAuthoringHash,
  type Bounds2D,
  type PreparedStructuralDocument
} from './geometry';
import type { CompiledNoiseFieldGraph, NoiseFieldEvaluationContext } from '../noiseGraph';

export interface BakeProgress {
  phase: 'baking' | 'building-lod';
  current: number;
  total: number;
  label: string;
}

export interface BakeTileIO {
  readTile(key: TileKey): Promise<Uint16Array>;
  writeTile(key: TileKey, samples: Uint16Array): Promise<void>;
}

export interface BakePassResult {
  id: string;
}

export interface BakePass<T extends BakePassResult> {
  id: string;
  run(): Promise<T>;
}

export interface StructuralBakeResult {
  metadata: BakeMetadataV1;
  dirtyTiles: TileKey[];
  lodTileCount: number;
}

export interface StructuralBakeOptions {
  debugTelemetry?: boolean;
}

interface DepthZeroPassResult extends BakePassResult {
  dirtyTiles: TileKey[];
}

interface LodPassResult extends BakePassResult {
  lodTileCount: number;
}

interface BakeWorkerResponse {
  id: number;
  key: TileKey;
  samples: ArrayBuffer;
}

interface BakeWorkerError {
  id: number;
  error: string;
}

type BakeWorkerRequest =
  | {
      id: number;
      type: 'init-depth-zero-bake';
      config: WorldConfig;
      document: AuthoringDocumentV1;
      waterLevel: number;
      debugTelemetry?: boolean;
    }
  | {
      id: number;
      type: 'bake-depth-zero-tile';
      tileX: number;
      tileY: number;
    }
  | {
      id: number;
      type: 'downsample-lod-tile';
      tileSize: number;
      key: TileKey;
      children: ArrayBuffer[];
    };

export async function bakeStructuralAuthoring(
  config: WorldConfig,
  document: AuthoringDocumentV1,
  waterLevel: number,
  io: BakeTileIO,
  onProgress?: (progress: BakeProgress) => void,
  options: StructuralBakeOptions = {}
): Promise<StructuralBakeResult> {
  const startedAt = new Date().toISOString();
  const tileCount = config.tilesPerSide * config.tilesPerSide;

  const depthZeroPass: BakePass<DepthZeroPassResult> = {
    id: 'depth-zero-structural',
    run: () => runDepthZeroStructuralPass(config, document, waterLevel, io, onProgress, options)
  };
  const depthZero = await depthZeroPass.run();

  const lodPass: BakePass<LodPassResult> = {
    id: 'lod-rebuild',
    run: () => runLodRebuildPass(config, depthZero.dirtyTiles, io, onProgress)
  };
  const lod = await lodPass.run();

  return {
    metadata: {
      id: crypto.randomUUID(),
      startedAt,
      completedAt: new Date().toISOString(),
      status: 'clean',
      inputHash: stableAuthoringHash(config, document, waterLevel),
      primitiveCount: document.primitives.filter((primitive) => primitive.enabled).length,
      tileCount
    },
    dirtyTiles: depthZero.dirtyTiles,
    lodTileCount: lod.lodTileCount
  };
}

export function createFailedBakeMetadata(config: WorldConfig, document: AuthoringDocumentV1, waterLevel: number, error: unknown): BakeMetadataV1 {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    startedAt: now,
    completedAt: now,
    status: 'failed',
    inputHash: stableAuthoringHash(config, document, waterLevel),
    primitiveCount: document.primitives.filter((primitive) => primitive.enabled).length,
    tileCount: config.tilesPerSide * config.tilesPerSide,
    error: error instanceof Error ? error.message : 'Bake failed.'
  };
}

export function bakeDepthZeroTile(config: WorldConfig, document: AuthoringDocumentV1, waterLevel: number, tileX: number, tileY: number): Uint16Array {
  return bakePreparedDepthZeroTile(config, prepareStructuralDocument(document), waterLevel, tileX, tileY);
}

export function bakePreparedDepthZeroTile(
  config: WorldConfig,
  document: PreparedStructuralDocument,
  waterLevel: number,
  tileX: number,
  tileY: number,
  options: StructuralBakeOptions = {}
): Uint16Array {
  const start = performance.now();
  const samples = new Uint16Array(config.tileSize * config.tileSize);
  const elevations = new Float32Array(config.tileSize * config.tileSize);
  const worldSize = config.tileSize * config.tilesPerSide * config.unitSize;
  const tileMinX = tileX * config.tileSize * config.unitSize - worldSize / 2;
  const tileMinZ = tileY * config.tileSize * config.unitSize - worldSize / 2;
  const tileMaxX = tileMinX + (config.tileSize - 1) * config.unitSize;
  const tileMaxZ = tileMinZ + (config.tileSize - 1) * config.unitSize;
  const prepared = filterPreparedStructuralDocumentForBounds(document, {
    minX: tileMinX,
    maxX: tileMaxX,
    minZ: tileMinZ,
    maxZ: tileMaxZ
  });

  for (const landform of prepared.landforms) {
    const primitiveStart = performance.now();
    let visited = 0;
    let affected = 0;
    const range = sampleRangeForBounds(config, worldSize, tileX, tileY, landform.bounds);
    if (range) {
      const targetElevation = getLandformTargetElevation(landform.primitive, waterLevel, config.worldHeight);
      const field = getPreparedField(prepared, landform.primitive.fieldId);
      const fieldContext: NoiseFieldEvaluationContext | null = field ? {
        cartesian: { x: 0, y: 0 },
        spline: { x: 0, y: 0 }
      } : null;
      for (let sampleY = range.minY; sampleY <= range.maxY; sampleY += 1) {
        const worldZ = (tileY * config.tileSize + sampleY) * config.unitSize - worldSize / 2;
        for (let sampleX = range.minX; sampleX <= range.maxX; sampleX += 1) {
          visited += 1;
          const worldX = (tileX * config.tileSize + sampleX) * config.unitSize - worldSize / 2;
          const weight = preparedLandformWeightAt(landform, worldX, worldZ);
          if (weight <= 0) continue;
          const index = sampleY * config.tileSize + sampleX;
          let target = targetElevation;
          if (field && fieldContext) {
            fieldContext.cartesian.x = worldX;
            fieldContext.cartesian.y = worldZ;
            if (field.usesSpline) preparedLandformSplineSpaceAt(landform, worldX, worldZ, fieldContext.spline);
            const displacement = field.evaluate(fieldContext);
            target += displacement * landform.primitive.noiseScale;
          }
          elevations[index] = lerp(elevations[index], clamp(target, 0, config.worldHeight), weight);
          affected += 1;
        }
      }
    }
    logPrimitiveTelemetry(options, 'landform', landform.primitive.name, tileX, tileY, visited, affected, performance.now() - primitiveStart);
  }

  for (const mountain of prepared.mountains) {
    const primitiveStart = performance.now();
    let visited = 0;
    let affected = 0;
    const range = sampleRangeForBounds(config, worldSize, tileX, tileY, mountain.bounds);
    const height = Math.max(0, mountain.primitive.height);
    if (range && height > 0) {
      const field = getPreparedField(prepared, mountain.primitive.fieldId);
      const fieldContext: NoiseFieldEvaluationContext | null = field ? {
        cartesian: { x: 0, y: 0 },
        spline: { x: 0, y: 0 }
      } : null;
      for (let sampleY = range.minY; sampleY <= range.maxY; sampleY += 1) {
        const worldZ = (tileY * config.tileSize + sampleY) * config.unitSize - worldSize / 2;
        for (let sampleX = range.minX; sampleX <= range.maxX; sampleX += 1) {
          visited += 1;
          const worldX = (tileX * config.tileSize + sampleX) * config.unitSize - worldSize / 2;
          const weight = preparedMountainWeightAt(mountain, worldX, worldZ);
          if (weight <= 0) continue;
          const index = sampleY * config.tileSize + sampleX;
          let mountainValue = 1;
          if (field && fieldContext) {
            fieldContext.cartesian.x = worldX;
            fieldContext.cartesian.y = worldZ;
            if (field.usesSpline) preparedMountainSplineSpaceAt(mountain, worldX, worldZ, fieldContext.spline);
            mountainValue = field.evaluate(fieldContext);
          }
          elevations[index] = clamp(elevations[index] + mountainValue * height * weight, 0, config.worldHeight);
          affected += 1;
        }
      }
    }
    logPrimitiveTelemetry(options, 'mountain', mountain.primitive.name, tileX, tileY, visited, affected, performance.now() - primitiveStart);
  }

  for (let i = 0; i < elevations.length; i += 1) {
    samples[i] = elevationToR16(elevations[i], config.worldHeight);
  }

  if (options.debugTelemetry) {
    console.log('[WorldForge bake tile]', {
      tile: `${tileX},${tileY}`,
      landforms: prepared.landforms.length,
      mountains: prepared.mountains.length,
      ms: Number((performance.now() - start).toFixed(2))
    });
  }

  return samples;
}

function getPreparedField(document: PreparedStructuralDocument, fieldId: string | undefined): CompiledNoiseFieldGraph | null {
  if (!fieldId) return null;
  return document.compiledFields.get(fieldId) ?? null;
}

function sampleRangeForBounds(
  config: WorldConfig,
  worldSize: number,
  tileX: number,
  tileY: number,
  bounds: Bounds2D
): { minX: number; maxX: number; minY: number; maxY: number } | null {
  const tileOriginX = tileX * config.tileSize;
  const tileOriginY = tileY * config.tileSize;
  const minX = Math.max(0, Math.ceil((bounds.minX + worldSize / 2) / config.unitSize - tileOriginX));
  const maxX = Math.min(config.tileSize - 1, Math.floor((bounds.maxX + worldSize / 2) / config.unitSize - tileOriginX));
  const minY = Math.max(0, Math.ceil((bounds.minZ + worldSize / 2) / config.unitSize - tileOriginY));
  const maxY = Math.min(config.tileSize - 1, Math.floor((bounds.maxZ + worldSize / 2) / config.unitSize - tileOriginY));
  if (minX > maxX || minY > maxY) return null;
  return { minX, maxX, minY, maxY };
}

function logPrimitiveTelemetry(
  options: StructuralBakeOptions,
  type: 'landform' | 'mountain',
  name: string,
  tileX: number,
  tileY: number,
  visited: number,
  affected: number,
  ms: number
): void {
  if (!options.debugTelemetry) return;
  console.log('[WorldForge bake primitive]', {
    tile: `${tileX},${tileY}`,
    type,
    name,
    visited,
    affected,
    ms: Number(ms.toFixed(2))
  });
}

function getLandformTargetElevation(primitive: { mode: string; elevation: number }, waterLevel: number, worldHeight: number): number {
  if (primitive.mode === 'water') return clamp(Math.min(primitive.elevation, waterLevel - 1), 0, worldHeight);
  return clamp(Math.max(primitive.elevation, waterLevel + 1), 0, worldHeight);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

async function runDepthZeroStructuralPass(
  config: WorldConfig,
  document: AuthoringDocumentV1,
  waterLevel: number,
  io: BakeTileIO,
  onProgress?: (progress: BakeProgress) => void,
  options: StructuralBakeOptions = {}
): Promise<DepthZeroPassResult> {
  const dirtyTiles: TileKey[] = [];
  const jobs: Array<{ x: number; y: number }> = [];
  for (let y = 0; y < config.tilesPerSide; y += 1) {
    for (let x = 0; x < config.tilesPerSide; x += 1) {
      jobs.push({ x, y });
    }
  }

  let written = 0;
  const total = jobs.length;
  if (!canUseBakeWorkers() || total <= 1) {
    const prepared = prepareStructuralDocument(document);
    for (const job of jobs) {
      const key = { x: job.x, y: job.y, d: 0 };
      await io.writeTile(key, bakePreparedDepthZeroTile(config, prepared, waterLevel, job.x, job.y, options));
      dirtyTiles.push(key);
      written += 1;
      onProgress?.({ phase: 'baking', current: written, total, label: `Baking structural tiles ${written} / ${total}` });
    }
    return { id: 'depth-zero-structural', dirtyTiles };
  }

  await runEphemeralWorkerPool(
    jobs,
    (job, id) => ({
      id,
      type: 'bake-depth-zero-tile',
      tileX: job.x,
      tileY: job.y
    }),
    async ({ key, samples }) => {
      await io.writeTile(key, new Uint16Array(samples));
      dirtyTiles.push(key);
      written += 1;
      onProgress?.({ phase: 'baking', current: written, total, label: `Baking structural tiles ${written} / ${total}` });
    },
    () => ({
      id: 0,
      type: 'init-depth-zero-bake',
      config,
      document,
      waterLevel,
      debugTelemetry: options.debugTelemetry
    })
  );

  return { id: 'depth-zero-structural', dirtyTiles };
}

async function runLodRebuildPass(
  config: WorldConfig,
  dirtyTiles: TileKey[],
  io: BakeTileIO,
  onProgress?: (progress: BakeProgress) => void
): Promise<LodPassResult> {
  const ancestors = getDirtyAncestors(dirtyTiles, config.tilesPerSide);
  const total = ancestors.length;
  let rebuilt = 0;
  const maxDepth = Math.log2(config.tilesPerSide);

  for (let depth = 1; depth <= maxDepth; depth += 1) {
    const parents = ancestors.filter((key) => key.d === depth);
    if (parents.length === 0) continue;

    if (!canUseBakeWorkers() || parents.length <= 1) {
      for (const parent of parents) {
        const children: Uint16Array[] = [];
        for (const child of childTileKeys(parent)) {
          children.push(await io.readTile(child));
        }
        await io.writeTile(parent, downsample2x2Children(config.tileSize, children));
        rebuilt += 1;
        onProgress?.({ phase: 'building-lod', current: rebuilt, total, label: `Building LOD tiles ${rebuilt} / ${total}` });
      }
      continue;
    }

    await runEphemeralWorkerPool(
      parents,
      async (key, id) => {
        const children: ArrayBuffer[] = [];
        for (const child of childTileKeys(key)) {
          const samples = await io.readTile(child);
          children.push(new Uint16Array(samples).buffer);
        }
        return {
          id,
          type: 'downsample-lod-tile',
          tileSize: config.tileSize,
          key,
          children
        };
      },
      async ({ key, samples }) => {
        await io.writeTile(key, new Uint16Array(samples));
        rebuilt += 1;
        onProgress?.({ phase: 'building-lod', current: rebuilt, total, label: `Building LOD tiles ${rebuilt} / ${total}` });
      }
    );
  }

  return { id: 'lod-rebuild', lodTileCount: rebuilt };
}

async function runEphemeralWorkerPool<TJob>(
  jobs: TJob[],
  createRequest: (job: TJob, id: number) => BakeWorkerRequest | Promise<BakeWorkerRequest>,
  handleResult: (result: BakeWorkerResponse) => Promise<void>,
  createInitRequest?: () => BakeWorkerRequest
): Promise<void> {
  const concurrency = Math.min(getWorkerConcurrency(), jobs.length);
  let nextJobIndex = 0;
  let nextRequestId = 1;
  const workers = Array.from({ length: concurrency }, () => createBakeWorker());

  try {
    await Promise.all(workers.map((worker) => new Promise<void>((resolveWorker, rejectWorker) => {
      const runNext = (): void => {
        const job = jobs[nextJobIndex];
        nextJobIndex += 1;
        if (!job) {
          resolveWorker();
          return;
        }
        const id = nextRequestId;
        nextRequestId += 1;
        void Promise.resolve(createRequest(job, id)).then((request) => {
          const transfers = request.type === 'downsample-lod-tile' ? request.children : [];
          worker.postMessage(request, transfers);
        }, rejectWorker);
      };

      worker.onmessage = (event: MessageEvent<BakeWorkerResponse | BakeWorkerError>) => {
        const response = event.data;
        if ('error' in response) {
          rejectWorker(new Error(response.error));
          return;
        }
        void handleResult(response).then(runNext, rejectWorker);
      };
      worker.onerror = (event) => {
        rejectWorker(new Error(event.message));
      };
      const initRequest = createInitRequest?.();
      if (initRequest) worker.postMessage(initRequest);
      runNext();
    })));
  } finally {
    for (const worker of workers) {
      worker.terminate();
    }
  }
}

function getDirtyAncestors(dirtyTiles: TileKey[], fullTilesPerSide: number): TileKey[] {
  const unique = new Map<string, TileKey>();
  for (const tile of dirtyTiles) {
    for (const ancestor of ancestorsForDirtyTile(tile, fullTilesPerSide)) {
      unique.set(tileKeyToId(ancestor), ancestor);
    }
  }
  return [...unique.values()].sort((a, b) => a.d - b.d || a.y - b.y || a.x - b.x);
}

function createBakeWorker(): Worker {
  return new Worker(new URL('./bakeWorker.ts', import.meta.url), { type: 'module' });
}

function canUseBakeWorkers(): boolean {
  return typeof Worker !== 'undefined';
}

function getWorkerConcurrency(): number {
  const hardwareConcurrency = typeof navigator === 'undefined' ? 4 : navigator.hardwareConcurrency;
  return Math.max(1, Math.min(8, Math.max(1, hardwareConcurrency - 1)));
}
