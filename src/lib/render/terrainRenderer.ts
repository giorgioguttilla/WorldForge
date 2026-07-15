import * as THREE from 'three';
import type { TileManager } from '../heightmap/tileManager';
import { getMaxLodDepth, type WorldConfig } from '../heightmap/worldConfig';
import type { TileKey } from '../heightmap/tileKey';
import type { ViewMode } from './cameraController';

export type VisualizationMode = 'wireframe' | 'topo' | 'render';

const CHUNK_SEGMENTS_PER_SIDE = 64;
const BASE_SAMPLE_SCREEN_ERROR_PX = 15;
const ORTHO_SAMPLE_SCREEN_ERROR_PX = 11;
const MAX_RENDER_TILE_CACHE_ENTRIES = 80;
const SPARE_POOL_NODES = 128;
const MAX_CONCURRENT_CHUNK_BUILDS = 4;
const CHUNK_WORKER_COUNT = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));

export interface TerrainLodSettings {
  aggression: number;
}

interface TerrainNode {
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>;
  key: string;
  inUse: boolean;
}

interface ChunkBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  centerX: number;
  centerZ: number;
  size: number;
}

interface RenderChunkKey {
  x: number;
  y: number;
  lod: number;
}

interface RenderTileCacheEntry {
  samples: Promise<Uint16Array>;
  lastUsed: number;
}

interface ChunkSamplingPlan {
  tileDepth: number;
  sampleScale: number;
  lodSamplesPerSide: number;
  tileKeys: TileKey[];
}

interface WorkerTilePayload {
  id: string;
  samples: ArrayBuffer;
}

interface WorkerBuildResponse {
  type: 'built';
  requestId: number;
  heights: ArrayBuffer;
  colors: ArrayBuffer;
  normals: ArrayBuffer;
  boundingRadius: number;
}

interface WorkerBuildError {
  type: 'error';
  requestId: number;
  message: string;
}

interface WorkerBuildRequest {
  type: 'build';
  requestId: number;
  config: Pick<WorldConfig, 'tileSize' | 'tilesPerSide' | 'unitSize' | 'worldHeight'>;
  key: RenderChunkKey;
  chunkSegments: number;
  tileDepth: number;
  sampleScale: number;
  lodSamplesPerSide: number;
  tiles: WorkerTilePayload[];
}

interface ChunkWorkerState {
  worker: Worker;
  requests: Map<number, { resolve: (response: WorkerBuildResponse) => void; reject: (error: Error) => void }>;
  tileCache: Set<string>;
  pending: number;
}

class StaleTerrainBuildError extends Error {
  constructor() {
    super('Stale terrain build.');
  }
}

export class TerrainQuadtreeRenderer {
  readonly group = new THREE.Group();
  visualizationMode: VisualizationMode = 'topo';

