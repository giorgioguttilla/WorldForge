import type { HydrologyBakeSummaryV1, HydrologyBasinSummaryV1 } from './authoringDocument';
import type { TileKey } from '../heightmap/tileKey';
import type { WorldConfig } from '../heightmap/worldConfig';

export interface HydrologyTileIO {
  readTile(key: TileKey): Promise<Uint16Array>;
  writeLakeFillHeightTile?(key: TileKey, samples: Uint16Array): Promise<void>;
}

export interface HydrologyProgress {
  phase: 'hydrology';
  current: number;
  total: number;
  label: string;
}

export interface HydrologyBakeResult {
  summary: HydrologyBakeSummaryV1;
}

export interface LocalBasinSolveResult {
  tileX: number;
  tileY: number;
  labelCount: number;
  edges: Uint32Array;
  edgeWeights: Uint16Array;
  northLabels: Uint32Array;
  northHeights: Uint16Array;
  southLabels: Uint32Array;
  southHeights: Uint16Array;
  westLabels: Uint32Array;
  westHeights: Uint16Array;
  eastLabels: Uint32Array;
  eastHeights: Uint16Array;
}

export interface MaterializeBasinResult {
  tileX: number;
  tileY: number;
  lakeFillHeights: ArrayBuffer;
  basinIds: Uint32Array;
  areaCells: Uint32Array;
  minTerrain: Uint16Array;
  maxDepth: Uint16Array;
  volumeCellHeight: Float64Array;
  lakeCellCount: number;
  maxTileDepth: number;
  tileVolumeCellHeight: number;
}

interface TileJob {
  x: number;
  y: number;
}

interface TileAnalysis {
  key: TileKey;
  labelOffset: number;
  labelCount: number;
  edges: Uint32Array;
  edgeWeights: Uint16Array;
  northLabels: Uint32Array;
  northHeights: Uint16Array;
  southLabels: Uint32Array;
  southHeights: Uint16Array;
  westLabels: Uint32Array;
  westHeights: Uint16Array;
  eastLabels: Uint32Array;
  eastHeights: Uint16Array;
}

interface BasinAccumulator {
  areaCells: number;
  minTerrain: number;
  maxDepth: number;
  volumeCellHeight: number;
}

const OCEAN_NODE = 0;
const UINT16_MAX = 65535;

