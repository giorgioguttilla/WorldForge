import type { HydrologyBakeSummaryV1, HydrologyBasinSummaryV1 } from './authoringDocument';
import type { TileKey } from '../heightmap/tileKey';
import type { WorldConfig } from '../heightmap/worldConfig';

export interface HydrologyTileIO {
  readTile(key: TileKey): Promise<Uint16Array>;
  writeLakeFillHeightTile?(key: TileKey, samples: Uint16Array): Promise<void>;
  readLakeFillHeightTile?(key: TileKey): Promise<Uint16Array | null>;
  writeDrainageSurfaceTile?(key: TileKey, samples: Uint16Array): Promise<void>;
  readDrainageSurfaceTile?(key: TileKey): Promise<Uint16Array | null>;
  writeBasinIdTile?(key: TileKey, samples: Uint32Array): Promise<void>;
  readBasinIdTile?(key: TileKey): Promise<Uint32Array | null>;
  writeFlatDistanceTile?(key: TileKey, samples: Uint32Array): Promise<void>;
  readFlatDistanceTile?(key: TileKey): Promise<Uint32Array | null>;
  writeReceiverDirectionTile?(key: TileKey, samples: Uint16Array): Promise<void>;
  readReceiverDirectionTile?(key: TileKey): Promise<Uint16Array | null>;
  writeFlowStrengthTile?(key: TileKey, samples: Uint16Array): Promise<void>;
  writeFlowAccumulationTile?(key: TileKey, samples: Float32Array): Promise<void>;
  readFlowAccumulationTile?(key: TileKey): Promise<Float32Array | null>;
  writeHydrologyTopology?(topology: HydrologyTopologyV2): Promise<void>;
}

export interface HydrologyTopologyV2 {
  version: 2;
  width: number;
  height: number;
  nodeCount: number;
  receiverEncoding: 'd-infinity-angle-u16-turn65528';
  /** Compact parallel arrays; basinIds maps each array slot to its durable physical basin ID. */
  basinIds: Uint32Array;
  fillHeights: Uint16Array;
  downstreamIds: Uint32Array;
  spillCells: Uint32Array;
  downstreamCells: Uint32Array;
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
  edgeCellsA: Uint32Array;
  edgeCellsB: Uint32Array;
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
  drainageSurface: ArrayBuffer;
  flatDistances: ArrayBuffer;
  basinIds: Uint32Array;
  areaCells: Uint32Array;
  minTerrain: Uint16Array;
  maxDepth: Uint16Array;
  volumeCellHeight: Float64Array;
  minGlobalX: Uint32Array;
  minGlobalY: Uint32Array;
  maxGlobalX: Uint32Array;
  maxGlobalY: Uint32Array;
  lakeCellCount: number;
  maxTileDepth: number;
  tileVolumeCellHeight: number;
}

export interface FlowTileAnalysisResult {
  tileX: number;
  tileY: number;
  baseTargetCells: Uint32Array;
  baseFlows: Float64Array;
  transferFromCells: Uint32Array;
  transferToCells: Uint32Array;
}

export interface FlowTileMaxResult {
  tileX: number;
  tileY: number;
  maxFlowAccumulation: number;
  flowAccumulation: ArrayBuffer;
}

export interface MaterializeFlowResult {
  tileX: number;
  tileY: number;
  flowStrength: ArrayBuffer;
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
  edgeCellsA: Uint32Array;
  edgeCellsB: Uint32Array;
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
  minGlobalX: number;
  minGlobalY: number;
  maxGlobalX: number;
  maxGlobalY: number;
}

const OCEAN_NODE = 0;
const UINT16_MAX = 65535;
const NO_FLOW_TARGET = 0xffffffff;
export async function runHydrologyBasinBake(
  config: WorldConfig,
  io: HydrologyTileIO,
  onProgress?: (progress: HydrologyProgress) => void,
  options: { useWorkers?: boolean } = {}
): Promise<HydrologyBakeResult> {
  const jobs = createTileJobs(config);
  const analyses = new Array<TileAnalysis>(jobs.length);
  let completed = 0;
  const total = jobs.length * 5 + 2;
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
        edgeCellsA: new Uint32Array(result.edgeCellsA),
        edgeCellsB: new Uint32Array(result.edgeCellsB),
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
    useWorkers
  );

  let nextLabelOffset = 1;
  for (const analysis of analyses) {
    analysis.labelOffset = nextLabelOffset;
    nextLabelOffset += analysis.labelCount;
  }

  const graph = buildGlobalGraph(config, analyses, nextLabelOffset);
  const graphSolution = solveGraphFillHeights(graph.nodeCount, graph.from, graph.to, graph.weight);
  const globalFillHeights = graphSolution.fills;
  const usePhysicalTopology = Boolean(io.readBasinIdTile && io.readReceiverDirectionTile);
  let outletCells: Uint32Array | null = null;
  let solverDownstreamCells: Uint32Array | null = null;
  if (!usePhysicalTopology) {
    outletCells = new Uint32Array(graph.nodeCount);
    solverDownstreamCells = new Uint32Array(graph.nodeCount);
    outletCells.fill(NO_FLOW_TARGET);
    solverDownstreamCells.fill(NO_FLOW_TARGET);
    for (let node = 1; node < graph.nodeCount; node += 1) {
      const edge = graphSolution.parentEdge[node];
      if (edge === NO_FLOW_TARGET) continue;
      if (graph.from[edge] === node) {
        outletCells[node] = graph.cellFrom[edge];
        solverDownstreamCells[node] = graphSolution.parentNode[node] === OCEAN_NODE ? NO_FLOW_TARGET : graph.cellTo[edge];
      } else {
        outletCells[node] = graph.cellTo[edge];
        solverDownstreamCells[node] = graphSolution.parentNode[node] === OCEAN_NODE ? NO_FLOW_TARGET : graph.cellFrom[edge];
      }
    }
  }
  completed += 1;
  onProgress?.({ phase: 'hydrology', current: completed, total, label: 'Resolving global basin spill heights' });

  const basinStats = new Map<number, BasinAccumulator>();
  const drainageSurfaceBoundaries = new HydrologyTileBoundaryIndex(Uint16Array, config.tileSize);
  const flatDistanceBoundaries = new HydrologyTileBoundaryIndex(Uint32Array, config.tileSize);
  const computeFlatDistances = Boolean(io.readDrainageSurfaceTile && io.writeFlatDistanceTile && io.readFlatDistanceTile && io.writeReceiverDirectionTile);
  const collectFallbackBasinStats = !(io.readLakeFillHeightTile && io.writeBasinIdTile && io.readBasinIdTile);
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
        tilesPerSide: config.tilesPerSide,
        labelOffset: analysis.labelOffset,
        computeFlatDistances,
        collectBasinStats: collectFallbackBasinStats,
        heights: heights.buffer.slice(heights.byteOffset, heights.byteOffset + heights.byteLength),
        globalFillHeights: fills.buffer
      } satisfies HydrologyWorkerRequest;
    },
    async (response) => {
      const result = response as HydrologyMaterializeResponse;
      const key = { x: result.tileX, y: result.tileY, d: 0 };
      const drainageSurface = new Uint16Array(result.drainageSurface);
      drainageSurfaceBoundaries.set(result.tileX, result.tileY, drainageSurface);
      const flatDistances = new Uint32Array(result.flatDistances);
      if (flatDistances.length > 0) flatDistanceBoundaries.set(result.tileX, result.tileY, flatDistances);
      await Promise.all([
        io.writeLakeFillHeightTile?.(key, new Uint16Array(result.lakeFillHeights)),
        io.writeDrainageSurfaceTile?.(key, drainageSurface),
        flatDistances.length > 0 ? io.writeFlatDistanceTile?.(key, flatDistances) : undefined
      ]);
      if (collectFallbackBasinStats) {
        const basinIds = new Uint32Array(result.basinIds);
        const areaCells = new Uint32Array(result.areaCells);
        const minTerrain = new Uint16Array(result.minTerrain);
        const maxDepths = new Uint16Array(result.maxDepth);
        const volumes = new Float64Array(result.volumeCellHeight);
        const minGlobalX = new Uint32Array(result.minGlobalX);
        const minGlobalY = new Uint32Array(result.minGlobalY);
        const maxGlobalX = new Uint32Array(result.maxGlobalX);
        const maxGlobalY = new Uint32Array(result.maxGlobalY);
        for (let i = 0; i < basinIds.length; i += 1) {
          const id = basinIds[i];
          let accumulator = basinStats.get(id);
          if (!accumulator) {
            accumulator = {
              areaCells: 0, minTerrain: UINT16_MAX, maxDepth: 0, volumeCellHeight: 0,
              minGlobalX: Number.POSITIVE_INFINITY, minGlobalY: Number.POSITIVE_INFINITY, maxGlobalX: 0, maxGlobalY: 0
            };
            basinStats.set(id, accumulator);
          }
          accumulator.areaCells += areaCells[i];
          accumulator.minTerrain = Math.min(accumulator.minTerrain, minTerrain[i]);
          accumulator.maxDepth = Math.max(accumulator.maxDepth, maxDepths[i]);
          accumulator.volumeCellHeight += volumes[i];
          accumulator.minGlobalX = Math.min(accumulator.minGlobalX, minGlobalX[i]);
          accumulator.minGlobalY = Math.min(accumulator.minGlobalY, minGlobalY[i]);
          accumulator.maxGlobalX = Math.max(accumulator.maxGlobalX, maxGlobalX[i]);
          accumulator.maxGlobalY = Math.max(accumulator.maxGlobalY, maxGlobalY[i]);
        }
      }
      lakeCellCount += result.lakeCellCount;
      maxDepth = Math.max(maxDepth, result.maxTileDepth);
      volumeCellHeight += result.tileVolumeCellHeight;
      completed += 1;
      onProgress?.({ phase: 'hydrology', current: completed, total, label: `Materializing fill and local drainage ${completed - jobs.length - 1} / ${jobs.length}` });
    },
    useWorkers
  );

  let solverTopology: HydrologyTopologyV2 | null = null;
  if (!usePhysicalTopology && outletCells && solverDownstreamCells) {
    const downstreamIds = new Uint32Array(graph.nodeCount);
    downstreamIds.fill(NO_FLOW_TARGET);
    for (let id = 1; id < graph.nodeCount; id += 1) downstreamIds[id] = graphSolution.parentNode[id];
    solverTopology = {
      version: 2,
      width: config.tileSize * config.tilesPerSide,
      height: config.tileSize * config.tilesPerSide,
      nodeCount: graph.nodeCount,
      receiverEncoding: 'd-infinity-angle-u16-turn65528',
      basinIds: Uint32Array.from({ length: graph.nodeCount }, (_, id) => id),
      fillHeights: globalFillHeights,
      downstreamIds,
      spillCells: outletCells,
      downstreamCells: solverDownstreamCells
    };
  }
  analyses.length = 0;

  const physicalBasinStats = io.readLakeFillHeightTile && io.writeBasinIdTile && io.readBasinIdTile
    ? await buildPhysicalBasinIds(config, io, jobs, useWorkers, (label) => onProgress?.({ phase: 'hydrology', current: completed, total, label }))
    : new Map([...basinStats].map(([id, stats]) => [id, { ...stats, fillHeight: globalFillHeights[id] }]));
  if (io.readDrainageSurfaceTile && io.writeFlatDistanceTile && io.readFlatDistanceTile && io.writeReceiverDirectionTile) {
    await buildGlobalConditionedReceivers(
      config,
      io,
      jobs,
      useWorkers,
      drainageSurfaceBoundaries,
      flatDistanceBoundaries,
      (label) => onProgress?.({ phase: 'hydrology', current: completed, total, label })
    );
  }
  const topology = usePhysicalTopology
    ? await buildPhysicalHydrologyTopology(config, io, jobs, physicalBasinStats)
    : solverTopology as HydrologyTopologyV2;
  await io.writeHydrologyTopology?.(topology);

  const flowResult = await runFlowStrengthBake(config, io, jobs, useWorkers, completed, total, onProgress);
  completed = flowResult.completed;

  const basins = [...physicalBasinStats.entries()]
    .map(([id, stats]): HydrologyBasinSummaryV1 => ({
      id,
      fillHeight: stats.fillHeight,
      minTerrainHeight: stats.minTerrain,
      maxDepth: stats.maxDepth,
      areaCells: stats.areaCells,
      volumeCellHeight: stats.volumeCellHeight,
      touchesOcean: false
    }))
    .sort((a, b) => b.areaCells - a.areaCells)
    .slice(0, 256);
  return {
    summary: {
      enabled: true,
      epsilonR16: 1,
      tileCount: jobs.length,
      basinCount: physicalBasinStats.size,
      lakeCellCount,
      maxDepth,
      volumeCellHeight,
      lakeFillHeight: 'closed-basin-fill-height-r16',
      basinIds: 'physical-filled-basin-id-u32',
      receiverDirections: 'conditioned-flat-resolved-d-infinity-u16',
      topology: 'physical-basin-topology-v2',
      flowStrength: flowResult.enabled ? 'log1p-contributing-area-r16' : undefined,
      flowAccumulation: flowResult.enabled ? 'contributing-area-f32' : undefined,
      maxFlowAccumulation: flowResult.enabled ? flowResult.maxFlowAccumulation : undefined,
      flowTileCount: flowResult.enabled ? jobs.length : undefined,
      basins,
      warnings: []
    }
  };
}