  private readonly pool: TerrainNode[] = [];
  private readonly freeNodes: TerrainNode[] = [];
  private readonly active = new Map<string, TerrainNode>();
  private readonly staged = new Map<string, TerrainNode>();
  private readonly tileCache = new Map<string, RenderTileCacheEntry>();
  private readonly workers: ChunkWorkerState[] = [];
  private readonly material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.88,
    metalness: 0.02
  });
  private updateQueued = false;
  private updateRequested = false;
  private lastSelectionId = '';
  private lastCameraSignature = '';
  private stagedSelectionId = '';
  private viewportHeight = 720;
  private viewMode: ViewMode = 'free';
  private lodAggression = 1;
  private readonly sparePoolNodes = SPARE_POOL_NODES;
  private nextWorkerRequestId = 1;
  private generation = 0;

  constructor(private readonly manager: TileManager) {
    for (let i = 0; i < CHUNK_WORKER_COUNT; i += 1) {
      this.workers.push(this.createChunkWorker());
    }
    this.applyVisualizationMode();
  }

  setViewportSize(_width: number, height: number): void {
    this.viewportHeight = Math.max(1, height);
  }

  async update(camera: THREE.Camera): Promise<void> {
    if (this.updateQueued) {
      this.updateRequested = true;
      return;
    }

    this.updateQueued = true;
    try {
      do {
        this.updateRequested = false;
        await this.updateSelection(camera);
      } while (this.updateRequested);
    } finally {
      this.updateQueued = false;
    }
  }

  dispose(): void {
    this.generation += 1;
    this.cancelPendingBuilds();
    for (const node of this.pool) {
      node.mesh.geometry.dispose();
    }
    for (const state of this.workers) {
      state.worker.terminate();
      state.tileCache.clear();
      state.pending = 0;
    }
    this.material.dispose();
    this.pool.length = 0;
    this.freeNodes.length = 0;
    this.active.clear();
    this.staged.clear();
    this.tileCache.clear();
    for (const state of this.workers) state.tileCache.clear();
  }

  clear(): void {
    this.generation += 1;
    this.cancelPendingBuilds();
    for (const node of this.pool) {
      this.group.remove(node.mesh);
      node.mesh.geometry.dispose();
    }
    this.pool.length = 0;
    this.freeNodes.length = 0;
    this.active.clear();
    this.staged.clear();
    this.tileCache.clear();
    for (const state of this.workers) state.tileCache.clear();
    this.lastSelectionId = '';
    this.lastCameraSignature = '';
    this.stagedSelectionId = '';
    this.manager.setRenderMetrics(0, 0, 0);
  }

  setVisualizationMode(mode: VisualizationMode): void {
    this.visualizationMode = mode;
    for (const node of this.pool) {
      node.mesh.geometry.computeVertexNormals();
    }
    this.applyVisualizationMode();
  }

  setViewMode(mode: ViewMode): void {
    if (this.viewMode === mode) return;
    this.viewMode = mode;
    this.lastSelectionId = '';
    this.lastCameraSignature = '';
    this.releaseStagedNodes();
  }

  setLodSettings(settings: TerrainLodSettings): void {
    const nextAggression = THREE.MathUtils.clamp(settings.aggression, 0, 4);
    if (Math.abs(this.lodAggression - nextAggression) < 0.001) return;
    this.lodAggression = nextAggression;
    this.generation += 1;
    this.cancelPendingBuilds();
    this.lastSelectionId = '';
    this.lastCameraSignature = '';
    this.releaseStagedNodes();
  }

  getRaycastTargets(): THREE.Object3D[] {
    return [...this.active.values()].map((node) => node.mesh);
  }

  private async updateSelection(camera: THREE.Camera): Promise<void> {
    const config = this.manager.config;
    if (!config) return;
    const generation = this.generation;

    const cameraSignature = this.getCameraSignature(camera);
    if (cameraSignature === this.lastCameraSignature && this.stagedSelectionId === '') {
      this.updateMetrics();
      return;
    }

    const keys = this.selectChunks(config, camera);
    const nextSelectionId = keys.map((key) => `${key.lod}:${key.x}:${key.y}`).join('|');
    if (nextSelectionId === this.lastSelectionId) {
      this.lastCameraSignature = cameraSignature;
      this.releaseStagedNodes();
      this.updateMetrics();
      return;
    }
    if (this.stagedSelectionId !== nextSelectionId) {
      this.releaseStagedNodes();
      this.stagedSelectionId = nextSelectionId;
    }

    const nextActive = new Map<string, TerrainNode>();
    const builds: Promise<void>[] = [];
    for (const key of keys) {
      const id = `${key.lod}:${key.x}:${key.y}`;
      const existing = this.active.get(id);
      if (existing) {
        nextActive.set(id, existing);
        continue;
      }
      const staged = this.staged.get(id);
      if (staged) {
        nextActive.set(id, staged);
        continue;
      }
      const node = this.acquireNode(id, config, false);
      builds.push(
        this.populateNode(node, key, config, generation)
          .then(() => {
            if (this.generation !== generation) return;
            if (this.stagedSelectionId !== nextSelectionId) {
              this.releaseNode(node);
              return;
            }
            nextActive.set(id, node);
            node.inUse = true;
            node.mesh.visible = false;
            this.staged.set(id, node);
          })
          .catch((error) => {
            if (error instanceof StaleTerrainBuildError) return;
            console.error('Failed to build terrain chunk.', error);
            if (this.pool.includes(node)) this.releaseNode(node);
          })
      );
      if (builds.length >= MAX_CONCURRENT_CHUNK_BUILDS) {
        await Promise.all(builds.splice(0));
      }
    }
    await Promise.all(builds);
    if (this.generation !== generation) return;

    for (const [id, node] of this.active) {
      if (!nextActive.has(id)) {
        this.releaseNode(node);
      }
    }

    this.active.clear();
    for (const [id, node] of nextActive) {
      node.inUse = true;
      node.mesh.visible = true;
      this.active.set(id, node);
    }
    this.staged.clear();
    this.stagedSelectionId = '';
    this.lastSelectionId = nextSelectionId;
    this.lastCameraSignature = cameraSignature;
    this.trimUnusedPool();
    this.updateMetrics();
  }

  private selectChunks(config: WorldConfig, camera: THREE.Camera): RenderChunkKey[] {
    camera.updateMatrixWorld();
    const maxRenderLod = this.getMaxRenderLod(config);
    const keys: RenderChunkKey[] = [];
    const root: RenderChunkKey = { x: 0, y: 0, lod: maxRenderLod };
    const visit = (key: RenderChunkKey): void => {
      const bounds = this.getChunkBounds(config, key);
      if (!this.shouldRenderTile(bounds, camera)) return;
      if (key.lod > 0 && this.shouldSubdivide(config, key, bounds, camera)) {
        const childDepth = key.lod - 1;
        const childX = key.x * 2;
        const childY = key.y * 2;
        visit({ x: childX, y: childY, lod: childDepth });
        visit({ x: childX + 1, y: childY, lod: childDepth });
        visit({ x: childX, y: childY + 1, lod: childDepth });
        visit({ x: childX + 1, y: childY + 1, lod: childDepth });
        return;
      }
      keys.push(key);
    };

    visit(root);
    return keys.sort((a, b) => b.lod - a.lod || a.y - b.y || a.x - b.x);
  }

  private shouldRenderTile(bounds: ChunkBounds, camera: THREE.Camera): boolean {
    if (!(camera instanceof THREE.OrthographicCamera)) return true;

    const visibleHeight = (camera.top - camera.bottom) / Math.max(camera.zoom, 0.0001);
    const visibleWidth = (camera.right - camera.left) / Math.max(camera.zoom, 0.0001);
    const margin = bounds.size * 0.15;
    const minX = camera.position.x - visibleWidth / 2 - margin;
    const maxX = camera.position.x + visibleWidth / 2 + margin;
    const minZ = camera.position.z - visibleHeight / 2 - margin;
    const maxZ = camera.position.z + visibleHeight / 2 + margin;

    return bounds.maxX >= minX && bounds.minX <= maxX && bounds.maxZ >= minZ && bounds.minZ <= maxZ;
  }

  private shouldSubdivide(config: WorldConfig, key: RenderChunkKey, bounds: ChunkBounds, camera: THREE.Camera): boolean {
    if (key.lod <= 0) return false;
    const sampleScreenPx = this.getProjectedSampleSpacingPx(config, key, bounds, camera);
    const targetErrorPx = this.getTargetSampleScreenErrorPx(camera);
    return sampleScreenPx > targetErrorPx;
  }

  private getProjectedSampleSpacingPx(config: WorldConfig, key: RenderChunkKey, bounds: ChunkBounds, camera: THREE.Camera): number {
    const sampleWorldSize = config.unitSize * 2 ** key.lod;
    if (camera instanceof THREE.OrthographicCamera) {
      const visibleHeight = (camera.top - camera.bottom) / Math.max(camera.zoom, 0.0001);
      return (sampleWorldSize / Math.max(1, visibleHeight)) * this.viewportHeight;
    }

    const distance = Math.max(1, this.distanceToBounds(camera.position.x, camera.position.z, bounds));
    const perspective = camera as THREE.PerspectiveCamera;
    const visibleWorldHeight = 2 * distance * Math.tan(THREE.MathUtils.degToRad(perspective.fov) / 2);
    return (sampleWorldSize / Math.max(1, visibleWorldHeight)) * this.viewportHeight;
  }

  private getTargetSampleScreenErrorPx(camera: THREE.Camera): number {
    const base = camera instanceof THREE.OrthographicCamera
      ? ORTHO_SAMPLE_SCREEN_ERROR_PX
      : BASE_SAMPLE_SCREEN_ERROR_PX * (this.viewMode === 'character' ? 0.82 : 1);
    return base * 2 ** (1 - this.lodAggression);
  }

  private getChunkBounds(config: WorldConfig, key: RenderChunkKey): ChunkBounds {
    const size = this.getChunkWorldSize(config, key.lod);
    const worldSize = config.tileSize * config.tilesPerSide * config.unitSize;
    const minX = key.x * size - worldSize / 2;
    const minZ = key.y * size - worldSize / 2;
    return {
      minX,
      minZ,
      maxX: minX + size,
      maxZ: minZ + size,
      centerX: minX + size / 2,
      centerZ: minZ + size / 2,
      size
    };
  }

  private distanceToBounds(x: number, z: number, bounds: ChunkBounds): number {
    const dx = x < bounds.minX ? bounds.minX - x : x > bounds.maxX ? x - bounds.maxX : 0;
    const dz = z < bounds.minZ ? bounds.minZ - z : z > bounds.maxZ ? z - bounds.maxZ : 0;
    return Math.hypot(dx, dz);
  }

  private acquireNode(id: string, config: WorldConfig, visible = true): TerrainNode {
    const unused = this.freeNodes.pop();
    if (unused) {
      unused.inUse = true;
      unused.key = id;
      unused.mesh.visible = visible;
      return unused;
    }

    const geometry = new THREE.PlaneGeometry(
      CHUNK_SEGMENTS_PER_SIDE * config.unitSize,
      CHUNK_SEGMENTS_PER_SIDE * config.unitSize,
      CHUNK_SEGMENTS_PER_SIDE,
      CHUNK_SEGMENTS_PER_SIDE
    );
    geometry.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geometry, this.material);
    mesh.frustumCulled = true;
    this.group.add(mesh);
    mesh.visible = visible;
    const node = { mesh, key: id, inUse: true };
    this.pool.push(node);
    return node;
  }

  private async populateNode(node: TerrainNode, key: RenderChunkKey, config: WorldConfig, generation: number): Promise<void> {
    const built = await this.buildChunkInWorker(config, key, generation);
    if (this.generation !== generation || this.manager.config?.id !== config.id) throw new StaleTerrainBuildError();
    const geometry = node.mesh.geometry;
    const positions = geometry.attributes.position as THREE.BufferAttribute;
    const colors = this.ensureColorAttribute(geometry);
    const normals = geometry.attributes.normal as THREE.BufferAttribute;
    const heights = new Float32Array(built.heights);
    const positionArray = positions.array as Float32Array;

    for (let i = 0; i < positions.count; i += 1) {
      positionArray[i * 3 + 1] = heights[i];
    }

    colors.array.set(new Float32Array(built.colors));
    normals.array.set(new Float32Array(built.normals));
    positions.needsUpdate = true;
    colors.needsUpdate = true;
    normals.needsUpdate = true;
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), built.boundingRadius);
    const chunkWorldSize = this.getChunkWorldSize(config, key.lod);
    const originX = (key.x + 0.5) * chunkWorldSize - (config.tilesPerSide * config.tileSize * config.unitSize) / 2;
    const originZ = (key.y + 0.5) * chunkWorldSize - (config.tilesPerSide * config.tileSize * config.unitSize) / 2;
    node.mesh.position.set(originX, 0, originZ);
    node.mesh.scale.set(2 ** key.lod, 1, 2 ** key.lod);
    node.mesh.visible = false;
  }

  private getMaxRenderLod(config: WorldConfig): number {
    const fullSamplesPerSide = config.tileSize * config.tilesPerSide;
    return Math.max(0, Math.ceil(Math.log2(fullSamplesPerSide / CHUNK_SEGMENTS_PER_SIDE)));
  }

  private getChunkWorldSize(config: WorldConfig, lod: number): number {
    return CHUNK_SEGMENTS_PER_SIDE * config.unitSize * 2 ** lod;
  }

  private getChunkSamplingPlan(config: WorldConfig, key: RenderChunkKey): ChunkSamplingPlan {
    const tileDepth = Math.min(key.lod, getMaxLodDepth(config.tilesPerSide));
    const sampleScale = 2 ** tileDepth;
    const lodSamplesPerSide = (config.tileSize * config.tilesPerSide) / sampleScale;
    const chunkStartX = key.x * CHUNK_SEGMENTS_PER_SIDE * 2 ** key.lod;
    const chunkStartY = key.y * CHUNK_SEGMENTS_PER_SIDE * 2 ** key.lod;
    const chunkEndX = chunkStartX + CHUNK_SEGMENTS_PER_SIDE * 2 ** key.lod;
    const chunkEndY = chunkStartY + CHUNK_SEGMENTS_PER_SIDE * 2 ** key.lod;
    const normalSamplePadding = 2 ** key.lod;
    const minSampleX = Math.floor(THREE.MathUtils.clamp((chunkStartX - normalSamplePadding) / sampleScale, 0, lodSamplesPerSide - 1));
    const minSampleY = Math.floor(THREE.MathUtils.clamp((chunkStartY - normalSamplePadding) / sampleScale, 0, lodSamplesPerSide - 1));
    const maxSampleX = Math.ceil(THREE.MathUtils.clamp((chunkEndX + normalSamplePadding) / sampleScale, 0, lodSamplesPerSide - 1));
    const maxSampleY = Math.ceil(THREE.MathUtils.clamp((chunkEndY + normalSamplePadding) / sampleScale, 0, lodSamplesPerSide - 1));
    const tilesPerSide = config.tilesPerSide / 2 ** tileDepth;
    const minTileX = Math.min(tilesPerSide - 1, Math.floor(minSampleX / config.tileSize));
    const minTileY = Math.min(tilesPerSide - 1, Math.floor(minSampleY / config.tileSize));
    const maxTileX = Math.min(tilesPerSide - 1, Math.floor(maxSampleX / config.tileSize));
    const maxTileY = Math.min(tilesPerSide - 1, Math.floor(maxSampleY / config.tileSize));
    const tileKeys: TileKey[] = [];

    for (let tileY = minTileY; tileY <= maxTileY; tileY += 1) {
      for (let tileX = minTileX; tileX <= maxTileX; tileX += 1) {
        tileKeys.push({ x: tileX, y: tileY, d: tileDepth });
      }
    }

    return { tileDepth, sampleScale, lodSamplesPerSide, tileKeys };
  }

  private async buildChunkInWorker(config: WorldConfig, key: RenderChunkKey, generation: number): Promise<WorkerBuildResponse> {
    const workerState = this.getNextWorker();
    const plan = this.getChunkSamplingPlan(config, key);
    const tilePayloads = await Promise.all(
      plan.tileKeys.map(async (tileKey): Promise<WorkerTilePayload | null> => {
        const cacheId = `${config.id}:${tileKey.d}:${tileKey.x}:${tileKey.y}`;
        if (workerState.tileCache.has(cacheId)) return null;
        const samples = await this.readTileSamples(config, tileKey);
        if (this.generation !== generation || this.manager.config?.id !== config.id) throw new StaleTerrainBuildError();
        const copy = new Uint16Array(samples);
        workerState.tileCache.add(cacheId);
        return { id: `${tileKey.d}:${tileKey.x}:${tileKey.y}`, samples: copy.buffer };
      })
    );
    const tiles = tilePayloads.filter((tile): tile is WorkerTilePayload => Boolean(tile));
    const requestId = this.nextWorkerRequestId;
    this.nextWorkerRequestId += 1;
    const request: WorkerBuildRequest = {
      type: 'build',
      requestId,
      config: {
        tileSize: config.tileSize,
        tilesPerSide: config.tilesPerSide,
        unitSize: config.unitSize,
        worldHeight: config.worldHeight
      },
      key,
      chunkSegments: CHUNK_SEGMENTS_PER_SIDE,
      tileDepth: plan.tileDepth,
      sampleScale: plan.sampleScale,
      lodSamplesPerSide: plan.lodSamplesPerSide,
      tiles
    };

    return new Promise((resolve, reject) => {
      workerState.pending += 1;
      workerState.requests.set(requestId, {
        resolve: (response) => {
          workerState.pending = Math.max(0, workerState.pending - 1);
          if (this.generation !== generation || this.manager.config?.id !== config.id) {
            reject(new StaleTerrainBuildError());
            return;
          }
          resolve(response);
        },
        reject: (error) => {
          workerState.pending = Math.max(0, workerState.pending - 1);
          reject(error);
        }
      });
      workerState.worker.postMessage(
        request,
        tiles.map((tile) => tile.samples)
      );
    });
  }

  private createChunkWorker(): ChunkWorkerState {
    const state: ChunkWorkerState = {
      worker: new Worker(new URL('./terrainChunkWorker.ts', import.meta.url), { type: 'module' }),
      requests: new Map(),
      tileCache: new Set(),
      pending: 0
    };
    state.worker.onmessage = (event: MessageEvent<WorkerBuildResponse | WorkerBuildError>) => {
      const response = event.data;
      const pending = state.requests.get(response.requestId);
      if (!pending) return;
      state.requests.delete(response.requestId);
      if (response.type === 'error') {
        pending.reject(new Error(response.message));
      } else {
        pending.resolve(response);
      }
    };
    state.worker.onerror = (event) => {
      const error = new Error(event.message);
      for (const pending of state.requests.values()) {
        pending.reject(error);
      }
      state.requests.clear();
      state.pending = 0;
    };
    return state;
  }

  private getNextWorker(): ChunkWorkerState {
    return this.workers.reduce((best, worker) => (worker.pending < best.pending ? worker : best), this.workers[0]);
  }

  private readTileSamples(config: WorldConfig, key: TileKey): Promise<Uint16Array> {
    const id = `${config.id}:${key.d}:${key.x}:${key.y}`;
    const cached = this.tileCache.get(id);
    if (cached) {
      cached.lastUsed = performance.now();
      return cached.samples;
    }

    const entry: RenderTileCacheEntry = {
      samples: this.manager.readTile(key),
      lastUsed: performance.now()
    };
    this.tileCache.set(id, entry);
    if (this.tileCache.size > MAX_RENDER_TILE_CACHE_ENTRIES) {
      const oldest = [...this.tileCache.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      if (oldest) this.tileCache.delete(oldest[0]);
    }
    return entry.samples;
  }

  private updateMetrics(): void {
    let vertices = 0;
    let triangles = 0;
    for (const node of this.active.values()) {
      vertices += node.mesh.geometry.attributes.position.count;
      triangles += (node.mesh.geometry.index?.count ?? 0) / 3;
    }
    this.manager.setRenderMetrics(this.active.size, vertices, triangles);
  }

  private getCameraSignature(camera: THREE.Camera): string {
    const p = camera.position;
    if (camera instanceof THREE.OrthographicCamera) {
      return `o:${p.x.toFixed(1)}:${p.y.toFixed(1)}:${p.z.toFixed(1)}:${camera.zoom.toFixed(3)}`;
    }
    return `p:${p.x.toFixed(1)}:${p.y.toFixed(1)}:${p.z.toFixed(1)}`;
  }

  private trimUnusedPool(): void {
    let spareCount = 0;
    for (let i = this.pool.length - 1; i >= 0; i -= 1) {
      const node = this.pool[i];
      if (node.inUse) continue;
      spareCount += 1;
      if (spareCount <= this.sparePoolNodes) continue;
      this.group.remove(node.mesh);
      node.mesh.geometry.dispose();
      this.pool.splice(i, 1);
      const freeIndex = this.freeNodes.indexOf(node);
      if (freeIndex >= 0) this.freeNodes.splice(freeIndex, 1);
    }
  }

  private releaseStagedNodes(): void {
    for (const node of this.staged.values()) {
      this.releaseNode(node);
    }
    this.staged.clear();
    this.stagedSelectionId = '';
  }

  private cancelPendingBuilds(): void {
    for (const state of this.workers) {
      for (const pending of state.requests.values()) {
        pending.reject(new StaleTerrainBuildError());
      }
      state.requests.clear();
      state.pending = 0;
      state.tileCache.clear();
    }
  }

  private releaseNode(node: TerrainNode): void {
    node.inUse = false;
    node.mesh.visible = false;
    if (!this.freeNodes.includes(node)) {
      this.freeNodes.push(node);
    }
  }

  private applyVisualizationMode(): void {
    this.material.wireframe = this.visualizationMode === 'wireframe';
    this.material.vertexColors = this.visualizationMode === 'topo';
    this.material.color.set(this.visualizationMode === 'render' ? 0xf4f3ee : 0xdff8e9);
    this.material.roughness = this.visualizationMode === 'render' ? 0.96 : 0.82;
    this.material.metalness = 0;
    this.material.needsUpdate = true;
  }

  private ensureColorAttribute(geometry: THREE.PlaneGeometry): THREE.BufferAttribute {
    const existing = geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
    if (existing) return existing;
    const colors = new Float32Array(geometry.attributes.position.count * 3);
    const attribute = new THREE.BufferAttribute(colors, 3);
    geometry.setAttribute('color', attribute);
    return attribute;
  }

}