export async function runHydrologyBasinBake(
  config: WorldConfig,
  io: HydrologyTileIO,
  onProgress?: (progress: HydrologyProgress) => void,
  options: { useWorkers?: boolean } = {}
): Promise<HydrologyBakeResult> {
  const jobs = createTileJobs(config);
  const analyses = new Array<TileAnalysis>(jobs.length);
  let completed = 0;
  const total = jobs.length * 2 + 1;
  const useWorkers = options.useWorkers !== false && canUseHydrologyWorkers() && jobs.length > 1;

  await runHydrologyWorkerPool(
    jobs,
    async (job, id) => {
      const heights = await io.readTile({ x: job.x, y: job.y, d: 0 });
      const request: HydrologyWorkerRequest = {
        id,
        type: 'hydrology-analyze-tile',
        tileX: job.x,
        tileY: job.y,
        tileSize: config.tileSize,
        heights: heights.buffer.slice(heights.byteOffset, heights.byteOffset + heights.byteLength)
      };
      return request;
    },
    async (response) => {
      const result = response as HydrologyAnalyzeResponse;
      const key = { x: result.tileX, y: result.tileY, d: 0 };
      const index = tileIndex(config, result.tileX, result.tileY);
      analyses[index] = {
        key,
        labelOffset: 0,
        labelCount: result.labelCount,
        edges: new Uint32Array(result.edges),
        edgeWeights: new Uint16Array(result.edgeWeights),
        northLabels: new Uint32Array(result.northLabels),
        northHeights: new Uint16Array(result.northHeights),
        southLabels: new Uint32Array(result.southLabels),
        southHeights: new Uint16Array(result.southHeights),
        westLabels: new Uint32Array(result.westLabels),
        westHeights: new Uint16Array(result.westHeights),
        eastLabels: new Uint32Array(result.eastLabels),
        eastHeights: new Uint16Array(result.eastHeights)
      };
      completed += 1;
      onProgress?.({ phase: 'hydrology', current: completed, total, label: `Analyzing basins ${completed} / ${jobs.length}` });
    },
    useWorkers,
    (request) => {
      const typed = request as Extract<HydrologyWorkerRequest, { type: 'hydrology-analyze-tile' }>;
      return analyzeHydrologyTile(typed.tileX, typed.tileY, typed.tileSize, new Uint16Array(typed.heights));
    }
  );

  let nextLabelOffset = 1;
  for (const analysis of analyses) {
    analysis.labelOffset = nextLabelOffset;
    nextLabelOffset += analysis.labelCount;
  }

  const graph = buildGlobalGraph(config, analyses, nextLabelOffset);
  const globalFillHeights = solveGraphFillHeights(graph.nodeCount, graph.from, graph.to, graph.weight);
  completed += 1;
  onProgress?.({ phase: 'hydrology', current: completed, total, label: 'Resolving global basin spill heights' });

  const basinStats = new Map<number, BasinAccumulator>();
  let lakeCellCount = 0;
  let maxDepth = 0;
  let volumeCellHeight = 0;

  await runHydrologyWorkerPool(
    jobs,
    async (job, id) => {
      const analysis = analyses[tileIndex(config, job.x, job.y)];
      const heights = await io.readTile({ x: job.x, y: job.y, d: 0 });
      const fills = globalFillHeights.slice(analysis.labelOffset, analysis.labelOffset + analysis.labelCount);
      return {
        id,
        type: 'hydrology-materialize-tile',
        tileX: job.x,
        tileY: job.y,
        tileSize: config.tileSize,
        labelOffset: analysis.labelOffset,
        heights: heights.buffer.slice(heights.byteOffset, heights.byteOffset + heights.byteLength),
        globalFillHeights: fills.buffer
      } satisfies HydrologyWorkerRequest;
    },
    async (response) => {
      const result = response as HydrologyMaterializeResponse;
      const key = { x: result.tileX, y: result.tileY, d: 0 };
      if (io.writeLakeFillHeightTile) await io.writeLakeFillHeightTile(key, new Uint16Array(result.lakeFillHeights));
      const basinIds = new Uint32Array(result.basinIds);
      const areaCells = new Uint32Array(result.areaCells);
      const minTerrain = new Uint16Array(result.minTerrain);
      const maxDepths = new Uint16Array(result.maxDepth);
      const volumes = new Float64Array(result.volumeCellHeight);
      for (let i = 0; i < basinIds.length; i += 1) {
        const id = basinIds[i];
        let accumulator = basinStats.get(id);
        if (!accumulator) {
          accumulator = { areaCells: 0, minTerrain: UINT16_MAX, maxDepth: 0, volumeCellHeight: 0 };
          basinStats.set(id, accumulator);
        }
        accumulator.areaCells += areaCells[i];
        accumulator.minTerrain = Math.min(accumulator.minTerrain, minTerrain[i]);
        accumulator.maxDepth = Math.max(accumulator.maxDepth, maxDepths[i]);
        accumulator.volumeCellHeight += volumes[i];
      }
      lakeCellCount += result.lakeCellCount;
      maxDepth = Math.max(maxDepth, result.maxTileDepth);
      volumeCellHeight += result.tileVolumeCellHeight;
      completed += 1;
      onProgress?.({ phase: 'hydrology', current: completed, total, label: `Writing lake fill heights ${completed - jobs.length - 1} / ${jobs.length}` });
    },
    useWorkers,
    (request) => {
      const typed = request as Extract<HydrologyWorkerRequest, { type: 'hydrology-materialize-tile' }>;
      return materializeHydrologyTile(
        typed.tileX,
        typed.tileY,
        typed.tileSize,
        typed.labelOffset,
        new Uint16Array(typed.heights),
        new Uint16Array(typed.globalFillHeights)
      );
    }
  );

  analyses.length = 0;

  const basins = [...basinStats.entries()]
    .map(([id, stats]): HydrologyBasinSummaryV1 => ({
      id,
      fillHeight: globalFillHeights[id],
      minTerrainHeight: stats.minTerrain,
      maxDepth: stats.maxDepth,
      areaCells: stats.areaCells,
      volumeCellHeight: stats.volumeCellHeight,
      touchesOcean: graph.oceanLabels.has(id)
    }))
    .sort((a, b) => b.areaCells - a.areaCells)
    .slice(0, 256);

  return {
    summary: {
      enabled: true,
      epsilonR16: 1,
      tileCount: jobs.length,
      basinCount: basinStats.size,
      lakeCellCount,
      maxDepth,
      volumeCellHeight,
      lakeFillHeight: 'closed-basin-fill-height-r16',
      basins,
      warnings: []
    }
  };
}