export function analyzeHydrologyTile(tileX: number, tileY: number, tileSize: number, heights: Uint16Array): LocalBasinSolveResult {
  const solved = solveLocalTile(tileSize, heights);
  const edgeMap = new Map<number, { weight: number; cellA: number; cellB: number }>();
  const edgeScale = solved.labelCount + 1;
  const addEdge = (a: number, b: number, weight: number, cellA: number, cellB: number): void => {
    if (a === b) return;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const key = lo * edgeScale + hi;
    const previous = edgeMap.get(key);
    const orderedA = a === lo ? cellA : cellB;
    const orderedB = a === lo ? cellB : cellA;
    if (!previous || weight < previous.weight || (weight === previous.weight && orderedA < previous.cellA)) {
      edgeMap.set(key, { weight, cellA: orderedA, cellB: orderedB });
    }
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
          addEdge(solved.labels[index], solved.labels[neighborIndex], Math.max(solved.filled[index], solved.filled[neighborIndex]), index, neighborIndex);
        }
      }
    }
  }

  const edges = new Uint32Array(edgeMap.size * 2);
  const edgeWeights = new Uint16Array(edgeMap.size);
  const edgeCellsA = new Uint32Array(edgeMap.size);
  const edgeCellsB = new Uint32Array(edgeMap.size);
  let edgeIndex = 0;
  for (const [key, edge] of edgeMap) {
    edges[edgeIndex * 2] = Math.floor(key / edgeScale);
    edges[edgeIndex * 2 + 1] = key % edgeScale;
    edgeWeights[edgeIndex] = edge.weight;
    edgeCellsA[edgeIndex] = edge.cellA;
    edgeCellsB[edgeIndex] = edge.cellB;
    edgeIndex += 1;
  }

  return {
    tileX,
    tileY,
    labelCount: solved.labelCount,
    edges,
    edgeWeights,
    edgeCellsA,
    edgeCellsB,
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
  tilesPerSide: number,
  labelOffset: number,
  heights: Uint16Array,
  globalFillHeights: Uint16Array,
  computeFlatDistances: boolean,
  collectBasinStats: boolean
): MaterializeBasinResult {
  const solved = solveLocalTile(tileSize, heights);
  const lakeFillHeights = new Uint16Array(heights.length);
  const drainageSurface = new Uint16Array(heights.length);
  const stats = new Map<number, BasinAccumulator>();
  let lakeCellCount = 0;
  let maxTileDepth = 0;
  let tileVolumeCellHeight = 0;

  for (let i = 0; i < heights.length; i += 1) {
    const localLabel = solved.labels[i];
    const globalFill = globalFillHeights[localLabel - 1] ?? 0;
    const fill = Math.max(solved.filled[i], globalFill);
    drainageSurface[i] = fill;
    const depth = fill - heights[i];
    if (depth >= 1) {
      lakeFillHeights[i] = fill;
      lakeCellCount += 1;
      maxTileDepth = Math.max(maxTileDepth, depth);
      tileVolumeCellHeight += depth;
      if (collectBasinStats) {
        const basinId = labelOffset + localLabel - 1;
        let accumulator = stats.get(basinId);
        if (!accumulator) {
          accumulator = {
            areaCells: 0,
            minTerrain: UINT16_MAX,
            maxDepth: 0,
            volumeCellHeight: 0,
            minGlobalX: Number.POSITIVE_INFINITY,
            minGlobalY: Number.POSITIVE_INFINITY,
            maxGlobalX: 0,
            maxGlobalY: 0
          };
          stats.set(basinId, accumulator);
        }
        const globalX = tileX * tileSize + (i % tileSize);
        const globalY = tileY * tileSize + Math.floor(i / tileSize);
        accumulator.areaCells += 1;
        accumulator.minTerrain = Math.min(accumulator.minTerrain, heights[i]);
        accumulator.maxDepth = Math.max(accumulator.maxDepth, depth);
        accumulator.volumeCellHeight += depth;
        accumulator.minGlobalX = Math.min(accumulator.minGlobalX, globalX);
        accumulator.minGlobalY = Math.min(accumulator.minGlobalY, globalY);
        accumulator.maxGlobalX = Math.max(accumulator.maxGlobalX, globalX);
        accumulator.maxGlobalY = Math.max(accumulator.maxGlobalY, globalY);
      }
    }
  }

  const basinIds = new Uint32Array(stats.size);
  const areaCells = new Uint32Array(stats.size);
  const minTerrain = new Uint16Array(stats.size);
  const maxDepth = new Uint16Array(stats.size);
  const volumeCellHeight = new Float64Array(stats.size);
  const minGlobalX = new Uint32Array(stats.size);
  const minGlobalY = new Uint32Array(stats.size);
  const maxGlobalX = new Uint32Array(stats.size);
  const maxGlobalY = new Uint32Array(stats.size);
  let index = 0;
  for (const [id, accumulator] of stats) {
    basinIds[index] = id;
    areaCells[index] = accumulator.areaCells;
    minTerrain[index] = accumulator.minTerrain;
    maxDepth[index] = accumulator.maxDepth;
    volumeCellHeight[index] = accumulator.volumeCellHeight;
    minGlobalX[index] = Number.isFinite(accumulator.minGlobalX) ? accumulator.minGlobalX : 0;
    minGlobalY[index] = Number.isFinite(accumulator.minGlobalY) ? accumulator.minGlobalY : 0;
    maxGlobalX[index] = accumulator.maxGlobalX;
    maxGlobalY[index] = accumulator.maxGlobalY;
    index += 1;
  }
  const flatDistances = computeFlatDistances
    ? initializeLocalFlatDistances(tileSize, tilesPerSide, tileX, tileY, drainageSurface, solved.labels)
    : new Uint32Array(0);

  return {
    tileX,
    tileY,
    lakeFillHeights: lakeFillHeights.buffer,
    drainageSurface: drainageSurface.buffer,
    flatDistances: flatDistances.buffer,
    basinIds,
    areaCells,
    minTerrain,
    maxDepth,
    volumeCellHeight,
    minGlobalX,
    minGlobalY,
    maxGlobalX,
    maxGlobalY,
    lakeCellCount,
    maxTileDepth,
    tileVolumeCellHeight
  };
}

const D8_DX = new Int8Array([0, 1, 0, 1, -1, 0, -1, 1, -1]);
const D8_DY = new Int8Array([0, 0, 1, 1, 0, -1, -1, -1, 1]);
const DINF_NO_FLOW = 0xffff;
const DINF_TURN_STEPS = 65528;
const DINF_SECTOR_STEPS = DINF_TURN_STEPS / 8;
const DINF_CODES = new Uint8Array([1, 3, 2, 8, 4, 6, 5, 7]);
const TWO_PI = Math.PI * 2;
const DINF_SECTOR_LOOKUP = new Uint8Array(DINF_TURN_STEPS);
const DINF_WEIGHT_B_LOOKUP = new Float64Array(DINF_TURN_STEPS);
for (let encoded = 0; encoded < DINF_TURN_STEPS; encoded += 1) {
  const sector = Math.floor(encoded / DINF_SECTOR_STEPS) & 7;
  DINF_SECTOR_LOOKUP[encoded] = sector;
  DINF_WEIGHT_B_LOOKUP[encoded] = (encoded - sector * DINF_SECTOR_STEPS) / DINF_SECTOR_STEPS;
}

interface PhysicalBasinAccumulator extends BasinAccumulator {
  fillHeight: number;
}

async function buildPhysicalBasinIds(
  config: WorldConfig,
  io: HydrologyTileIO,
  jobs: TileJob[],
  useWorkers: boolean,
  onStatus?: (label: string) => void
): Promise<Map<number, PhysicalBasinAccumulator>> {
  if (!io.readLakeFillHeightTile || !io.writeBasinIdTile || !io.readBasinIdTile) {
    throw new Error('Physical basin labeling requires lake-fill and basin-id tile storage.');
  }
  const fillCache = new HydrologyTileCache<Uint16Array>(12, (x, y) => requireHydrologyTile(io.readLakeFillHeightTile?.({ x, y, d: 0 }), 'lake fill', x, y));
  const labelCache = new HydrologyTileCache<Uint32Array>(12, (x, y) => requireHydrologyTile(io.readBasinIdTile?.({ x, y, d: 0 }), 'basin id', x, y));
  const components = new NumericDisjointSet();

  let labeled = 0;
  await runHydrologyWorkerPool(
    jobs,
    async (job, id) => {
      const fills = await requireHydrologyTile(io.readLakeFillHeightTile?.({ x: job.x, y: job.y, d: 0 }), 'lake fill', job.x, job.y);
      return {
        id,
        type: 'hydrology-label-lake-components-tile',
        tileX: job.x,
        tileY: job.y,
        tileSize: config.tileSize,
        tilesPerSide: config.tilesPerSide,
        lakeFillHeights: fills.buffer.slice(fills.byteOffset, fills.byteOffset + fills.byteLength)
      } satisfies HydrologyWorkerRequest;
    },
    async (response) => {
      if (response.type !== 'hydrology-label-lake-components-result') throw new Error(`Unexpected hydrology response ${response.type}`);
      const labels = new Uint32Array(response.labels);
      for (const id of new Uint32Array(response.componentIds)) components.add(id);
      await io.writeBasinIdTile?.({ x: response.tileX, y: response.tileY, d: 0 }, labels);
      labelCache.set(response.tileX, response.tileY, labels);
      labeled += 1;
      onStatus?.(`Labeling physical basins ${labeled} / ${jobs.length}`);
    },
    useWorkers
  );

  for (let jobIndex = 0; jobIndex < jobs.length; jobIndex += 1) {
    const job = jobs[jobIndex];
    onStatus?.(`Joining basin boundaries ${jobIndex + 1} / ${jobs.length}`);
    const [fills, labels] = await Promise.all([fillCache.read(job.x, job.y), labelCache.read(job.x, job.y)]);
    if (job.x + 1 < config.tilesPerSide) {
      const [eastFills, eastLabels] = await Promise.all([fillCache.read(job.x + 1, job.y), labelCache.read(job.x + 1, job.y)]);
      for (let y = 0; y < config.tileSize; y += 1) {
        const cell = y * config.tileSize + config.tileSize - 1;
        for (let offset = -1; offset <= 1; offset += 1) {
          const ey = y + offset;
          if (ey < 0 || ey >= config.tileSize) continue;
          unionMatchingLakeCells(fills, labels, cell, eastFills, eastLabels, ey * config.tileSize, components);
        }
      }
    }
    if (job.y + 1 < config.tilesPerSide) {
      const [southFills, southLabels] = await Promise.all([fillCache.read(job.x, job.y + 1), labelCache.read(job.x, job.y + 1)]);
      for (let x = 0; x < config.tileSize; x += 1) {
        const cell = (config.tileSize - 1) * config.tileSize + x;
        for (let offset = -1; offset <= 1; offset += 1) {
          const sx = x + offset;
          if (sx < 0 || sx >= config.tileSize) continue;
          unionMatchingLakeCells(fills, labels, cell, southFills, southLabels, sx, components);
        }
      }
    }
    if (job.x + 1 < config.tilesPerSide && job.y + 1 < config.tilesPerSide) {
      const [diagonalFills, diagonalLabels] = await Promise.all([fillCache.read(job.x + 1, job.y + 1), labelCache.read(job.x + 1, job.y + 1)]);
      unionMatchingLakeCells(
        fills, labels, config.tileSize * config.tileSize - 1,
        diagonalFills, diagonalLabels, 0,
        components
      );
    }
    if (job.x > 0 && job.y + 1 < config.tilesPerSide) {
      const [diagonalFills, diagonalLabels] = await Promise.all([fillCache.read(job.x - 1, job.y + 1), labelCache.read(job.x - 1, job.y + 1)]);
      unionMatchingLakeCells(
        fills, labels, (config.tileSize - 1) * config.tileSize,
        diagonalFills, diagonalLabels, config.tileSize - 1,
        components
      );
    }
  }

  for (let jobIndex = 0; jobIndex < jobs.length; jobIndex += 1) {
    const job = jobs[jobIndex];
    onStatus?.(`Writing physical basin IDs ${jobIndex + 1} / ${jobs.length}`);
    const labels = await labelCache.read(job.x, job.y);
    const merged = new Uint32Array(labels.length);
    let changed = false;
    for (let i = 0; i < labels.length; i += 1) {
      merged[i] = labels[i] === 0 ? 0 : components.find(labels[i]);
      changed ||= merged[i] !== labels[i];
    }
    if (changed) {
      await io.writeBasinIdTile({ x: job.x, y: job.y, d: 0 }, merged);
      labelCache.set(job.x, job.y, merged);
    }
  }

  const stats = new Map<number, PhysicalBasinAccumulator>();
  let measured = 0;
  await runHydrologyWorkerPool(
    jobs,
    async (job, id) => {
      const [fills, labels, terrain] = await Promise.all([
        requireHydrologyTile(io.readLakeFillHeightTile?.({ x: job.x, y: job.y, d: 0 }), 'lake fill', job.x, job.y),
        requireHydrologyTile(io.readBasinIdTile?.({ x: job.x, y: job.y, d: 0 }), 'basin id', job.x, job.y),
        io.readTile({ x: job.x, y: job.y, d: 0 })
      ]);
      return {
        id,
        type: 'hydrology-measure-physical-basins-tile',
        tileX: job.x,
        tileY: job.y,
        tileSize: config.tileSize,
        lakeFillHeights: fills.buffer.slice(fills.byteOffset, fills.byteOffset + fills.byteLength),
        basinIds: labels.buffer.slice(labels.byteOffset, labels.byteOffset + labels.byteLength),
        terrain: terrain.buffer.slice(terrain.byteOffset, terrain.byteOffset + terrain.byteLength)
      } satisfies HydrologyWorkerRequest;
    },
    async (response) => {
      if (response.type !== 'hydrology-measure-physical-basins-result') throw new Error(`Unexpected hydrology response ${response.type}`);
      const basinIds = new Uint32Array(response.basinIds);
      const fillHeights = new Uint16Array(response.fillHeights);
      const areaCells = new Uint32Array(response.areaCells);
      const minTerrain = new Uint16Array(response.minTerrain);
      const maxDepth = new Uint16Array(response.maxDepth);
      const volumeCellHeight = new Float64Array(response.volumeCellHeight);
      const minGlobalX = new Uint32Array(response.minGlobalX);
      const minGlobalY = new Uint32Array(response.minGlobalY);
      const maxGlobalX = new Uint32Array(response.maxGlobalX);
      const maxGlobalY = new Uint32Array(response.maxGlobalY);
      for (let i = 0; i < basinIds.length; i += 1) {
        const basinId = basinIds[i];
        let accumulator = stats.get(basinId);
        if (!accumulator) {
          accumulator = {
            fillHeight: fillHeights[i], areaCells: 0, minTerrain: UINT16_MAX, maxDepth: 0, volumeCellHeight: 0,
            minGlobalX: Number.POSITIVE_INFINITY, minGlobalY: Number.POSITIVE_INFINITY, maxGlobalX: 0, maxGlobalY: 0
          };
          stats.set(basinId, accumulator);
        }
        accumulator.areaCells += areaCells[i];
        accumulator.minTerrain = Math.min(accumulator.minTerrain, minTerrain[i]);
        accumulator.maxDepth = Math.max(accumulator.maxDepth, maxDepth[i]);
        accumulator.volumeCellHeight += volumeCellHeight[i];
        accumulator.minGlobalX = Math.min(accumulator.minGlobalX, minGlobalX[i]);
        accumulator.minGlobalY = Math.min(accumulator.minGlobalY, minGlobalY[i]);
        accumulator.maxGlobalX = Math.max(accumulator.maxGlobalX, maxGlobalX[i]);
        accumulator.maxGlobalY = Math.max(accumulator.maxGlobalY, maxGlobalY[i]);
      }
      measured += 1;
      onStatus?.(`Measuring physical basins ${measured} / ${jobs.length}`);
    },
    useWorkers
  );
  return stats;
}