export type HydrologyDebugLayer = 'lake-fill' | 'basin-ids' | 'receivers' | 'flow-strength';

interface HydrologyDebugTile {
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  texture: THREE.DataTexture;
}

export class HydrologyDebugRenderer {
  readonly group = new THREE.Group();

  private readonly tiles: HydrologyDebugTile[] = [];
  private generation = 0;
  private loading = false;
  private layer: HydrologyDebugLayer = 'lake-fill';

  constructor(private readonly manager: TileManager) {
    this.group.visible = false;
  }

  setLayer(layer: HydrologyDebugLayer): void {
    if (this.layer === layer) return;
    this.layer = layer;
    this.clear();
    if (this.group.visible) void this.rebuild();
  }

  async rebuild(): Promise<void> {
    const config = this.manager.config;
    if (!config) {
      this.clear();
      return;
    }
    const generation = this.generation + 1;
    this.generation = generation;
    this.loading = true;
    this.clearTiles();

    const jobs: Array<{ x: number; y: number }> = [];
    for (let y = 0; y < config.tilesPerSide; y += 1) {
      for (let x = 0; x < config.tilesPerSide; x += 1) jobs.push({ x, y });
    }

    const concurrency = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
    const layerCache = new Map<string, Promise<Uint16Array | Uint32Array | Uint8Array | null>>();
    const readCached = (x: number, y: number): Promise<Uint16Array | Uint32Array | Uint8Array | null> => {
      if (x < 0 || y < 0 || x >= config.tilesPerSide || y >= config.tilesPerSide) return Promise.resolve(null);
      const id = `${x},${y}`;
      let pending = layerCache.get(id);
      if (!pending) {
        pending = this.readLayerTile(x, y);
        layerCache.set(id, pending);
      }
      return pending;
    };
    let nextJob = 0;
    try {
      await Promise.all(Array.from({ length: concurrency }, async () => {
        while (nextJob < jobs.length) {
          const job = jobs[nextJob];
          nextJob += 1;
          if (this.generation !== generation) return;
          const samples = await readCached(job.x, job.y);
          if (!samples || this.generation !== generation || this.manager.config?.id !== config.id) continue;
          if (this.layer === 'lake-fill' || this.layer === 'flow-strength') {
            const padded = await padScalarDebugTile(config, job.x, job.y, samples as Uint16Array, readCached);
            this.addTile(config, job.x, job.y, padded, config.tileSize + 2, true);
          } else {
            this.addTile(config, job.x, job.y, samples, config.tileSize, false);
          }
        }
      }));
    } finally {
      if (this.generation === generation) this.loading = false;
    }
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
    if (visible && !this.loading && this.tiles.length === 0) {
      void this.rebuild();
    }
  }