export function analyzeHydrologyTile(tileX: number, tileY: number, tileSize: number, heights: Uint16Array): LocalBasinSolveResult {
  const solved = solveLocalTile(tileSize, heights);
  const edgeMap = new Map<number, number>();
  const edgeScale = solved.labelCount + 1;
  const addEdge = (a: number, b: number, weight: number): void => {
    if (a === b) return;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const key = lo * edgeScale + hi;
    const previous = edgeMap.get(key);
    if (previous === undefined || weight < previous) edgeMap.set(key, weight);
  };

  for (let y = 0; y < tileSize; y += 1) {
    for (let x = 0; x < tileSize; x += 1) {
      const index = y * tileSize + x;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= tileSize || ny >= tileSize) continue;
          const neighborIndex = ny * tileSize + nx;
          if (neighborIndex <= index) continue;
          addEdge(solved.labels[index], solved.labels[neighborIndex], Math.max(solved.filled[index], solved.filled[neighborIndex]));
        }
      }
    }
  }

  const edges = new Uint32Array(edgeMap.size * 2);
  const edgeWeights = new Uint16Array(edgeMap.size);
  let edgeIndex = 0;
  for (const [key, weight] of edgeMap) {
    edges[edgeIndex * 2] = Math.floor(key / edgeScale);
    edges[edgeIndex * 2 + 1] = key % edgeScale;
    edgeWeights[edgeIndex] = weight;
    edgeIndex += 1;
  }

  return {
    tileX,
    tileY,
    labelCount: solved.labelCount,
    edges,
    edgeWeights,
    northLabels: copyLabels(solved.labels, tileSize, 0, 1),
    northHeights: copyHeights(solved.filled, tileSize, 0, 1),
    southLabels: copyLabels(solved.labels, tileSize, (tileSize - 1) * tileSize, 1),
    southHeights: copyHeights(solved.filled, tileSize, (tileSize - 1) * tileSize, 1),
    westLabels: copyLabels(solved.labels, tileSize, 0, tileSize),
    westHeights: copyHeights(solved.filled, tileSize, 0, tileSize),
    eastLabels: copyLabels(solved.labels, tileSize, tileSize - 1, tileSize),
    eastHeights: copyHeights(solved.filled, tileSize, tileSize - 1, tileSize)
  };
}