function measurePhysicalBasinsTile(
  tileX: number,
  tileY: number,
  tileSize: number,
  fills: Uint16Array,
  labels: Uint32Array,
  terrain: Uint16Array
): {
  basinIds: Uint32Array;
  fillHeights: Uint16Array;
  areaCells: Uint32Array;
  minTerrain: Uint16Array;
  maxDepth: Uint16Array;
  volumeCellHeight: Float64Array;
  minGlobalX: Uint32Array;
  minGlobalY: Uint32Array;
  maxGlobalX: Uint32Array;
  maxGlobalY: Uint32Array;
} {
  const stats = new Map<number, PhysicalBasinAccumulator>();
  for (let i = 0; i < labels.length; i += 1) {
    const id = labels[i];
    if (id === 0) continue;
    let accumulator = stats.get(id);
    if (!accumulator) {
      accumulator = {
        fillHeight: fills[i], areaCells: 0, minTerrain: UINT16_MAX, maxDepth: 0, volumeCellHeight: 0,
        minGlobalX: Number.POSITIVE_INFINITY, minGlobalY: Number.POSITIVE_INFINITY, maxGlobalX: 0, maxGlobalY: 0
      };
      stats.set(id, accumulator);
    }
    const x = tileX * tileSize + i % tileSize;
    const y = tileY * tileSize + Math.floor(i / tileSize);
    const depth = Math.max(0, fills[i] - terrain[i]);
    accumulator.areaCells += 1;
    accumulator.minTerrain = Math.min(accumulator.minTerrain, terrain[i]);
    accumulator.maxDepth = Math.max(accumulator.maxDepth, depth);
    accumulator.volumeCellHeight += depth;
    accumulator.minGlobalX = Math.min(accumulator.minGlobalX, x);
    accumulator.minGlobalY = Math.min(accumulator.minGlobalY, y);
    accumulator.maxGlobalX = Math.max(accumulator.maxGlobalX, x);
    accumulator.maxGlobalY = Math.max(accumulator.maxGlobalY, y);
  }
  const basinIds = Uint32Array.from(stats.keys());
  const fillHeights = new Uint16Array(stats.size);
  const areaCells = new Uint32Array(stats.size);
  const minTerrain = new Uint16Array(stats.size);
  const maxDepth = new Uint16Array(stats.size);
  const volumeCellHeight = new Float64Array(stats.size);
  const minGlobalX = new Uint32Array(stats.size);
  const minGlobalY = new Uint32Array(stats.size);
  const maxGlobalX = new Uint32Array(stats.size);
  const maxGlobalY = new Uint32Array(stats.size);
  let index = 0;
  for (const accumulator of stats.values()) {
    fillHeights[index] = accumulator.fillHeight;
    areaCells[index] = accumulator.areaCells;
    minTerrain[index] = accumulator.minTerrain;
    maxDepth[index] = accumulator.maxDepth;
    volumeCellHeight[index] = accumulator.volumeCellHeight;
    minGlobalX[index] = accumulator.minGlobalX;
    minGlobalY[index] = accumulator.minGlobalY;
    maxGlobalX[index] = accumulator.maxGlobalX;
    maxGlobalY[index] = accumulator.maxGlobalY;
    index += 1;
  }
  return { basinIds, fillHeights, areaCells, minTerrain, maxDepth, volumeCellHeight, minGlobalX, minGlobalY, maxGlobalX, maxGlobalY };
}

function unionMatchingLakeCells(
  fillsA: Uint16Array,
  labelsA: Uint32Array,
  cellA: number,
  fillsB: Uint16Array,
  labelsB: Uint32Array,
  cellB: number,
  components: NumericDisjointSet
): void {
  if (fillsA[cellA] !== 0 && fillsA[cellA] === fillsB[cellB]) components.union(labelsA[cellA], labelsB[cellB]);
}

function labelLocalLakeComponents(tileSize: number, tilesPerSide: number, tileX: number, tileY: number, fills: Uint16Array): { labels: Uint32Array; componentIds: Uint32Array } {
  const size = tileSize;
  const fullSide = size * tilesPerSide;
  const labels = new Uint32Array(fills.length);
  const queue = new Uint32Array(fills.length);
  const componentIds: number[] = [];
  for (let seed = 0; seed < fills.length; seed += 1) {
    if (fills[seed] === 0 || labels[seed] !== 0) continue;
    let head = 0;
    let tail = 1;
    queue[0] = seed;
    labels[seed] = NO_FLOW_TARGET;
    let minimum = (tileY * size + Math.floor(seed / size)) * fullSide + tileX * size + seed % size + 1;
    while (head < tail) {
      const current = queue[head++];
      const x = current % size;
      const y = Math.floor(current / size);
      minimum = Math.min(minimum, (tileY * size + y) * fullSide + tileX * size + x + 1);
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
          const neighbor = ny * size + nx;
          if (labels[neighbor] === 0 && fills[neighbor] === fills[seed]) {
            labels[neighbor] = NO_FLOW_TARGET;
            queue[tail++] = neighbor;
          }
        }
      }
    }
    for (let i = 0; i < tail; i += 1) labels[queue[i]] = minimum;
    componentIds.push(minimum);
  }
  return { labels, componentIds: Uint32Array.from(componentIds) };
}

async function buildGlobalConditionedReceivers(
  config: WorldConfig,
  io: HydrologyTileIO,
  jobs: TileJob[],
  useWorkers: boolean,
  surfaceBoundaries: HydrologyTileBoundaryIndex<Uint16Array>,
  distanceBoundaries: HydrologyTileBoundaryIndex<Uint32Array>,
  onStatus?: (label: string) => void
): Promise<void> {
  if (!io.readDrainageSurfaceTile || !io.writeFlatDistanceTile || !io.readFlatDistanceTile || !io.writeReceiverDirectionTile) {
    throw new Error('Global flat routing requires drainage-surface, flat-distance, and receiver tile storage.');
  }
  const surfaceCache = new HydrologyTileCache<Uint16Array>(12, (x, y) => (
    requireHydrologyTile(io.readDrainageSurfaceTile?.({ x, y, d: 0 }), 'drainage surface', x, y)
  ));
  const distanceCache = new HydrologyWriteBackTileCache<Uint32Array>(
    12,
    (x, y) => requireHydrologyTile(io.readFlatDistanceTile?.({ x, y, d: 0 }), 'flat distance', x, y),
    (x, y, distances) => io.writeFlatDistanceTile?.({ x, y, d: 0 }, distances) ?? Promise.resolve()
  );

  await convergeFlatTileQueue(config, jobs, (tileX, tileY) => (
    getFlatRelaxationPriority(config, tileX, tileY, surfaceBoundaries, distanceBoundaries)
  ), async (job) => {
    const surface = await surfaceCache.read(job.x, job.y);
    const distances = await distanceCache.read(job.x, job.y);
    const result = relaxFlatDistances(config, job.x, job.y, surface, distances, surfaceBoundaries, distanceBoundaries);
    if (!result) return 0;
    await distanceCache.setDirty(job.x, job.y, result.distances);
    distanceBoundaries.set(job.x, job.y, result.distances);
    return result.changedNeighborMask;
  }, (current, queued) => onStatus?.(`Resolving flats across tiles ${current} / ${queued}`));
  await distanceCache.flush();

  let receiversWritten = 0;
  await runHydrologyWorkerPool(
    jobs,
    async (job, id) => {
      const [surface, distances] = await Promise.all([
        surfaceCache.read(job.x, job.y),
        distanceCache.read(job.x, job.y)
      ]);
      return {
        id,
        type: 'hydrology-materialize-receivers-tile',
        tileX: job.x,
        tileY: job.y,
        tileSize: config.tileSize,
        tilesPerSide: config.tilesPerSide,
        surfaceHalo: surfaceBoundaries.createHalo(job.x, job.y, surface).buffer,
        distanceHalo: distanceBoundaries.createHalo(job.x, job.y, distances).buffer
      } satisfies HydrologyWorkerRequest;
    },
    async (response) => {
      if (response.type !== 'hydrology-materialize-receivers-result') throw new Error(`Unexpected hydrology response ${response.type}`);
      await io.writeReceiverDirectionTile?.(
        { x: response.tileX, y: response.tileY, d: 0 },
        new Uint16Array(response.receiverDirections)
      );
      receiversWritten += 1;
      onStatus?.(`Writing seamless receivers ${receiversWritten} / ${jobs.length}`);
    },
    useWorkers
  );
}

async function buildPhysicalHydrologyTopology(
  config: WorldConfig,
  io: HydrologyTileIO,
  jobs: TileJob[],
  stats: Map<number, PhysicalBasinAccumulator>
): Promise<HydrologyTopologyV2> {
  const ids = Uint32Array.from([...stats.keys()].sort((a, b) => a - b));
  const idToIndex = new Map<number, number>();
  for (let i = 0; i < ids.length; i += 1) idToIndex.set(ids[i], i);
  const fillHeights = new Uint16Array(ids.length);
  const downstreamIds = new Uint32Array(ids.length);
  const spillCells = new Uint32Array(ids.length);
  const downstreamCells = new Uint32Array(ids.length);
  spillCells.fill(NO_FLOW_TARGET);
  downstreamCells.fill(NO_FLOW_TARGET);
  for (let i = 0; i < ids.length; i += 1) fillHeights[i] = stats.get(ids[i])?.fillHeight ?? 0;
  if (!io.readBasinIdTile || !io.readReceiverDirectionTile) {
    return {
      version: 2,
      width: config.tileSize * config.tilesPerSide,
      height: config.tileSize * config.tilesPerSide,
      nodeCount: ids.length,
      receiverEncoding: 'd-infinity-angle-u16-turn65528',
      basinIds: ids,
      fillHeights,
      downstreamIds,
      spillCells,
      downstreamCells
    };
  }
  const basinCache = new HydrologyTileCache<Uint32Array>(12, (x, y) => requireHydrologyTile(io.readBasinIdTile?.({ x, y, d: 0 }), 'basin id', x, y));
  const receiverCache = new HydrologyTileCache<Uint16Array>(12, (x, y) => requireHydrologyTile(io.readReceiverDirectionTile?.({ x, y, d: 0 }), 'receiver', x, y));
  const fullSide = config.tileSize * config.tilesPerSide;
  for (const job of jobs) {
    const [basins, receivers, basinHalo] = await Promise.all([
      basinCache.read(job.x, job.y),
      receiverCache.read(job.x, job.y),
      readCachedHalo(config, job.x, job.y, basinCache, Uint32Array)
    ]);
    const size = config.tileSize;
    const stride = size + 2;
    for (let cell = 0; cell < basins.length; cell += 1) {
      const basinId = basins[cell];
      if (basinId === 0) continue;
      const code = dominantDInfinityCode(receivers[cell]);
      if (code === 0) continue;
      const x = cell % size;
      const y = Math.floor(cell / size);
      const downstreamId = basinHalo[(y + 1 + D8_DY[code]) * stride + x + 1 + D8_DX[code]];
      if (downstreamId === basinId) continue;
      const index = idToIndex.get(basinId);
      if (index === undefined) continue;
      const globalX = job.x * size + x;
      const globalY = job.y * size + y;
      const spillCell = globalY * fullSide + globalX;
      if (spillCell >= spillCells[index]) continue;
      spillCells[index] = spillCell;
      downstreamIds[index] = downstreamId;
      downstreamCells[index] = (globalY + D8_DY[code]) * fullSide + globalX + D8_DX[code];
    }
  }
  return {
    version: 2,
    width: fullSide,
    height: fullSide,
    nodeCount: ids.length,
    receiverEncoding: 'd-infinity-angle-u16-turn65528',
    basinIds: ids,
    fillHeights,
    downstreamIds,
    spillCells,
    downstreamCells
  };
}

