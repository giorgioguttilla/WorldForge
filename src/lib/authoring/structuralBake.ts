import { downsample2x2Children } from '../heightmap/lodBuilder';
import { ancestorsForDirtyTile, childTileKeys, tileKeyToId, type TileKey } from '../heightmap/tileKey';
import type { WorldConfig } from '../heightmap/worldConfig';
import type { AuthoringDocumentV1, BakeMetadataV1 } from './authoringDocument';
import { elevationToR16, evaluateStructuralHeight, stableAuthoringHash } from './geometry';

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
      type: 'bake-depth-zero-tile';
      config: WorldConfig;
      document: AuthoringDocumentV1;
      waterLevel: number;
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
  onProgress?: (progress: BakeProgress) => void
): Promise<StructuralBakeResult> {
  const startedAt = new Date().toISOString();
  const tileCount = config.tilesPerSide * config.tilesPerSide;

  const depthZeroPass: BakePass<DepthZeroPassResult> = {
    id: 'depth-zero-structural',
    run: () => runDepthZeroStructuralPass(config, document, waterLevel, io, onProgress)
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
  const samples = new Uint16Array(config.tileSize * config.tileSize);
  const worldSize = config.tileSize * config.tilesPerSide * config.unitSize;
  for (let sampleY = 0; sampleY < config.tileSize; sampleY += 1) {
    for (let sampleX = 0; sampleX < config.tileSize; sampleX += 1) {
      const globalX = tileX * config.tileSize + sampleX;
      const globalY = tileY * config.tileSize + sampleY;
      const worldX = globalX * config.unitSize - worldSize / 2;
      const worldZ = globalY * config.unitSize - worldSize / 2;
      const { elevation } = evaluateStructuralHeight(config, document, worldX, worldZ, waterLevel);
      samples[sampleY * config.tileSize + sampleX] = elevationToR16(elevation, config.worldHeight);
    }
  }
  return samples;
}

async function runDepthZeroStructuralPass(
  config: WorldConfig,
  document: AuthoringDocumentV1,
  waterLevel: number,
  io: BakeTileIO,
  onProgress?: (progress: BakeProgress) => void
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
    for (const job of jobs) {
      const key = { x: job.x, y: job.y, d: 0 };
      await io.writeTile(key, bakeDepthZeroTile(config, document, waterLevel, job.x, job.y));
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
      config,
      document,
      waterLevel,
      tileX: job.x,
      tileY: job.y
    }),
    async ({ key, samples }) => {
      await io.writeTile(key, new Uint16Array(samples));
      dirtyTiles.push(key);
      written += 1;
      onProgress?.({ phase: 'baking', current: written, total, label: `Baking structural tiles ${written} / ${total}` });
    }
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
  handleResult: (result: BakeWorkerResponse) => Promise<void>
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