export function materializeHydrologyTile(
  tileX: number,
  tileY: number,
  tileSize: number,
  labelOffset: number,
  heights: Uint16Array,
  globalFillHeights: Uint16Array
): MaterializeBasinResult {
  const solved = solveLocalTile(tileSize, heights);
  const lakeFillHeights = new Uint16Array(heights.length);
  const stats = new Map<number, BasinAccumulator>();
  let lakeCellCount = 0;
  let maxTileDepth = 0;
  let tileVolumeCellHeight = 0;

  for (let i = 0; i < heights.length; i += 1) {
    const localLabel = solved.labels[i];
    const globalFill = globalFillHeights[localLabel - 1] ?? 0;
    const fill = Math.max(solved.filled[i], globalFill);
    const depth = fill - heights[i];
    if (depth >= 1) {
      lakeFillHeights[i] = fill;
      lakeCellCount += 1;
      maxTileDepth = Math.max(maxTileDepth, depth);
      tileVolumeCellHeight += depth;
      const basinId = labelOffset + localLabel - 1;
      let accumulator = stats.get(basinId);
      if (!accumulator) {
        accumulator = { areaCells: 0, minTerrain: UINT16_MAX, maxDepth: 0, volumeCellHeight: 0 };
        stats.set(basinId, accumulator);
      }
      accumulator.areaCells += 1;
      accumulator.minTerrain = Math.min(accumulator.minTerrain, heights[i]);
      accumulator.maxDepth = Math.max(accumulator.maxDepth, depth);
      accumulator.volumeCellHeight += depth;
    }
  }

  const basinIds = new Uint32Array(stats.size);
  const areaCells = new Uint32Array(stats.size);
  const minTerrain = new Uint16Array(stats.size);
  const maxDepth = new Uint16Array(stats.size);
  const volumeCellHeight = new Float64Array(stats.size);
  let index = 0;
  for (const [id, accumulator] of stats) {
    basinIds[index] = id;
    areaCells[index] = accumulator.areaCells;
    minTerrain[index] = accumulator.minTerrain;
    maxDepth[index] = accumulator.maxDepth;
    volumeCellHeight[index] = accumulator.volumeCellHeight;
    index += 1;
  }

  return {
    tileX,
    tileY,
    lakeFillHeights: lakeFillHeights.buffer,
    basinIds,
    areaCells,
    minTerrain,
    maxDepth,
    volumeCellHeight,
    lakeCellCount,
    maxTileDepth,
    tileVolumeCellHeight
  };
}

type HydrologyAnalyzeResponse = {
  id: number;
  type: 'hydrology-analyze-result';
  tileX: number;
  tileY: number;
  labelCount: number;
  edges: ArrayBuffer;
  edgeWeights: ArrayBuffer;
  northLabels: ArrayBuffer;
  northHeights: ArrayBuffer;
  southLabels: ArrayBuffer;
  southHeights: ArrayBuffer;
  westLabels: ArrayBuffer;
  westHeights: ArrayBuffer;
  eastLabels: ArrayBuffer;
  eastHeights: ArrayBuffer;
};

type HydrologyMaterializeResponse = {
  id: number;
  type: 'hydrology-materialize-result';
  tileX: number;
  tileY: number;
  lakeFillHeights: ArrayBuffer;
  basinIds: ArrayBuffer;
  areaCells: ArrayBuffer;
  minTerrain: ArrayBuffer;
  maxDepth: ArrayBuffer;
  volumeCellHeight: ArrayBuffer;
  lakeCellCount: number;
  maxTileDepth: number;
  tileVolumeCellHeight: number;
};

export type HydrologyWorkerResponse = HydrologyAnalyzeResponse | HydrologyMaterializeResponse;

export type HydrologyWorkerRequest =
  | {
      id: number;
      type: 'hydrology-analyze-tile';
      tileX: number;
      tileY: number;
      tileSize: number;
      heights: ArrayBuffer;
    }
  | {
      id: number;
      type: 'hydrology-materialize-tile';
      tileX: number;
      tileY: number;
      tileSize: number;
      labelOffset: number;
      heights: ArrayBuffer;
      globalFillHeights: ArrayBuffer;
    };