function initializeLocalFlatDistances(
  tileSize: number,
  tilesPerSide: number,
  tileX: number,
  tileY: number,
  surface: Uint16Array,
  queue: Uint32Array
): Uint32Array {
  const size = tileSize;
  const fullSide = size * tilesPerSide;
  const distances = new Uint32Array(size * size);
  distances.fill(NO_FLOW_TARGET);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const gx = tileX * size + x;
      const gy = tileY * size + y;
      if (gx === 0 || gy === 0 || gx === fullSide - 1 || gy === fullSide - 1) {
        distances[y * size + x] = 0;
        continue;
      }
      const current = surface[y * size + x];
      for (let code = 1; code <= 8; code += 1) {
        const nx = x + D8_DX[code];
        const ny = y + D8_DY[code];
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        if (surface[ny * size + nx] < current) {
          distances[y * size + x] = 0;
          break;
        }
      }
    }
  }
  let tail = 0;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const cell = y * size + x;
      if (distances[cell] !== NO_FLOW_TARGET) continue;
      for (let code = 1; code <= 8; code += 1) {
        const nx = x + D8_DX[code];
        const ny = y + D8_DY[code];
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        const neighbor = ny * size + nx;
        if (surface[neighbor] === surface[cell] && distances[neighbor] === 0) {
          distances[cell] = 1;
          queue[tail++] = cell;
          break;
        }
      }
    }
  }
  for (let head = 0; head < tail; head += 1) {
    const current = queue[head];
    const x = current % size;
    const y = Math.floor(current / size);
    const candidate = distances[current] + 1;
    for (let code = 1; code <= 8; code += 1) {
      const nx = x + D8_DX[code];
      const ny = y + D8_DY[code];
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
      const neighbor = ny * size + nx;
      if (surface[neighbor] === surface[current] && distances[neighbor] === NO_FLOW_TARGET) {
        distances[neighbor] = candidate;
        queue[tail++] = neighbor;
      }
    }
  }
  return distances;
}

function relaxFlatDistances(
  config: WorldConfig,
  tileX: number,
  tileY: number,
  surface: Uint16Array,
  distances: Uint32Array,
  surfaceBoundaries: HydrologyTileBoundaryIndex<Uint16Array>,
  distanceBoundaries: HydrologyTileBoundaryIndex<Uint32Array>
): { distances: Uint32Array; changedNeighborMask: number } | null {
  const size = config.tileSize;
  const maxBoundaryCells = Math.max(1, size * 4 - 4);
  const seedCells = new Uint32Array(maxBoundaryCells);
  const seedDistances = new Uint32Array(maxBoundaryCells);
  let seedCount = 0;
  const inspectBoundaryCell = (x: number, y: number): void => {
      const cell = y * size + x;
      const currentHeight = surface[cell];
      let best = distances[cell];
      for (let code = 1; code <= 8; code += 1) {
        const nx = x + D8_DX[code];
        const ny = y + D8_DY[code];
        if (nx >= 0 && ny >= 0 && nx < size && ny < size) continue;
        const neighborHeight = surfaceBoundaries.getOffset(tileX, tileY, nx, ny);
        const neighborDistance = distanceBoundaries.getOffset(tileX, tileY, nx, ny);
        const candidate = neighborHeight < currentHeight
          ? 0
          : neighborHeight === currentHeight && neighborDistance !== NO_FLOW_TARGET
            ? neighborDistance + 1
            : NO_FLOW_TARGET;
        if (candidate < best) best = candidate;
      }
      if (best < distances[cell]) {
        seedCells[seedCount] = cell;
        seedDistances[seedCount] = best;
        seedCount += 1;
      }
  };
  for (let x = 0; x < size; x += 1) {
    inspectBoundaryCell(x, 0);
    if (size > 1) inspectBoundaryCell(x, size - 1);
  }
  for (let y = 1; y + 1 < size; y += 1) {
    inspectBoundaryCell(0, y);
    if (size > 1) inspectBoundaryCell(size - 1, y);
  }
  if (seedCount === 0) return null;

  const queue = new Uint32Array(distances.length);
  const queued = new Uint8Array(distances.length);
  let queueHead = 0;
  let queueTail = 0;
  let queueLength = 0;
  const enqueue = (cell: number): void => {
    if (queued[cell] === 0) {
      queued[cell] = 1;
      queue[queueTail] = cell;
      queueTail = (queueTail + 1) % queue.length;
      queueLength += 1;
    }
  };
  let changedNeighborMask = 0;
  const markChangedBoundary = (cell: number): void => {
    const x = cell % size;
    const y = Math.floor(cell / size);
    if (x === size - 1) changedNeighborMask |= 1 << 1;
    if (y === size - 1) changedNeighborMask |= 1 << 2;
    if (x === size - 1 && y === size - 1) changedNeighborMask |= 1 << 3;
    if (x === 0) changedNeighborMask |= 1 << 4;
    if (y === 0) changedNeighborMask |= 1 << 5;
    if (x === 0 && y === 0) changedNeighborMask |= 1 << 6;
    if (x === size - 1 && y === 0) changedNeighborMask |= 1 << 7;
    if (x === 0 && y === size - 1) changedNeighborMask |= 1 << 8;
  };
  for (let i = 0; i < seedCount; i += 1) {
    const cell = seedCells[i];
    distances[cell] = seedDistances[i];
    markChangedBoundary(cell);
    enqueue(cell);
  }
  while (queueLength > 0) {
    const current = queue[queueHead];
    queueHead = (queueHead + 1) % queue.length;
    queueLength -= 1;
    queued[current] = 0;
    const x = current % size;
    const y = Math.floor(current / size);
    const candidate = distances[current] + 1;
    for (let code = 1; code <= 8; code += 1) {
      const nx = x + D8_DX[code];
      const ny = y + D8_DY[code];
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
      const neighbor = ny * size + nx;
      if (surface[neighbor] === surface[current] && candidate < distances[neighbor]) {
        distances[neighbor] = candidate;
        markChangedBoundary(neighbor);
        enqueue(neighbor);
      }
    }
  }
  return { distances, changedNeighborMask };
}

function materializeGlobalReceivers(
  tileSize: number,
  tilesPerSide: number,
  tileX: number,
  tileY: number,
  surfaceHalo: Uint16Array,
  distanceHalo: Uint32Array
): Uint16Array {
  const size = tileSize;
  const stride = size + 2;
  const fullSide = size * tilesPerSide;
  const output = new Uint16Array(size * size);
  output.fill(DINF_NO_FLOW);
  const worldCellCount = fullSide * fullSide;
  const flatEpsilon = 0.25 / (worldCellCount + 1);
  const potentialAt = (hx: number, hy: number): number => {
    const index = hy * stride + hx;
    const distance = distanceHalo[index];
    return surfaceHalo[index] + (distance === NO_FLOW_TARGET ? 0 : distance * flatEpsilon);
  };
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const gx = tileX * size + x;
      const gy = tileY * size + y;
      if (gx === 0 || gy === 0 || gx === fullSide - 1 || gy === fullSide - 1) continue;
      const hx = x + 1;
      const hy = y + 1;
      const current = potentialAt(hx, hy);
      let bestSlope = 0;
      let bestAngle = -1;
      for (let facet = 0; facet < 8; facet += 1) {
        const codeA = DINF_CODES[facet];
        const codeB = DINF_CODES[(facet + 1) & 7];
        const ax = D8_DX[codeA];
        const ay = D8_DY[codeA];
        const bx = D8_DX[codeB];
        const by = D8_DY[codeB];
        const za = potentialAt(hx + ax, hy + ay);
        const zb = potentialAt(hx + bx, hy + by);
        const determinant = ax * by - bx * ay;
        const da = za - current;
        const db = zb - current;
        const gradientX = (da * by - db * ay) / determinant;
        const gradientY = (ax * db - bx * da) / determinant;
        const downX = -gradientX;
        const downY = -gradientY;
        const planeSlope = Math.hypot(downX, downY);
        const startAngle = facet * Math.PI / 4;
        const planeAngle = normalizeAngle(Math.atan2(downY, downX));
        const relative = normalizeAngle(planeAngle - startAngle);
        const insideFacet = planeSlope > 0 && relative <= Math.PI / 4 + 1e-12;
        if (insideFacet) {
          const fractionB = Math.min(1, Math.max(0, relative / (Math.PI / 4)));
          const usesA = fractionB < 1 - 1e-12;
          const usesB = fractionB > 1e-12;
          if ((!usesA || za < current) && (!usesB || zb < current) && planeSlope > bestSlope) {
            bestSlope = planeSlope;
            bestAngle = planeAngle;
          }
        }
        const slopeA = (current - za) / Math.hypot(ax, ay);
        if (slopeA > bestSlope) {
          bestSlope = slopeA;
          bestAngle = startAngle;
        }
        const slopeB = (current - zb) / Math.hypot(bx, by);
        if (slopeB > bestSlope) {
          bestSlope = slopeB;
          bestAngle = normalizeAngle(startAngle + Math.PI / 4);
        }
      }
      if (bestAngle >= 0) output[y * size + x] = encodeDInfinityAngle(bestAngle);
    }
  }
  return output;
}

function normalizeAngle(angle: number): number {
  const normalized = angle % TWO_PI;
  return normalized < 0 ? normalized + TWO_PI : normalized;
}

export function encodeDInfinityAngle(angle: number): number {
  return Math.round(normalizeAngle(angle) / TWO_PI * DINF_TURN_STEPS) % DINF_TURN_STEPS;
}

export function decodeDInfinityAngle(encoded: number): number | null {
  return encoded >= DINF_TURN_STEPS ? null : encoded / DINF_TURN_STEPS * TWO_PI;
}

export function decodeDInfinityRecipients(encoded: number): { codeA: number; codeB: number; weightA: number; weightB: number } | null {
  if (encoded >= DINF_TURN_STEPS) return null;
  const sector = DINF_SECTOR_LOOKUP[encoded];
  const weightB = DINF_WEIGHT_B_LOOKUP[encoded];
  return {
    codeA: DINF_CODES[sector],
    codeB: DINF_CODES[(sector + 1) & 7],
    weightA: 1 - weightB,
    weightB
  };
}

function dominantDInfinityCode(encoded: number): number {
  const recipients = decodeDInfinityRecipients(encoded);
  if (!recipients) return 0;
  return recipients.weightB > recipients.weightA ? recipients.codeB : recipients.codeA;
}

async function convergeFlatTileQueue(
  config: WorldConfig,
  jobs: TileJob[],
  getPriority: (tileX: number, tileY: number) => number,
  relax: (job: TileJob) => Promise<number>,
  onStatus?: (current: number, queued: number) => void
): Promise<void> {
  const priorities = new Float64Array(jobs.length);
  priorities.fill(Number.POSITIVE_INFINITY);
  let queued = 0;
  for (const job of jobs) {
    const priority = getPriority(job.x, job.y);
    if (!Number.isFinite(priority)) continue;
    priorities[tileIndex(config, job.x, job.y)] = priority;
    queued += 1;
  }
  let current = 0;
  while (queued > 0) {
    let nextIndex = -1;
    let nextPriority = Number.POSITIVE_INFINITY;
    for (let i = 0; i < priorities.length; i += 1) {
      if (priorities[i] < nextPriority) {
        nextPriority = priorities[i];
        nextIndex = i;
      }
    }
    if (nextIndex < 0) break;
    priorities[nextIndex] = Number.POSITIVE_INFINITY;
    queued -= 1;
    current += 1;
    onStatus?.(current, current + queued);
    const job = jobs[nextIndex];
    const changedNeighborMask = await relax(job);
    for (let code = 1; code <= 8; code += 1) {
      if ((changedNeighborMask & (1 << code)) === 0) continue;
      const x = job.x + D8_DX[code];
      const y = job.y + D8_DY[code];
      if (x < 0 || y < 0 || x >= config.tilesPerSide || y >= config.tilesPerSide) continue;
      const index = tileIndex(config, x, y);
      const priority = getPriority(x, y);
      if (priority >= priorities[index]) continue;
      if (!Number.isFinite(priorities[index])) queued += 1;
      priorities[index] = priority;
    }
  }
}

function getFlatRelaxationPriority(
  config: WorldConfig,
  tileX: number,
  tileY: number,
  surfaceBoundaries: HydrologyTileBoundaryIndex<Uint16Array>,
  distanceBoundaries: HydrologyTileBoundaryIndex<Uint32Array>
): number {
  const size = config.tileSize;
  let priority = Number.POSITIVE_INFINITY;
  const inspect = (x: number, y: number): void => {
    const currentHeight = surfaceBoundaries.getOffset(tileX, tileY, x, y);
    const currentDistance = distanceBoundaries.getOffset(tileX, tileY, x, y);
    for (let code = 1; code <= 8; code += 1) {
      const nx = x + D8_DX[code];
      const ny = y + D8_DY[code];
      if (nx >= 0 && ny >= 0 && nx < size && ny < size) continue;
      const neighborHeight = surfaceBoundaries.getOffset(tileX, tileY, nx, ny);
      const neighborDistance = distanceBoundaries.getOffset(tileX, tileY, nx, ny);
      if (neighborHeight < currentHeight && currentDistance !== 0) priority = 0;
      else if (neighborHeight === currentHeight && neighborDistance !== NO_FLOW_TARGET && neighborDistance + 1 < currentDistance) {
        priority = Math.min(priority, neighborDistance + 1);
      }
    }
  };
  for (let x = 0; x < size; x += 1) {
    inspect(x, 0);
    if (size > 1) inspect(x, size - 1);
  }
  for (let y = 1; y + 1 < size; y += 1) {
    inspect(0, y);
    if (size > 1) inspect(size - 1, y);
  }
  return priority;
}