  clear(): void {
    this.generation += 1;
    this.loading = false;
    this.clearTiles();
  }

  dispose(): void {
    this.clear();
  }

  private addTile(
    config: WorldConfig,
    tileX: number,
    tileY: number,
    samples: Uint16Array | Uint32Array | Uint8Array,
    textureSize: number,
    padded: boolean
  ): void {
    const textureSamples = new Uint8Array(samples.length * 4);
    for (let i = 0; i < samples.length; i += 1) {
        const target = i * 4;
        if (this.layer === 'receivers') {
          const encoded = samples[i];
          const angle = encoded < DEBUG_DINF_TURN_STEPS ? encoded / DEBUG_DINF_TURN_STEPS * Math.PI * 2 : null;
          textureSamples[target] = angle === null ? 128 : Math.round(128 + Math.cos(angle) * 127);
          textureSamples[target + 1] = angle === null ? 128 : Math.round(128 + Math.sin(angle) * 127);
          textureSamples[target + 2] = 128;
        } else if (this.layer === 'basin-ids') {
          const id = samples[i] >>> 0;
          if (id !== 0) {
            const hash = Math.imul(id ^ (id >>> 16), 0x45d9f3b) >>> 0;
            textureSamples[target] = 55 + (hash & 0x9f);
            textureSamples[target + 1] = 55 + ((hash >>> 8) & 0x9f);
            textureSamples[target + 2] = 55 + ((hash >>> 16) & 0x9f);
          }
        } else if (this.layer === 'flow-strength') {
          const normalized = samples[i] / 65535;
          const value = Math.round(255 * normalized * normalized);
          textureSamples[target] = Math.round(value * 0.55);
          textureSamples[target + 1] = Math.round(value * 0.85);
          textureSamples[target + 2] = value;
        } else {
          const value = samples[i] >>> 8;
          textureSamples[target] = value;
          textureSamples[target + 1] = value;
          textureSamples[target + 2] = value;
        }
        textureSamples[target + 3] = 255;
    }
    const texture = new THREE.DataTexture(textureSamples, textureSize, textureSize, THREE.RGBAFormat, THREE.UnsignedByteType);
    texture.needsUpdate = true;
    texture.colorSpace = THREE.NoColorSpace;
    texture.flipY = true;
    texture.minFilter = this.layer === 'lake-fill' || this.layer === 'flow-strength' ? THREE.LinearFilter : THREE.NearestFilter;
    texture.magFilter = this.layer === 'lake-fill' || this.layer === 'flow-strength' ? THREE.LinearFilter : THREE.NearestFilter;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    if (padded) {
      texture.offset.set(1 / textureSize, 1 / textureSize);
      texture.repeat.set(config.tileSize / textureSize, config.tileSize / textureSize);
    }

    const geometry = new THREE.PlaneGeometry(config.tileSize * config.unitSize, config.tileSize * config.unitSize, 1, 1);
    geometry.rotateX(-Math.PI / 2);
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      side: THREE.DoubleSide,
      toneMapped: false
    });
    const mesh = new THREE.Mesh(geometry, material);
    const worldSize = config.tileSize * config.tilesPerSide * config.unitSize;
    mesh.position.set(
      (tileX + 0.5) * config.tileSize * config.unitSize - worldSize / 2,
      0,
      (tileY + 0.5) * config.tileSize * config.unitSize - worldSize / 2
    );
    mesh.renderOrder = 3;
    this.group.add(mesh);
    this.tiles.push({ mesh, texture });
  }

  private readLayerTile(tileX: number, tileY: number): Promise<Uint16Array | Uint32Array | Uint8Array | null> {
    const key = { x: tileX, y: tileY, d: 0 };
    if (this.layer === 'flow-strength') return this.manager.readFlowStrengthTile(key);
    if (this.layer === 'basin-ids') return this.manager.readBasinIdTile(key);
    if (this.layer === 'receivers') return this.manager.readReceiverDirectionTile(key);
    return this.manager.readLakeFillHeightTile(key);
  }

  private clearTiles(): void {
    for (const tile of this.tiles) {
      this.group.remove(tile.mesh);
      tile.mesh.geometry.dispose();
      tile.mesh.material.dispose();
      tile.texture.dispose();
    }
    this.tiles.length = 0;
  }
}