export function createHydrologyWorkerResponse(request: HydrologyWorkerRequest): { response: HydrologyWorkerResponse; transfers: Transferable[] } {
  if (request.type === 'hydrology-analyze-tile') {
    const result = analyzeHydrologyTile(request.tileX, request.tileY, request.tileSize, new Uint16Array(request.heights));
    const response: HydrologyAnalyzeResponse = {
      id: request.id,
      type: 'hydrology-analyze-result',
      tileX: result.tileX,
      tileY: result.tileY,
      labelCount: result.labelCount,
      edges: result.edges.buffer,
      edgeWeights: result.edgeWeights.buffer,
      northLabels: result.northLabels.buffer,
      northHeights: result.northHeights.buffer,
      southLabels: result.southLabels.buffer,
      southHeights: result.southHeights.buffer,
      westLabels: result.westLabels.buffer,
      westHeights: result.westHeights.buffer,
      eastLabels: result.eastLabels.buffer,
      eastHeights: result.eastHeights.buffer
    };
    return { response, transfers: Object.values(response).filter((value): value is ArrayBuffer => value instanceof ArrayBuffer) };
  }

  const result = materializeHydrologyTile(
    request.tileX,
    request.tileY,
    request.tileSize,
    request.labelOffset,
    new Uint16Array(request.heights),
    new Uint16Array(request.globalFillHeights)
  );
  const response: HydrologyMaterializeResponse = {
    id: request.id,
    type: 'hydrology-materialize-result',
    tileX: result.tileX,
    tileY: result.tileY,
    lakeFillHeights: result.lakeFillHeights,
    basinIds: result.basinIds.buffer,
    areaCells: result.areaCells.buffer,
    minTerrain: result.minTerrain.buffer,
    maxDepth: result.maxDepth.buffer,
    volumeCellHeight: result.volumeCellHeight.buffer,
    lakeCellCount: result.lakeCellCount,
    maxTileDepth: result.maxTileDepth,
    tileVolumeCellHeight: result.tileVolumeCellHeight
  };
  return { response, transfers: Object.values(response).filter((value): value is ArrayBuffer => value instanceof ArrayBuffer) };
}

async function runHydrologyWorkerPool(
  jobs: TileJob[],
  createRequest: (job: TileJob, id: number) => Promise<HydrologyWorkerRequest>,
  handleResult: (response: HydrologyWorkerResponse) => Promise<void>,
  useWorkers: boolean,
  runInline: (request: HydrologyWorkerRequest) => LocalBasinSolveResult | MaterializeBasinResult
): Promise<void> {
  if (!useWorkers) {
    let id = 1;
    for (const job of jobs) {
      const request = await createRequest(job, id);
      id += 1;
      const result = runInline(request);
      if ('labelCount' in result) {
        await handleResult({
          id: request.id,
          type: 'hydrology-analyze-result',
          tileX: result.tileX,
          tileY: result.tileY,
          labelCount: result.labelCount,
          edges: result.edges.buffer,
          edgeWeights: result.edgeWeights.buffer,
          northLabels: result.northLabels.buffer,
          northHeights: result.northHeights.buffer,
          southLabels: result.southLabels.buffer,
          southHeights: result.southHeights.buffer,
          westLabels: result.westLabels.buffer,
          westHeights: result.westHeights.buffer,
          eastLabels: result.eastLabels.buffer,
          eastHeights: result.eastHeights.buffer
        });
      } else {
        await handleResult({
          id: request.id,
          type: 'hydrology-materialize-result',
          tileX: result.tileX,
          tileY: result.tileY,
          lakeFillHeights: result.lakeFillHeights,
          basinIds: result.basinIds.buffer,
          areaCells: result.areaCells.buffer,
          minTerrain: result.minTerrain.buffer,
          maxDepth: result.maxDepth.buffer,
          volumeCellHeight: result.volumeCellHeight.buffer,
          lakeCellCount: result.lakeCellCount,
          maxTileDepth: result.maxTileDepth,
          tileVolumeCellHeight: result.tileVolumeCellHeight
        });
      }
    }
    return;
  }

  const concurrency = Math.min(getHydrologyWorkerConcurrency(), jobs.length);
  let nextJobIndex = 0;
  let nextRequestId = 1;
  const workers = Array.from({ length: concurrency }, () => new Worker(new URL('./bakeWorker.ts', import.meta.url), { type: 'module' }));
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
        void createRequest(job, id).then((request) => {
          const transfers = request.type === 'hydrology-analyze-tile'
            ? [request.heights]
            : [request.heights, request.globalFillHeights];
          worker.postMessage(request, transfers);
        }, rejectWorker);
      };
      worker.onmessage = (event: MessageEvent<HydrologyWorkerResponse | { id: number; error: string }>) => {
        const response = event.data;
        if ('error' in response) {
          rejectWorker(new Error(response.error));
          return;
        }
        void handleResult(response).then(runNext, rejectWorker);
      };
      worker.onerror = (event) => rejectWorker(new Error(event.message));
      runNext();
    })));
  } finally {
    for (const worker of workers) worker.terminate();
  }
}