class NumericDisjointSet {
  private readonly parent = new Map<number, number>();

  add(value: number): void {
    if (!this.parent.has(value)) this.parent.set(value, value);
  }

  find(value: number): number {
    const parent = this.parent.get(value);
    if (parent === undefined) {
      this.parent.set(value, value);
      return value;
    }
    if (parent === value) return value;
    const root = this.find(parent);
    this.parent.set(value, root);
    return root;
  }

  union(a: number, b: number): void {
    if (a === 0 || b === 0) return;
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA === rootB) return;
    const minimum = Math.min(rootA, rootB);
    this.parent.set(rootA, minimum);
    this.parent.set(rootB, minimum);
  }
}

class HydrologyTileCache<T extends Uint8Array | Uint16Array | Uint32Array> {
  private readonly values = new Map<string, T>();

  constructor(private readonly capacity: number, private readonly load: (x: number, y: number) => Promise<T>) {}

  async read(x: number, y: number): Promise<T> {
    const key = `${x},${y}`;
    const cached = this.values.get(key);
    if (cached) {
      this.values.delete(key);
      this.values.set(key, cached);
      return cached;
    }
    const value = await this.load(x, y);
    this.set(x, y, value);
    return value;
  }

  set(x: number, y: number, value: T): void {
    const key = `${x},${y}`;
    this.values.delete(key);
    this.values.set(key, value);
    while (this.values.size > this.capacity) this.values.delete(this.values.keys().next().value as string);
  }
}

interface HydrologyWriteBackEntry<T extends Uint8Array | Uint16Array | Uint32Array> {
  x: number;
  y: number;
  value: T;
}

class HydrologyWriteBackTileCache<T extends Uint8Array | Uint16Array | Uint32Array> {
  private readonly values = new Map<string, HydrologyWriteBackEntry<T>>();
  private readonly dirty = new Set<string>();

  constructor(
    private readonly capacity: number,
    private readonly load: (x: number, y: number) => Promise<T>,
    private readonly write: (x: number, y: number, value: T) => Promise<void>
  ) {}

  async read(x: number, y: number): Promise<T> {
    const key = `${x},${y}`;
    const cached = this.values.get(key);
    if (cached) {
      this.touch(key, cached);
      return cached.value;
    }
    const value = await this.load(x, y);
    await this.insert(key, { x, y, value }, false);
    return value;
  }

  async setDirty(x: number, y: number, value: T): Promise<void> {
    await this.insert(`${x},${y}`, { x, y, value }, true);
  }

  async flush(): Promise<void> {
    const writes: Promise<void>[] = [];
    for (const key of this.dirty) {
      const entry = this.values.get(key);
      if (entry) writes.push(this.write(entry.x, entry.y, entry.value));
    }
    await Promise.all(writes);
    this.dirty.clear();
  }

  private async insert(key: string, entry: HydrologyWriteBackEntry<T>, dirty: boolean): Promise<void> {
    this.values.delete(key);
    this.values.set(key, entry);
    if (dirty) this.dirty.add(key);
    else this.dirty.delete(key);
    while (this.values.size > this.capacity) {
      const oldestKey = this.values.keys().next().value as string;
      const oldest = this.values.get(oldestKey);
      if (oldest && this.dirty.has(oldestKey)) await this.write(oldest.x, oldest.y, oldest.value);
      this.dirty.delete(oldestKey);
      this.values.delete(oldestKey);
    }
  }

  private touch(key: string, entry: HydrologyWriteBackEntry<T>): void {
    this.values.delete(key);
    this.values.set(key, entry);
  }
}

interface HydrologyTileBoundary<T extends Uint8Array | Uint16Array | Uint32Array> {
  north: T;
  south: T;
  west: T;
  east: T;
}

class HydrologyTileBoundaryIndex<T extends Uint8Array | Uint16Array | Uint32Array> {
  private readonly values = new Map<string, HydrologyTileBoundary<T>>();

  constructor(
    private readonly Constructor: { new(length: number): T },
    private readonly tileSize: number
  ) {}

  set(tileX: number, tileY: number, tile: T): void {
    const key = `${tileX},${tileY}`;
    const existing = this.values.get(key);
    const north = existing?.north ?? new this.Constructor(this.tileSize);
    const south = existing?.south ?? new this.Constructor(this.tileSize);
    const west = existing?.west ?? new this.Constructor(this.tileSize);
    const east = existing?.east ?? new this.Constructor(this.tileSize);
    north.set(tile.subarray(0, this.tileSize));
    south.set(tile.subarray((this.tileSize - 1) * this.tileSize));
    for (let i = 0; i < this.tileSize; i += 1) {
      west[i] = tile[i * this.tileSize];
      east[i] = tile[i * this.tileSize + this.tileSize - 1];
    }
    if (!existing) this.values.set(key, { north, south, west, east });
  }

  getOffset(tileX: number, tileY: number, x: number, y: number): number {
    let targetTileX = tileX;
    let targetTileY = tileY;
    let targetX = x;
    let targetY = y;
    if (targetX < 0) {
      targetTileX -= 1;
      targetX += this.tileSize;
    } else if (targetX >= this.tileSize) {
      targetTileX += 1;
      targetX -= this.tileSize;
    }
    if (targetY < 0) {
      targetTileY -= 1;
      targetY += this.tileSize;
    } else if (targetY >= this.tileSize) {
      targetTileY += 1;
      targetY -= this.tileSize;
    }
    const boundary = this.values.get(`${targetTileX},${targetTileY}`);
    if (!boundary) return 0;
    if (targetY === 0) return boundary.north[targetX];
    if (targetY === this.tileSize - 1) return boundary.south[targetX];
    if (targetX === 0) return boundary.west[targetY];
    if (targetX === this.tileSize - 1) return boundary.east[targetY];
    throw new Error(`Hydrology boundary lookup addressed an interior cell ${targetTileX},${targetTileY}:${targetX},${targetY}.`);
  }

  createHalo(tileX: number, tileY: number, center: T): T {
    const stride = this.tileSize + 2;
    const halo = new this.Constructor(stride * stride);
    for (let y = 0; y < this.tileSize; y += 1) {
      halo.set(center.subarray(y * this.tileSize, (y + 1) * this.tileSize), (y + 1) * stride + 1);
    }
    for (let x = -1; x <= this.tileSize; x += 1) {
      halo[x + 1] = this.getOffset(tileX, tileY, x, -1);
      halo[(this.tileSize + 1) * stride + x + 1] = this.getOffset(tileX, tileY, x, this.tileSize);
    }
    for (let y = 0; y < this.tileSize; y += 1) {
      halo[(y + 1) * stride] = this.getOffset(tileX, tileY, -1, y);
      halo[(y + 1) * stride + this.tileSize + 1] = this.getOffset(tileX, tileY, this.tileSize, y);
    }
    return halo;
  }
}

async function requireHydrologyTile<T>(value: Promise<T | null> | undefined, label: string, x: number, y: number): Promise<T> {
  const tile = await value;
  if (!tile) throw new Error(`Missing ${label} tile y${y}/x${x}.`);
  return tile;
}

async function readCachedHalo<T extends Uint8Array | Uint16Array | Uint32Array>(
  config: WorldConfig,
  tileX: number,
  tileY: number,
  cache: HydrologyTileCache<T>,
  Constructor: { new(length: number): T }
): Promise<T> {
  const size = config.tileSize;
  const stride = size + 2;
  const halo = new Constructor(stride * stride);
  const center = await cache.read(tileX, tileY);
  for (let y = 0; y < size; y += 1) halo.set(center.subarray(y * size, (y + 1) * size), (y + 1) * stride + 1);
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      if (dx === 0 && dy === 0) continue;
      const nx = tileX + dx;
      const ny = tileY + dy;
      if (nx < 0 || ny < 0 || nx >= config.tilesPerSide || ny >= config.tilesPerSide) continue;
      const neighbor = await cache.read(nx, ny);
      const sourceX = dx < 0 ? size - 1 : dx > 0 ? 0 : 0;
      const sourceY = dy < 0 ? size - 1 : dy > 0 ? 0 : 0;
      const width = dx === 0 ? size : 1;
      const height = dy === 0 ? size : 1;
      const targetX = dx < 0 ? 0 : dx > 0 ? size + 1 : 1;
      const targetY = dy < 0 ? 0 : dy > 0 ? size + 1 : 1;
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) halo[(targetY + y) * stride + targetX + x] = neighbor[(sourceY + y) * size + sourceX + x];
      }
    }
  }
  return halo;
}

async function runFlowStrengthBake(
  config: WorldConfig,
  io: HydrologyTileIO,
  jobs: TileJob[],
  useWorkers: boolean,
  completedStart: number,
  total: number,
  onProgress?: (progress: HydrologyProgress) => void
): Promise<{ enabled: boolean; maxFlowAccumulation: number; completed: number }> {
  if (!io.writeFlowStrengthTile || !io.readReceiverDirectionTile || !io.writeFlowAccumulationTile || !io.readFlowAccumulationTile) {
    return { enabled: false, maxFlowAccumulation: 0, completed: completedStart };
  }
  const sharedWorkers = useWorkers
    ? Array.from(
        { length: Math.min(getHydrologyWorkerConcurrency(), jobs.length) },
        () => new Worker(new URL('./bakeWorker.ts', import.meta.url), { type: 'module' })
      )
    : undefined;
  try {
    return await runFlowStrengthBakeInternal(config, io, jobs, useWorkers, completedStart, total, onProgress, sharedWorkers);
  } finally {
    for (const worker of sharedWorkers ?? []) worker.terminate();
  }
}