const DEBUG_DINF_TURN_STEPS = 65528;

async function padScalarDebugTile(
  config: WorldConfig,
  tileX: number,
  tileY: number,
  center: Uint16Array,
  read: (x: number, y: number) => Promise<Uint16Array | Uint32Array | Uint8Array | null>
): Promise<Uint16Array> {
  const size = config.tileSize;
  const stride = size + 2;
  const output = new Uint16Array(stride * stride);
  for (let y = 0; y < size; y += 1) output.set(center.subarray(y * size, (y + 1) * size), (y + 1) * stride + 1);
  const neighbors = await Promise.all([
    read(tileX - 1, tileY - 1), read(tileX, tileY - 1), read(tileX + 1, tileY - 1),
    read(tileX - 1, tileY), read(tileX + 1, tileY),
    read(tileX - 1, tileY + 1), read(tileX, tileY + 1), read(tileX + 1, tileY + 1)
  ]) as Array<Uint16Array | null>;
  const [nw, north, ne, west, east, sw, south, se] = neighbors;
  for (let i = 0; i < size; i += 1) {
    output[i + 1] = north?.[(size - 1) * size + i] ?? center[i];
    output[(size + 1) * stride + i + 1] = south?.[i] ?? center[(size - 1) * size + i];
    output[(i + 1) * stride] = west?.[i * size + size - 1] ?? center[i * size];
    output[(i + 1) * stride + size + 1] = east?.[i * size] ?? center[i * size + size - 1];
  }
  output[0] = nw?.[size * size - 1] ?? center[0];
  output[size + 1] = ne?.[(size - 1) * size] ?? center[size - 1];
  output[(size + 1) * stride] = sw?.[size - 1] ?? center[(size - 1) * size];
  output[(size + 2) * stride - 1] = se?.[0] ?? center[size * size - 1];
  return output;
}