function solveLocalTile(tileSize: number, heights: Uint16Array): { filled: Uint16Array; labels: Uint32Array; labelCount: number } {
  const sampleCount = heights.length;
  const filled = new Uint16Array(heights);
  const labels = new Uint32Array(sampleCount);
  const closed = new Uint8Array(sampleCount);
  const open = new R16BucketQueue(sampleCount);
  const pit = new Uint32Array(sampleCount);
  let pitHead = 0;
  let pitTail = 0;
  let labelCount = 0;

  const seed = (index: number): void => {
    if (closed[index]) return;
    closed[index] = 1;
    labelCount += 1;
    labels[index] = labelCount;
    open.push(index, filled[index]);
  };

  for (let x = 0; x < tileSize; x += 1) {
    seed(x);
    seed((tileSize - 1) * tileSize + x);
  }
  for (let y = 1; y < tileSize - 1; y += 1) {
    seed(y * tileSize);
    seed(y * tileSize + tileSize - 1);
  }

  const visitNeighbor = (current: number, neighbor: number): void => {
    if (closed[neighbor]) return;
    closed[neighbor] = 1;
    labels[neighbor] = labels[current];
    if (filled[neighbor] <= filled[current]) {
      filled[neighbor] = filled[current];
      pit[pitTail] = neighbor;
      pitTail += 1;
    } else {
      open.push(neighbor, filled[neighbor]);
    }
  };

  while (pitHead < pitTail || open.length > 0) {
    const current = pitHead < pitTail ? pit[pitHead++] : open.pop();
    const x = current % tileSize;
    const y = Math.floor(current / tileSize);
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= tileSize || ny >= tileSize) continue;
        visitNeighbor(current, ny * tileSize + nx);
      }
    }
  }

  return { filled, labels, labelCount };
}

class R16BucketQueue {
  private readonly heads = new Int32Array(UINT16_MAX + 1);
  private readonly tails = new Int32Array(UINT16_MAX + 1);
  private readonly next: Int32Array;
  private cursor = 0;
  private count = 0;

  constructor(capacity: number) {
    this.heads.fill(-1);
    this.tails.fill(-1);
    this.next = new Int32Array(capacity);
    this.next.fill(-1);
  }

  get length(): number {
    return this.count;
  }

  push(index: number, priority: number): void {
    this.next[index] = -1;
    if (this.heads[priority] === -1) {
      this.heads[priority] = index;
      this.tails[priority] = index;
    } else {
      this.next[this.tails[priority]] = index;
      this.tails[priority] = index;
    }
    if (priority < this.cursor) this.cursor = priority;
    this.count += 1;
  }

  pop(): number {
    while (this.cursor <= UINT16_MAX && this.heads[this.cursor] === -1) this.cursor += 1;
    const index = this.heads[this.cursor];
    if (index === -1) throw new Error('Bucket queue is empty.');
    const next = this.next[index];
    this.heads[this.cursor] = next;
    if (next === -1) this.tails[this.cursor] = -1;
    this.count -= 1;
    return index;
  }
}