async function runFlowStrengthBakeInternal(
  config: WorldConfig,
  io: HydrologyTileIO,
  jobs: TileJob[],
  useWorkers: boolean,
  completedStart: number,
  total: number,
  onProgress?: (progress: HydrologyProgress) => void,
  sharedWorkers?: Worker[]
): Promise<{ enabled: boolean; maxFlowAccumulation: number; completed: number }> {
  let completed = completedStart;
  const borderCellCount = Math.max(1, config.tileSize * 4 - 4);
  const incomingTotals = Array.from({ length: jobs.length }, () => new Float64Array(borderCellCount));
  const pending = Array.from({ length: jobs.length }, () => new Float64Array(borderCellCount));
  const receiverTileBytes = config.tileSize * config.tileSize * Uint16Array.BYTES_PER_ELEMENT;
  const cacheReceiversInWorkers = Boolean(sharedWorkers) && receiverTileBytes * jobs.length <= 96 * 1024 * 1024;
  const receiverCacheCapacity = Math.min(jobs.length, Math.max(4, Math.floor(32 * 1024 * 1024 / receiverTileBytes)));
  const receiverCache = new HydrologyTileCache<Uint16Array>(receiverCacheCapacity, (x, y) => (
    requireReceiverDirections(io, { x, y, d: 0 })
  ));
  const tileEdges = Array.from({ length: jobs.length }, () => new Set<number>());
  const pendingTiles = new Set<number>();
  let componentByTile: Int32Array | null = null;
  let activeComponents: Uint8Array | null = null;
  let nextComponentWaveTiles: Set<number> | null = null;
  const deliver = (targetCell: number, flow: number): number => {
    if (!(flow > 0) || !Number.isFinite(flow)) return -1;
    const target = locateBoundaryCell(config, targetCell);
    const index = tileIndex(config, target.tileX, target.tileY);
    incomingTotals[index][target.borderOffset] += flow;
    pending[index][target.borderOffset] += flow;
    pendingTiles.add(index);
    const component = componentByTile?.[index] ?? -1;
    if (component >= 0 && activeComponents?.[component]) nextComponentWaveTiles?.add(index);
    return index;
  };
  await runHydrologyWorkerPool(
    jobs,
    async (job, id) => ({
      id,
      type: 'hydrology-flow-analyze-tile',
      tileX: job.x,
      tileY: job.y,
      tileSize: config.tileSize,
      tilesPerSide: config.tilesPerSide,
      receiverDirections: (await receiverCache.read(job.x, job.y)).slice().buffer,
      cacheReceiverDirections: cacheReceiversInWorkers,
      incomingCells: new Uint32Array(0).buffer,
      incomingFlows: new Float64Array(0).buffer,
      includeBase: true
    }),
    async (response) => {
      if (response.type !== 'hydrology-flow-analyze-result') throw new Error(`Unexpected hydrology response ${response.type}`);
      const targets = new Uint32Array(response.baseTargetCells);
      const flows = new Float64Array(response.baseFlows);
      const source = tileIndex(config, response.tileX, response.tileY);
      for (let i = 0; i < targets.length; i += 1) {
        const target = deliver(targets[i], flows[i]);
        if (target >= 0 && target !== source) tileEdges[source].add(target);
      }
      completed += 1;
      onProgress?.({ phase: 'hydrology', current: completed, total, label: `Analyzing flow ${completed - config.tilesPerSide * config.tilesPerSide * 2 - 1} / ${jobs.length}` });
    },
    useWorkers,
    sharedWorkers
  );

  const componentOrder = buildTileComponentOrder(tileEdges);
  componentByTile = componentOrder.componentByTile;
  let propagationRound = 0;
  const fullSide = config.tileSize * config.tilesPerSide;
  const maxPropagationRounds = fullSide * fullSide;
  for (let levelIndex = 0; levelIndex < componentOrder.levels.length; levelIndex += 1) {
    const level = componentOrder.levels[levelIndex];
    activeComponents = new Uint8Array(componentOrder.componentCount);
    for (const index of level) activeComponents[componentByTile[index]] = 1;
    let waveTiles = new Set(level.filter((index) => pendingTiles.has(index)));
    while (waveTiles.size > 0) {
      propagationRound += 1;
      if (propagationRound > maxPropagationRounds) throw new Error('Cross-tile D-infinity flow propagation did not converge.');
      const roundTiles = [...waveTiles].sort((a, b) => a - b);
      nextComponentWaveTiles = new Set<number>();
      const roundInputs = new Map<number, { cells: Uint32Array; flows: Float64Array }>();
      for (const index of roundTiles) {
        roundInputs.set(index, consumeBoundaryFlows(config.tileSize, pending[index]));
        pendingTiles.delete(index);
      }
      onProgress?.({
        phase: 'hydrology',
        current: completed,
        total,
        label: `Resolving cross-tile flow (${levelIndex + 1}/${componentOrder.levels.length}, ${roundTiles.length} tiles)`
      });
      await runHydrologyWorkerPool(
        roundTiles.map((index) => ({ x: index % config.tilesPerSide, y: Math.floor(index / config.tilesPerSide) })),
        async (job, id) => {
          const input = roundInputs.get(tileIndex(config, job.x, job.y));
          if (!input) throw new Error('Missing cross-tile flow component input.');
          return {
            id,
            type: 'hydrology-flow-analyze-tile',
            tileX: job.x,
            tileY: job.y,
            tileSize: config.tileSize,
            tilesPerSide: config.tilesPerSide,
            receiverDirections: cacheReceiversInWorkers ? new ArrayBuffer(0) : (await receiverCache.read(job.x, job.y)).slice().buffer,
            cacheReceiverDirections: cacheReceiversInWorkers,
            incomingCells: input.cells.buffer as ArrayBuffer,
            incomingFlows: input.flows.buffer as ArrayBuffer,
            includeBase: false
          };
        },
        async (response) => {
          if (response.type !== 'hydrology-flow-analyze-result') throw new Error(`Unexpected hydrology response ${response.type}`);
          const targets = new Uint32Array(response.baseTargetCells);
          const flows = new Float64Array(response.baseFlows);
          for (let i = 0; i < targets.length; i += 1) deliver(targets[i], flows[i]);
        },
        useWorkers,
        sharedWorkers
      );
      waveTiles = nextComponentWaveTiles;
    }
  }
  if (pendingTiles.size > 0) throw new Error('Cross-tile D-infinity flow left unresolved tile inputs.');
  activeComponents = null;
  nextComponentWaveTiles = null;
  completed += 1;
  onProgress?.({ phase: 'hydrology', current: completed, total, label: 'Resolving cross-tile flow' });

  let maxFlowAccumulation = 1;
  await runHydrologyWorkerPool(
    jobs,
    async (job, id) => {
      const incoming = boundaryFlowsToArrays(config.tileSize, incomingTotals[tileIndex(config, job.x, job.y)]);
      return {
        id,
        type: 'hydrology-flow-max-tile',
        tileX: job.x,
        tileY: job.y,
        tileSize: config.tileSize,
        tilesPerSide: config.tilesPerSide,
        receiverDirections: cacheReceiversInWorkers ? new ArrayBuffer(0) : (await receiverCache.read(job.x, job.y)).slice().buffer,
        cacheReceiverDirections: cacheReceiversInWorkers,
        incomingCells: incoming.cells.buffer as ArrayBuffer,
        incomingFlows: incoming.flows.buffer as ArrayBuffer
      };
    },
    async (response) => {
      if (response.type !== 'hydrology-flow-max-result') throw new Error(`Unexpected hydrology response ${response.type}`);
      maxFlowAccumulation = Math.max(maxFlowAccumulation, response.maxFlowAccumulation);
      await io.writeFlowAccumulationTile?.(
        { x: response.tileX, y: response.tileY, d: 0 },
        new Float32Array(response.flowAccumulation)
      );
      completed += 1;
      onProgress?.({ phase: 'hydrology', current: completed, total, label: `Measuring flow ${completed - config.tilesPerSide * config.tilesPerSide * 3 - 2} / ${jobs.length}` });
    },
    useWorkers,
    sharedWorkers
  );

  await runHydrologyWorkerPool(
    jobs,
    async (job, id) => {
      return {
        id,
        type: 'hydrology-flow-materialize-tile',
        tileX: job.x,
        tileY: job.y,
        flowAccumulation: (await requireFlowAccumulation(io, { x: job.x, y: job.y, d: 0 })).buffer as ArrayBuffer,
        maxFlowAccumulation
      };
    },
    async (response) => {
      if (response.type !== 'hydrology-flow-materialize-result') throw new Error(`Unexpected hydrology response ${response.type}`);
      await io.writeFlowStrengthTile?.({ x: response.tileX, y: response.tileY, d: 0 }, new Uint16Array(response.flowStrength));
      completed += 1;
      onProgress?.({ phase: 'hydrology', current: completed, total, label: `Writing flow strength ${completed - config.tilesPerSide * config.tilesPerSide * 4 - 2} / ${jobs.length}` });
    },
    useWorkers,
    sharedWorkers
  );

  return { enabled: true, maxFlowAccumulation, completed };
}

function locateBoundaryCell(config: WorldConfig, globalCell: number): { tileX: number; tileY: number; borderOffset: number } {
  const fullSide = config.tileSize * config.tilesPerSide;
  const globalX = globalCell % fullSide;
  const globalY = Math.floor(globalCell / fullSide);
  const tileX = Math.floor(globalX / config.tileSize);
  const tileY = Math.floor(globalY / config.tileSize);
  const localX = globalX - tileX * config.tileSize;
  const localY = globalY - tileY * config.tileSize;
  const size = config.tileSize;
  if (size === 1) return { tileX, tileY, borderOffset: 0 };
  let borderOffset: number;
  if (localY === 0) borderOffset = localX;
  else if (localX === size - 1) borderOffset = size + localY - 1;
  else if (localY === size - 1) borderOffset = 3 * size - 3 - localX;
  else if (localX === 0) borderOffset = 4 * size - 4 - localY;
  else throw new Error(`Cross-tile flow targeted non-boundary cell ${globalCell}.`);
  return { tileX, tileY, borderOffset };
}

function localCellForBorderOffset(tileSize: number, offset: number): number {
  if (tileSize === 1) return 0;
  if (offset < tileSize) return offset;
  if (offset < 2 * tileSize - 1) return (offset - tileSize + 1) * tileSize + tileSize - 1;
  if (offset < 3 * tileSize - 2) return (tileSize - 1) * tileSize + (3 * tileSize - 3 - offset);
  return (4 * tileSize - 4 - offset) * tileSize;
}

function boundaryFlowsToArrays(tileSize: number, boundary: Float64Array): { cells: Uint32Array; flows: Float64Array } {
  let count = 0;
  for (let i = 0; i < boundary.length; i += 1) if (boundary[i] !== 0) count += 1;
  const cells = new Uint32Array(count);
  const flows = new Float64Array(count);
  let cursor = 0;
  for (let i = 0; i < boundary.length; i += 1) {
    if (boundary[i] === 0) continue;
    cells[cursor] = localCellForBorderOffset(tileSize, i);
    flows[cursor] = boundary[i];
    cursor += 1;
  }
  return { cells, flows };
}

function consumeBoundaryFlows(tileSize: number, boundary: Float64Array): { cells: Uint32Array; flows: Float64Array } {
  const result = boundaryFlowsToArrays(tileSize, boundary);
  boundary.fill(0);
  return result;
}

function buildTileComponentOrder(tileEdgeSets: Set<number>[]): { componentByTile: Int32Array; componentCount: number; levels: number[][] } {
  const edges = tileEdgeSets.map((targets) => [...targets].sort((a, b) => a - b));
  const reverse = Array.from({ length: edges.length }, () => [] as number[]);
  for (let source = 0; source < edges.length; source += 1) {
    for (const target of edges[source]) reverse[target].push(source);
  }
  const visited = new Uint8Array(edges.length);
  const finishOrder: number[] = [];
  for (let start = 0; start < edges.length; start += 1) {
    if (visited[start]) continue;
    const nodes = [start];
    const cursors = [0];
    visited[start] = 1;
    while (nodes.length > 0) {
      const stackIndex = nodes.length - 1;
      const node = nodes[stackIndex];
      const cursor = cursors[stackIndex];
      if (cursor < edges[node].length) {
        const target = edges[node][cursor];
        cursors[stackIndex] += 1;
        if (!visited[target]) {
          visited[target] = 1;
          nodes.push(target);
          cursors.push(0);
        }
      } else {
        finishOrder.push(node);
        nodes.pop();
        cursors.pop();
      }
    }
  }

  const componentByTile = new Int32Array(edges.length);
  componentByTile.fill(-1);
  const components: number[][] = [];
  for (let orderIndex = finishOrder.length - 1; orderIndex >= 0; orderIndex -= 1) {
    const start = finishOrder[orderIndex];
    if (componentByTile[start] >= 0) continue;
    const componentId = components.length;
    const component: number[] = [];
    const stack = [start];
    componentByTile[start] = componentId;
    while (stack.length > 0) {
      const node = stack.pop() as number;
      component.push(node);
      for (const source of reverse[node]) {
        if (componentByTile[source] >= 0) continue;
        componentByTile[source] = componentId;
        stack.push(source);
      }
    }
    component.sort((a, b) => a - b);
    components.push(component);
  }

  const componentEdges = Array.from({ length: components.length }, () => new Set<number>());
  const indegree = new Uint32Array(components.length);
  for (let source = 0; source < edges.length; source += 1) {
    const sourceComponent = componentByTile[source];
    for (const target of edges[source]) {
      const targetComponent = componentByTile[target];
      if (sourceComponent === targetComponent || componentEdges[sourceComponent].has(targetComponent)) continue;
      componentEdges[sourceComponent].add(targetComponent);
      indegree[targetComponent] += 1;
    }
  }
  const queue: number[] = [];
  for (let component = 0; component < components.length; component += 1) if (indegree[component] === 0) queue.push(component);
  const levels: number[][] = [];
  let head = 0;
  while (head < queue.length) {
    const levelEnd = queue.length;
    const level: number[] = [];
    while (head < levelEnd) {
      const component = queue[head++];
      level.push(...components[component]);
      for (const target of componentEdges[component]) {
        indegree[target] -= 1;
        if (indegree[target] === 0) queue.push(target);
      }
    }
    level.sort((a, b) => a - b);
    levels.push(level);
  }
  let orderedComponentCount = 0;
  for (const level of levels) {
    const ids = new Set(level.map((tile) => componentByTile[tile]));
    orderedComponentCount += ids.size;
  }
  if (orderedComponentCount !== components.length) throw new Error('Tile component graph unexpectedly contains a cycle.');
  return { componentByTile, componentCount: components.length, levels };
}

async function requireReceiverDirections(io: HydrologyTileIO, key: TileKey): Promise<Uint16Array> {
  const directions = await io.readReceiverDirectionTile?.(key);
  if (!directions) throw new Error(`Missing conditioned receiver tile d${key.d}/y${key.y}/x${key.x}.`);
  return directions;
}

async function requireFlowAccumulation(io: HydrologyTileIO, key: TileKey): Promise<Float32Array> {
  const accumulation = await io.readFlowAccumulationTile?.(key);
  if (!accumulation) throw new Error(`Missing flow accumulation tile d${key.d}/y${key.y}/x${key.x}.`);
  return accumulation;
}

export function analyzeFlowTile(
  tileX: number,
  tileY: number,
  tileSize: number,
  tilesPerSide: number,
  receiverDirections: Uint16Array,
  incomingCells?: Uint32Array,
  incomingFlows?: Float64Array,
  includeBase = true
): FlowTileAnalysisResult {
  const accumulation = accumulateDirectionTile(
    tileX,
    tileY,
    tileSize,
    tilesPerSide,
    receiverDirections,
    incomingCells,
    incomingFlows,
    includeBase,
    true
  );

  return {
    tileX,
    tileY,
    baseTargetCells: Uint32Array.from(accumulation.outbound.keys()),
    baseFlows: Float64Array.from(accumulation.outbound.values()),
    transferFromCells: new Uint32Array(0),
    transferToCells: new Uint32Array(0)
  };
}

export function computeFlowTileMax(
  tileX: number,
  tileY: number,
  tileSize: number,
  tilesPerSide: number,
  receiverDirections: Uint16Array,
  incomingCells: Uint32Array,
  incomingFlows: Float64Array
): FlowTileMaxResult {
  const accumulation = accumulateDirectionTile(
    tileX,
    tileY,
    tileSize,
    tilesPerSide,
    receiverDirections,
    incomingCells,
    incomingFlows,
    true,
    false
  );
  return {
    tileX,
    tileY,
    maxFlowAccumulation: accumulation.max,
    flowAccumulation: Float32Array.from(accumulation.values).buffer
  };
}

export function materializeFlowTile(
  tileX: number,
  tileY: number,
  accumulation: Float32Array,
  maxFlowAccumulation: number
): MaterializeFlowResult {
  const output = new Uint16Array(accumulation.length);
  const denominator = Math.log1p(Math.max(0, maxFlowAccumulation - 1));
  for (let i = 0; i < output.length; i += 1) {
    const effective = Math.max(0, accumulation[i] - 1);
    const encoded = denominator > 0 && effective > 0 ? Math.min(UINT16_MAX, Math.round(UINT16_MAX * Math.log1p(effective) / denominator)) : 0;
    output[i] = encoded;
  }
  return {
    tileX,
    tileY,
    flowStrength: output.buffer
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
  edgeCellsA: ArrayBuffer;
  edgeCellsB: ArrayBuffer;
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
  drainageSurface: ArrayBuffer;
  flatDistances: ArrayBuffer;
  basinIds: ArrayBuffer;
  areaCells: ArrayBuffer;
  minTerrain: ArrayBuffer;
  maxDepth: ArrayBuffer;
  volumeCellHeight: ArrayBuffer;
  minGlobalX: ArrayBuffer;
  minGlobalY: ArrayBuffer;
  maxGlobalX: ArrayBuffer;
  maxGlobalY: ArrayBuffer;
  lakeCellCount: number;
  maxTileDepth: number;
  tileVolumeCellHeight: number;
};

type HydrologyFlowAnalyzeResponse = {
  id: number;
  type: 'hydrology-flow-analyze-result';
  tileX: number;
  tileY: number;
  baseTargetCells: ArrayBuffer;
  baseFlows: ArrayBuffer;
  transferFromCells: ArrayBuffer;
  transferToCells: ArrayBuffer;
};

type HydrologyFlowMaxResponse = {
  id: number;
  type: 'hydrology-flow-max-result';
  tileX: number;
  tileY: number;
  maxFlowAccumulation: number;
  flowAccumulation: ArrayBuffer;
};

type HydrologyFlowMaterializeResponse = {
  id: number;
  type: 'hydrology-flow-materialize-result';
  tileX: number;
  tileY: number;
  flowStrength: ArrayBuffer;
};

type HydrologyReceiverMaterializeResponse = {
  id: number;
  type: 'hydrology-materialize-receivers-result';
  tileX: number;
  tileY: number;
  receiverDirections: ArrayBuffer;
};

type HydrologyLakeComponentResponse = {
  id: number;
  type: 'hydrology-label-lake-components-result';
  tileX: number;
  tileY: number;
  labels: ArrayBuffer;
  componentIds: ArrayBuffer;
};

type HydrologyPhysicalBasinMeasurementResponse = {
  id: number;
  type: 'hydrology-measure-physical-basins-result';
  tileX: number;
  tileY: number;
  basinIds: ArrayBuffer;
  fillHeights: ArrayBuffer;
  areaCells: ArrayBuffer;
  minTerrain: ArrayBuffer;
  maxDepth: ArrayBuffer;
  volumeCellHeight: ArrayBuffer;
  minGlobalX: ArrayBuffer;
  minGlobalY: ArrayBuffer;
  maxGlobalX: ArrayBuffer;
  maxGlobalY: ArrayBuffer;
};

export type HydrologyWorkerResponse = HydrologyAnalyzeResponse | HydrologyMaterializeResponse | HydrologyReceiverMaterializeResponse | HydrologyLakeComponentResponse | HydrologyPhysicalBasinMeasurementResponse | HydrologyFlowAnalyzeResponse | HydrologyFlowMaxResponse | HydrologyFlowMaterializeResponse;

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
      tilesPerSide: number;
      labelOffset: number;
      computeFlatDistances: boolean;
      collectBasinStats: boolean;
      heights: ArrayBuffer;
      globalFillHeights: ArrayBuffer;
    }
  | {
      id: number;
      type: 'hydrology-flow-analyze-tile';
      tileX: number;
      tileY: number;
      tileSize: number;
      tilesPerSide: number;
      receiverDirections: ArrayBuffer;
      cacheReceiverDirections: boolean;
      incomingCells: ArrayBuffer;
      incomingFlows: ArrayBuffer;
      includeBase: boolean;
    }
  | {
      id: number;
      type: 'hydrology-label-lake-components-tile';
      tileX: number;
      tileY: number;
      tileSize: number;
      tilesPerSide: number;
      lakeFillHeights: ArrayBuffer;
    }
  | {
      id: number;
      type: 'hydrology-measure-physical-basins-tile';
      tileX: number;
      tileY: number;
      tileSize: number;
      lakeFillHeights: ArrayBuffer;
      basinIds: ArrayBuffer;
      terrain: ArrayBuffer;
    }
  | {
      id: number;
      type: 'hydrology-materialize-receivers-tile';
      tileX: number;
      tileY: number;
      tileSize: number;
      tilesPerSide: number;
      surfaceHalo: ArrayBuffer;
      distanceHalo: ArrayBuffer;
    }
  | {
      id: number;
      type: 'hydrology-flow-max-tile';
      tileX: number;
      tileY: number;
      tileSize: number;
      tilesPerSide: number;
      receiverDirections: ArrayBuffer;
      cacheReceiverDirections: boolean;
      incomingCells: ArrayBuffer;
      incomingFlows: ArrayBuffer;
    }
  | {
      id: number;
      type: 'hydrology-flow-materialize-tile';
      tileX: number;
      tileY: number;
      flowAccumulation: ArrayBuffer;
      maxFlowAccumulation: number;
    };

const workerReceiverDirectionCache = new Map<string, Uint16Array>();