function buildGlobalGraph(config: WorldConfig, analyses: TileAnalysis[], nodeCount: number): {
  nodeCount: number;
  from: Uint32Array;
  to: Uint32Array;
  weight: Uint16Array;
  oceanLabels: Set<number>;
} {
  const edgeMap = new Map<number, number>();
  const oceanLabels = new Set<number>();
  const addEdge = (a: number, b: number, weight: number): void => {
    if (a === b) return;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const key = lo * nodeCount + hi;
    const previous = edgeMap.get(key);
    if (previous === undefined || weight < previous) edgeMap.set(key, weight);
  };
  const globalLabel = (analysis: TileAnalysis, localLabel: number): number => analysis.labelOffset + localLabel - 1;

  for (const analysis of analyses) {
    for (let i = 0; i < analysis.edgeWeights.length; i += 1) {
      addEdge(globalLabel(analysis, analysis.edges[i * 2]), globalLabel(analysis, analysis.edges[i * 2 + 1]), analysis.edgeWeights[i]);
    }
    if (analysis.key.y === 0) {
      for (let i = 0; i < analysis.northLabels.length; i += 1) {
        const id = globalLabel(analysis, analysis.northLabels[i]);
        oceanLabels.add(id);
        addEdge(OCEAN_NODE, id, analysis.northHeights[i]);
      }
    }
    if (analysis.key.y === config.tilesPerSide - 1) {
      for (let i = 0; i < analysis.southLabels.length; i += 1) {
        const id = globalLabel(analysis, analysis.southLabels[i]);
        oceanLabels.add(id);
        addEdge(OCEAN_NODE, id, analysis.southHeights[i]);
      }
    }
    if (analysis.key.x === 0) {
      for (let i = 0; i < analysis.westLabels.length; i += 1) {
        const id = globalLabel(analysis, analysis.westLabels[i]);
        oceanLabels.add(id);
        addEdge(OCEAN_NODE, id, analysis.westHeights[i]);
      }
    }
    if (analysis.key.x === config.tilesPerSide - 1) {
      for (let i = 0; i < analysis.eastLabels.length; i += 1) {
        const id = globalLabel(analysis, analysis.eastLabels[i]);
        oceanLabels.add(id);
        addEdge(OCEAN_NODE, id, analysis.eastHeights[i]);
      }
    }
  }

  for (let y = 0; y < config.tilesPerSide; y += 1) {
    for (let x = 0; x < config.tilesPerSide; x += 1) {
      const analysis = analyses[tileIndex(config, x, y)];
      if (x + 1 < config.tilesPerSide) {
        const east = analyses[tileIndex(config, x + 1, y)];
        for (let i = 0; i < config.tileSize; i += 1) {
          addEdge(
            globalLabel(analysis, analysis.eastLabels[i]),
            globalLabel(east, east.westLabels[i]),
            Math.max(analysis.eastHeights[i], east.westHeights[i])
          );
        }
      }
      if (y + 1 < config.tilesPerSide) {
        const south = analyses[tileIndex(config, x, y + 1)];
        for (let i = 0; i < config.tileSize; i += 1) {
          addEdge(
            globalLabel(analysis, analysis.southLabels[i]),
            globalLabel(south, south.northLabels[i]),
            Math.max(analysis.southHeights[i], south.northHeights[i])
          );
        }
      }
    }
  }

  const from = new Uint32Array(edgeMap.size);
  const to = new Uint32Array(edgeMap.size);
  const weight = new Uint16Array(edgeMap.size);
  let index = 0;
  for (const [key, value] of edgeMap) {
    from[index] = Math.floor(key / nodeCount);
    to[index] = key % nodeCount;
    weight[index] = value;
    index += 1;
  }
  return { nodeCount, from, to, weight, oceanLabels };
}

function solveGraphFillHeights(nodeCount: number, from: Uint32Array, to: Uint32Array, weight: Uint16Array): Uint16Array {
  const degree = new Uint32Array(nodeCount);
  for (let i = 0; i < from.length; i += 1) {
    degree[from[i]] += 1;
    degree[to[i]] += 1;
  }
  const offsets = new Uint32Array(nodeCount + 1);
  for (let i = 0; i < nodeCount; i += 1) offsets[i + 1] = offsets[i] + degree[i];
  const cursor = new Uint32Array(offsets);
  const adjacency = new Uint32Array(offsets[nodeCount]);
  const weights = new Uint16Array(offsets[nodeCount]);
  for (let i = 0; i < from.length; i += 1) {
    let slot = cursor[from[i]];
    adjacency[slot] = to[i];
    weights[slot] = weight[i];
    cursor[from[i]] += 1;
    slot = cursor[to[i]];
    adjacency[slot] = from[i];
    weights[slot] = weight[i];
    cursor[to[i]] += 1;
  }

  const fills = new Uint16Array(nodeCount);
  fills.fill(UINT16_MAX);
  fills[OCEAN_NODE] = 0;
  const heap = new MinHeap();
  heap.push(OCEAN_NODE, 0);
  while (heap.length > 0) {
    const node = heap.pop();
    const base = fills[node];
    for (let i = offsets[node]; i < offsets[node + 1]; i += 1) {
      const neighbor = adjacency[i];
      const candidate = Math.max(base, weights[i]);
      if (candidate < fills[neighbor]) {
        fills[neighbor] = candidate;
        heap.push(neighbor, candidate);
      }
    }
  }
  return fills;
}

function copyLabels(labels: Uint32Array, tileSize: number, start: number, stride: number): Uint32Array {
  const output = new Uint32Array(tileSize);
  for (let i = 0; i < tileSize; i += 1) output[i] = labels[start + i * stride];
  return output;
}

function copyHeights(heights: Uint16Array, tileSize: number, start: number, stride: number): Uint16Array {
  const output = new Uint16Array(tileSize);
  for (let i = 0; i < tileSize; i += 1) output[i] = heights[start + i * stride];
  return output;
}

function createTileJobs(config: WorldConfig): TileJob[] {
  const jobs: TileJob[] = [];
  for (let y = 0; y < config.tilesPerSide; y += 1) {
    for (let x = 0; x < config.tilesPerSide; x += 1) jobs.push({ x, y });
  }
  return jobs;
}

function tileIndex(config: WorldConfig, x: number, y: number): number {
  return y * config.tilesPerSide + x;
}

function canUseHydrologyWorkers(): boolean {
  return typeof Worker !== 'undefined';
}

function getHydrologyWorkerConcurrency(): number {
  const hardwareConcurrency = typeof navigator === 'undefined' ? 4 : navigator.hardwareConcurrency;
  const memoryBound = 4;
  return Math.max(1, Math.min(memoryBound, Math.max(1, hardwareConcurrency - 1)));
}

class MinHeap {
  private readonly nodes: number[] = [];
  private readonly priorities: number[] = [];

  get length(): number {
    return this.nodes.length;
  }

  push(node: number, priority: number): void {
    let index = this.nodes.length;
    this.nodes.push(node);
    this.priorities.push(priority);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.priorities[parent] <= priority) break;
      this.nodes[index] = this.nodes[parent];
      this.priorities[index] = this.priorities[parent];
      index = parent;
    }
    this.nodes[index] = node;
    this.priorities[index] = priority;
  }

  pop(): number {
    const result = this.nodes[0];
    const node = this.nodes.pop();
    const priority = this.priorities.pop();
    if (node === undefined || priority === undefined || this.nodes.length === 0) return result;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      if (left >= this.nodes.length) break;
      const child = right < this.nodes.length && this.priorities[right] < this.priorities[left] ? right : left;
      if (this.priorities[child] >= priority) break;
      this.nodes[index] = this.nodes[child];
      this.priorities[index] = this.priorities[child];
      index = child;
    }
    this.nodes[index] = node;
    this.priorities[index] = priority;
    return result;
  }
}