function workerReceiverDirections(
  tileX: number,
  tileY: number,
  tileSize: number,
  tilesPerSide: number,
  buffer: ArrayBuffer,
  cache: boolean
): Uint16Array {
  const key = `${tileSize}:${tilesPerSide}:${tileX}:${tileY}`;
  if (buffer.byteLength > 0) {
    const directions = new Uint16Array(buffer);
    if (cache) workerReceiverDirectionCache.set(key, directions);
    return directions;
  }
  const cached = workerReceiverDirectionCache.get(key);
  if (!cached) throw new Error(`Flow worker is missing cached receiver directions for tile ${tileX},${tileY}.`);
  return cached;
}

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
      edgeCellsA: result.edgeCellsA.buffer,
      edgeCellsB: result.edgeCellsB.buffer,
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

  if (request.type === 'hydrology-flow-analyze-tile') {
    const result = analyzeFlowTile(
      request.tileX,
      request.tileY,
      request.tileSize,
      request.tilesPerSide,
      workerReceiverDirections(request.tileX, request.tileY, request.tileSize, request.tilesPerSide, request.receiverDirections, request.cacheReceiverDirections),
      new Uint32Array(request.incomingCells),
      new Float64Array(request.incomingFlows),
      request.includeBase
    );
    const response: HydrologyFlowAnalyzeResponse = {
      id: request.id,
      type: 'hydrology-flow-analyze-result',
      tileX: result.tileX,
      tileY: result.tileY,
      baseTargetCells: result.baseTargetCells.buffer,
      baseFlows: result.baseFlows.buffer,
      transferFromCells: result.transferFromCells.buffer,
      transferToCells: result.transferToCells.buffer
    };
    return { response, transfers: Object.values(response).filter((value): value is ArrayBuffer => value instanceof ArrayBuffer) };
  }

  if (request.type === 'hydrology-label-lake-components-tile') {
    const result = labelLocalLakeComponents(
      request.tileSize,
      request.tilesPerSide,
      request.tileX,
      request.tileY,
      new Uint16Array(request.lakeFillHeights)
    );
    return {
      response: {
        id: request.id,
        type: 'hydrology-label-lake-components-result',
        tileX: request.tileX,
        tileY: request.tileY,
        labels: result.labels.buffer,
        componentIds: result.componentIds.buffer
      },
      transfers: [result.labels.buffer, result.componentIds.buffer]
    };
  }

  if (request.type === 'hydrology-measure-physical-basins-tile') {
    const result = measurePhysicalBasinsTile(
      request.tileX,
      request.tileY,
      request.tileSize,
      new Uint16Array(request.lakeFillHeights),
      new Uint32Array(request.basinIds),
      new Uint16Array(request.terrain)
    );
    const response: HydrologyPhysicalBasinMeasurementResponse = {
      id: request.id,
      type: 'hydrology-measure-physical-basins-result',
      tileX: request.tileX,
      tileY: request.tileY,
      basinIds: result.basinIds.buffer,
      fillHeights: result.fillHeights.buffer,
      areaCells: result.areaCells.buffer,
      minTerrain: result.minTerrain.buffer,
      maxDepth: result.maxDepth.buffer,
      volumeCellHeight: result.volumeCellHeight.buffer,
      minGlobalX: result.minGlobalX.buffer,
      minGlobalY: result.minGlobalY.buffer,
      maxGlobalX: result.maxGlobalX.buffer,
      maxGlobalY: result.maxGlobalY.buffer
    };
    return { response, transfers: Object.values(response).filter((value): value is ArrayBuffer => value instanceof ArrayBuffer) };
  }

  if (request.type === 'hydrology-materialize-receivers-tile') {
    const receivers = materializeGlobalReceivers(
      request.tileSize,
      request.tilesPerSide,
      request.tileX,
      request.tileY,
      new Uint16Array(request.surfaceHalo),
      new Uint32Array(request.distanceHalo)
    );
    return {
      response: {
        id: request.id,
        type: 'hydrology-materialize-receivers-result',
        tileX: request.tileX,
        tileY: request.tileY,
        receiverDirections: receivers.buffer
      },
      transfers: [receivers.buffer]
    };
  }

  if (request.type === 'hydrology-flow-max-tile') {
    const result = computeFlowTileMax(
      request.tileX,
      request.tileY,
      request.tileSize,
      request.tilesPerSide,
      workerReceiverDirections(request.tileX, request.tileY, request.tileSize, request.tilesPerSide, request.receiverDirections, request.cacheReceiverDirections),
      new Uint32Array(request.incomingCells),
      new Float64Array(request.incomingFlows)
    );
    return {
      response: {
        id: request.id,
        type: 'hydrology-flow-max-result',
        tileX: result.tileX,
        tileY: result.tileY,
        maxFlowAccumulation: result.maxFlowAccumulation,
        flowAccumulation: result.flowAccumulation
      },
      transfers: [result.flowAccumulation]
    };
  }

  if (request.type === 'hydrology-flow-materialize-tile') {
    const result = materializeFlowTile(
      request.tileX,
      request.tileY,
      new Float32Array(request.flowAccumulation),
      request.maxFlowAccumulation
    );
    const response: HydrologyFlowMaterializeResponse = {
      id: request.id,
      type: 'hydrology-flow-materialize-result',
      tileX: result.tileX,
      tileY: result.tileY,
      flowStrength: result.flowStrength
    };
    return { response, transfers: Object.values(response).filter((value): value is ArrayBuffer => value instanceof ArrayBuffer) };
  }

  const result = materializeHydrologyTile(
    request.tileX,
    request.tileY,
    request.tileSize,
    request.tilesPerSide,
    request.labelOffset,
    new Uint16Array(request.heights),
    new Uint16Array(request.globalFillHeights),
    request.computeFlatDistances,
    request.collectBasinStats
  );
  const response: HydrologyMaterializeResponse = {
    id: request.id,
    type: 'hydrology-materialize-result',
    tileX: result.tileX,
    tileY: result.tileY,
    lakeFillHeights: result.lakeFillHeights,
    drainageSurface: result.drainageSurface,
    flatDistances: result.flatDistances,
    basinIds: result.basinIds.buffer,
    areaCells: result.areaCells.buffer,
    minTerrain: result.minTerrain.buffer,
    maxDepth: result.maxDepth.buffer,
    volumeCellHeight: result.volumeCellHeight.buffer,
    minGlobalX: result.minGlobalX.buffer,
    minGlobalY: result.minGlobalY.buffer,
    maxGlobalX: result.maxGlobalX.buffer,
    maxGlobalY: result.maxGlobalY.buffer,
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
  sharedWorkers?: Worker[]
): Promise<void> {
  if (!useWorkers) {
    let id = 1;
    for (const job of jobs) {
      const request = await createRequest(job, id);
      id += 1;
      await handleResult(createHydrologyWorkerResponse(request).response);
    }
    return;
  }

  const concurrency = sharedWorkers?.length ?? Math.min(getHydrologyWorkerConcurrency(), jobs.length);
  let nextJobIndex = 0;
  let nextRequestId = 1;
  const ownsWorkers = !sharedWorkers;
  const workers = sharedWorkers
    ? sharedWorkers.slice(0, concurrency)
    : Array.from({ length: concurrency }, () => new Worker(new URL('./bakeWorker.ts', import.meta.url), { type: 'module' }));
  const pinnedJobIndices = sharedWorkers ? Array.from({ length: workers.length }, () => [] as number[]) : null;
  const pinnedCursors = sharedWorkers ? new Uint32Array(workers.length) : null;
  if (pinnedJobIndices) {
    for (let index = 0; index < jobs.length; index += 1) {
      const job = jobs[index];
      const workerIndex = ((Math.imul(job.y, 65537) + job.x) >>> 0) % workers.length;
      pinnedJobIndices[workerIndex].push(index);
    }
  }
  try {
    await Promise.all(workers.map((worker, workerIndex) => new Promise<void>((resolveWorker, rejectWorker) => {
      const runNext = (): void => {
        const pinnedIndex = pinnedJobIndices?.[workerIndex][pinnedCursors?.[workerIndex] ?? 0];
        if (pinnedCursors && pinnedIndex !== undefined) pinnedCursors[workerIndex] += 1;
        const jobIndex = pinnedJobIndices ? pinnedIndex : nextJobIndex++;
        const job = jobIndex === undefined ? undefined : jobs[jobIndex];
        if (!job) {
          resolveWorker();
          return;
        }
        const id = nextRequestId;
        nextRequestId += 1;
        void createRequest(job, id).then((request) => {
          const transfers = getHydrologyRequestTransfers(request);
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
    if (ownsWorkers) for (const worker of workers) worker.terminate();
  }
}

function getHydrologyRequestTransfers(request: HydrologyWorkerRequest): Transferable[] {
  if (request.type === 'hydrology-analyze-tile') return [request.heights];
  if (request.type === 'hydrology-materialize-tile') return [request.heights, request.globalFillHeights];
  if (request.type === 'hydrology-label-lake-components-tile') return [request.lakeFillHeights];
  if (request.type === 'hydrology-measure-physical-basins-tile') return [request.lakeFillHeights, request.basinIds, request.terrain];
  if (request.type === 'hydrology-materialize-receivers-tile') return [request.surfaceHalo, request.distanceHalo];
  if (request.type === 'hydrology-flow-analyze-tile') return [request.receiverDirections, request.incomingCells, request.incomingFlows];
  if (request.type === 'hydrology-flow-max-tile') return [request.receiverDirections, request.incomingCells, request.incomingFlows];
  return [request.flowAccumulation];
}

function accumulateDirectionTile(
  tileX: number,
  tileY: number,
  tileSize: number,
  tilesPerSide: number,
  receiverDirections: Uint16Array,
  incomingCells: Uint32Array | undefined,
  incomingFlows: Float64Array | undefined,
  includeBase: boolean,
  collectOutbound: boolean
): { values: Float64Array; max: number; outbound: Map<number, number> } {
  const sampleCount = tileSize * tileSize;
  const values = new Float64Array(sampleCount);
  const indegree = new Uint8Array(sampleCount);
  const activeCells = includeBase ? null : new Uint32Array(sampleCount);
  const discovered = includeBase ? null : new Uint8Array(sampleCount);
  let activeCount = includeBase ? sampleCount : 0;
  const fullSide = tileSize * tilesPerSide;
  const originX = tileX * tileSize;
  const originY = tileY * tileSize;
  if (includeBase) {
    values.fill(1);
  }
  if (incomingCells && incomingFlows) {
    for (let i = 0; i < incomingCells.length; i += 1) {
      const cell = incomingCells[i];
      const flow = incomingFlows[i];
      if (cell >= sampleCount || flow === 0) continue;
      values[cell] += flow;
      if (discovered && discovered[cell] === 0) {
        discovered[cell] = 1;
        (activeCells as Uint32Array)[activeCount++] = cell;
      }
    }
  }

  for (let cursor = 0; cursor < activeCount; cursor += 1) {
    const cell = activeCells ? activeCells[cursor] : cursor;
    const encoded = receiverDirections[cell];
    if (encoded >= DINF_TURN_STEPS) continue;
    const sector = DINF_SECTOR_LOOKUP[encoded];
    const weightB = DINF_WEIGHT_B_LOOKUP[encoded];
    const y = Math.floor(cell / tileSize);
    const x = cell - y * tileSize;
    for (let branch = 0; branch < 2; branch += 1) {
      if (branch === 1 && weightB === 0) continue;
      const code = DINF_CODES[(sector + branch) & 7];
      const receiverX = x + D8_DX[code];
      const receiverY = y + D8_DY[code];
      if (receiverX < 0 || receiverY < 0 || receiverX >= tileSize || receiverY >= tileSize) continue;
      const receiver = receiverY * tileSize + receiverX;
      indegree[receiver] += 1;
      if (discovered && discovered[receiver] === 0) {
        discovered[receiver] = 1;
        (activeCells as Uint32Array)[activeCount++] = receiver;
      }
    }
  }

  const queue = new Uint32Array(activeCount);
  let queueHead = 0;
  let queueTail = 0;
  for (let i = 0; i < activeCount; i += 1) {
    const cell = activeCells ? activeCells[i] : i;
    if (indegree[cell] === 0) queue[queueTail++] = cell;
  }
  const outbound = new Map<number, number>();
  let max = includeBase ? 1 : 0;
  while (queueHead < queueTail) {
    const cell = queue[queueHead++];
    const flow = values[cell];
    if (flow > max) max = flow;
    const encoded = receiverDirections[cell];
    if (encoded >= DINF_TURN_STEPS) continue;
    const sector = DINF_SECTOR_LOOKUP[encoded];
    const weightB = DINF_WEIGHT_B_LOOKUP[encoded];
    const y = Math.floor(cell / tileSize);
    const x = cell - y * tileSize;
    const globalX = originX + x;
    const globalY = originY + y;
    for (let branch = 0; branch < 2; branch += 1) {
      const weight = branch === 0 ? 1 - weightB : weightB;
      if (weight <= 0) continue;
      const code = DINF_CODES[(sector + branch) & 7];
      const dx = D8_DX[code];
      const dy = D8_DY[code];
      const receiverX = x + dx;
      const receiverY = y + dy;
      if (receiverX >= 0 && receiverY >= 0 && receiverX < tileSize && receiverY < tileSize) {
        const receiver = receiverY * tileSize + receiverX;
        values[receiver] += flow * weight;
        indegree[receiver] -= 1;
        if (indegree[receiver] === 0) queue[queueTail++] = receiver;
      } else if (collectOutbound) {
        const targetX = globalX + dx;
        const targetY = globalY + dy;
        if (targetX >= 0 && targetY >= 0 && targetX < fullSide && targetY < fullSide) {
          const target = targetY * fullSide + targetX;
          outbound.set(target, (outbound.get(target) ?? 0) + flow * weight);
        }
      }
    }
  }
  if (queueTail !== activeCount) throw new Error('D-infinity receiver tile contains a cycle.');
  return { values, max, outbound };
}

function collectTileBorderCells(tileSize: number): Uint32Array {
  if (tileSize <= 1) return Uint32Array.of(0);
  const cells = new Uint32Array(tileSize * 4 - 4);
  let index = 0;
  for (let x = 0; x < tileSize; x += 1) cells[index++] = x;
  for (let y = 1; y < tileSize - 1; y += 1) cells[index++] = y * tileSize + tileSize - 1;
  for (let x = tileSize - 1; x >= 0; x -= 1) cells[index++] = (tileSize - 1) * tileSize + x;
  for (let y = tileSize - 2; y >= 1; y -= 1) cells[index++] = y * tileSize;
  return cells;
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
  cellFrom: Uint32Array;
  cellTo: Uint32Array;
  oceanLabels: Set<number>;
} {
  const edgeMap = new Map<number, { weight: number; cellLo: number; cellHi: number }>();
  const oceanLabels = new Set<number>();
  const addEdge = (a: number, b: number, weight: number, cellA: number, cellB: number): void => {
    if (a === b) return;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const key = lo * nodeCount + hi;
    const previous = edgeMap.get(key);
    const cellLo = a === lo ? cellA : cellB;
    const cellHi = a === lo ? cellB : cellA;
    if (!previous || weight < previous.weight || (weight === previous.weight && (cellLo < previous.cellLo || (cellLo === previous.cellLo && cellHi < previous.cellHi)))) {
      edgeMap.set(key, { weight, cellLo, cellHi });
    }
  };
  const globalLabel = (analysis: TileAnalysis, localLabel: number): number => analysis.labelOffset + localLabel - 1;
  const fullSide = config.tileSize * config.tilesPerSide;
  const globalCell = (analysis: TileAnalysis, localIndex: number): number => {
    const x = analysis.key.x * config.tileSize + localIndex % config.tileSize;
    const y = analysis.key.y * config.tileSize + Math.floor(localIndex / config.tileSize);
    return y * fullSide + x;
  };

  for (const analysis of analyses) {
    for (let i = 0; i < analysis.edgeWeights.length; i += 1) {
      addEdge(
        globalLabel(analysis, analysis.edges[i * 2]),
        globalLabel(analysis, analysis.edges[i * 2 + 1]),
        analysis.edgeWeights[i],
        globalCell(analysis, analysis.edgeCellsA[i]),
        globalCell(analysis, analysis.edgeCellsB[i])
      );
    }
    if (analysis.key.y === 0) {
      for (let i = 0; i < analysis.northLabels.length; i += 1) {
        const id = globalLabel(analysis, analysis.northLabels[i]);
        oceanLabels.add(id);
        addEdge(OCEAN_NODE, id, analysis.northHeights[i], NO_FLOW_TARGET, globalCell(analysis, i));
      }
    }
    if (analysis.key.y === config.tilesPerSide - 1) {
      for (let i = 0; i < analysis.southLabels.length; i += 1) {
        const id = globalLabel(analysis, analysis.southLabels[i]);
        oceanLabels.add(id);
        addEdge(OCEAN_NODE, id, analysis.southHeights[i], NO_FLOW_TARGET, globalCell(analysis, (config.tileSize - 1) * config.tileSize + i));
      }
    }
    if (analysis.key.x === 0) {
      for (let i = 0; i < analysis.westLabels.length; i += 1) {
        const id = globalLabel(analysis, analysis.westLabels[i]);
        oceanLabels.add(id);
        addEdge(OCEAN_NODE, id, analysis.westHeights[i], NO_FLOW_TARGET, globalCell(analysis, i * config.tileSize));
      }
    }
    if (analysis.key.x === config.tilesPerSide - 1) {
      for (let i = 0; i < analysis.eastLabels.length; i += 1) {
        const id = globalLabel(analysis, analysis.eastLabels[i]);
        oceanLabels.add(id);
        addEdge(OCEAN_NODE, id, analysis.eastHeights[i], NO_FLOW_TARGET, globalCell(analysis, i * config.tileSize + config.tileSize - 1));
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
            Math.max(analysis.eastHeights[i], east.westHeights[i]),
            globalCell(analysis, i * config.tileSize + config.tileSize - 1),
            globalCell(east, i * config.tileSize)
          );
        }
      }
      if (y + 1 < config.tilesPerSide) {
        const south = analyses[tileIndex(config, x, y + 1)];
        for (let i = 0; i < config.tileSize; i += 1) {
          addEdge(
            globalLabel(analysis, analysis.southLabels[i]),
            globalLabel(south, south.northLabels[i]),
            Math.max(analysis.southHeights[i], south.northHeights[i]),
            globalCell(analysis, (config.tileSize - 1) * config.tileSize + i),
            globalCell(south, i)
          );
        }
      }
    }
  }

  const from = new Uint32Array(edgeMap.size);
  const to = new Uint32Array(edgeMap.size);
  const weight = new Uint16Array(edgeMap.size);
  const cellFrom = new Uint32Array(edgeMap.size);
  const cellTo = new Uint32Array(edgeMap.size);
  let index = 0;
  for (const [key, value] of edgeMap) {
    from[index] = Math.floor(key / nodeCount);
    to[index] = key % nodeCount;
    weight[index] = value.weight;
    cellFrom[index] = value.cellLo;
    cellTo[index] = value.cellHi;
    index += 1;
  }
  return { nodeCount, from, to, weight, cellFrom, cellTo, oceanLabels };
}

function solveGraphFillHeights(nodeCount: number, from: Uint32Array, to: Uint32Array, weight: Uint16Array): {
  fills: Uint16Array;
  parentNode: Uint32Array;
  parentEdge: Uint32Array;
} {
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
  const edgeIds = new Uint32Array(offsets[nodeCount]);
  for (let i = 0; i < from.length; i += 1) {
    let slot = cursor[from[i]];
    adjacency[slot] = to[i];
    weights[slot] = weight[i];
    edgeIds[slot] = i;
    cursor[from[i]] += 1;
    slot = cursor[to[i]];
    adjacency[slot] = from[i];
    weights[slot] = weight[i];
    edgeIds[slot] = i;
    cursor[to[i]] += 1;
  }

  const fills = new Uint16Array(nodeCount);
  fills.fill(UINT16_MAX);
  fills[OCEAN_NODE] = 0;
  const parentNode = new Uint32Array(nodeCount);
  const parentEdge = new Uint32Array(nodeCount);
  const settled = new Uint8Array(nodeCount);
  parentNode.fill(NO_FLOW_TARGET);
  parentEdge.fill(NO_FLOW_TARGET);
  const heap = new MinHeap();
  heap.push(OCEAN_NODE, 0);
  while (heap.length > 0) {
    const node = heap.pop();
    if (settled[node]) continue;
    settled[node] = 1;
    const base = fills[node];
    for (let i = offsets[node]; i < offsets[node + 1]; i += 1) {
      const neighbor = adjacency[i];
      if (settled[neighbor]) continue;
      const candidate = Math.max(base, weights[i]);
      const edgeId = edgeIds[i];
      if (candidate < fills[neighbor] || (candidate === fills[neighbor] && (node < parentNode[neighbor] || (node === parentNode[neighbor] && edgeId < parentEdge[neighbor])))) {
        fills[neighbor] = candidate;
        parentNode[neighbor] = node;
        parentEdge[neighbor] = edgeId;
        heap.push(neighbor, candidate);
      }
    }
  }
  return { fills, parentNode, parentEdge };
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

async function readHeightHalo(config: WorldConfig, io: HydrologyTileIO, tileX: number, tileY: number): Promise<Uint16Array> {
  const tileSize = config.tileSize;
  const stride = tileSize + 2;
  const halo = new Uint16Array(stride * stride);
  const center = await io.readTile({ x: tileX, y: tileY, d: 0 });
  for (let y = 0; y < tileSize; y += 1) {
    halo.set(center.subarray(y * tileSize, (y + 1) * tileSize), (y + 1) * stride + 1);
  }

  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      if (dx === 0 && dy === 0) continue;
      const nx = tileX + dx;
      const ny = tileY + dy;
      if (nx < 0 || ny < 0 || nx >= config.tilesPerSide || ny >= config.tilesPerSide) continue;
      const neighbor = await io.readTile({ x: nx, y: ny, d: 0 });
      const sourceX = dx < 0 ? tileSize - 1 : dx > 0 ? 0 : 0;
      const sourceY = dy < 0 ? tileSize - 1 : dy > 0 ? 0 : 0;
      const width = dx === 0 ? tileSize : 1;
      const height = dy === 0 ? tileSize : 1;
      const targetX = dx < 0 ? 0 : dx > 0 ? tileSize + 1 : 1;
      const targetY = dy < 0 ? 0 : dy > 0 ? tileSize + 1 : 1;
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          halo[(targetY + y) * stride + targetX + x] = neighbor[(sourceY + y) * tileSize + sourceX + x];
        }
      }
    }
  }
  return halo;
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
