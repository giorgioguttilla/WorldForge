import { LodBuilder } from './lodBuilder';
import { createHeightmapComputeBackend, type HeightmapComputeBackend } from './gpuHeightmapCompute';
import { HeightmapTileStore, waterMaskTilePath, type TileMetricsSnapshot } from './opfsStore';
import { encodeGrayscale16Png } from './png16';
import { assertTileKey, tilePath, tilesPerSideAtDepth, type TileKey } from './tileKey';
import { createWorldConfig, getMaxLodDepth, normalizeWaterConfig, normalizeWorldConfig, r16ToElevation, type WaterConfig, type WorldConfig, type WorldConfigInput } from './worldConfig';
import { createEmptyAuthoringDocument, type AuthoringDocumentV1 } from '../authoring/authoringDocument';
import { bakeStructuralAuthoring, createFailedBakeMetadata, type BakeProgress } from '../authoring/structuralBake';

export interface EditorMetrics extends TileMetricsSnapshot {
  renderedTiles: number;
  triangles: number;
  vertices: number;
  ramUsedMb: number;
  ramLimitMb: number;
  computeBackend: string;
  lodRebuildMs: number;
  lastGeneratedTiles: number;
}

export interface BulkProgress {
  phase: 'generating' | BakeProgress['phase'];
  current: number;
  total: number;
  label: string;
}

export class TileManager {
  readonly store: HeightmapTileStore;
  config: WorldConfig | null = null;
  metrics: EditorMetrics = {
    cachedTiles: 0,
    tileReadAvgMs: 0,
    tileWriteAvgMs: 0,
    renderedTiles: 0,
    triangles: 0,
    vertices: 0,
    ramUsedMb: 0,
    ramLimitMb: 0,
    computeBackend: 'initializing',
    lodRebuildMs: 0,
    lastGeneratedTiles: 0
  };
  private computeBackend: HeightmapComputeBackend | null = null;

  constructor(store = new HeightmapTileStore()) {
    this.store = store;
  }

  dispose(): void {
    this.computeBackend?.dispose?.();
    this.computeBackend = null;
  }

  async initializeComputeBackend(): Promise<string> {
    return (await this.getComputeBackend()).label;
  }

  async createWorld(input: WorldConfigInput, options: { replaceProjectId?: string; onProgress?: (progress: BulkProgress) => void } = {}): Promise<WorldConfig> {
    if (options.replaceProjectId) {
      await this.deleteProject(options.replaceProjectId);
    }

    const config = createWorldConfig(input);
    await this.store.openProject(config.id);
    await this.store.writeConfig(config);
    await this.store.writeAuthoringDocument(createEmptyAuthoringDocument(config.id));
    await this.registerProject(config);
    this.config = config;

    const dirty: TileKey[] = [];
    let generated = 0;
    const fullTileCount = config.tilesPerSide * config.tilesPerSide;
    const lodTileCount = this.countLodTiles(config.tilesPerSide);
    for (let y = 0; y < config.tilesPerSide; y += 1) {
      for (let x = 0; x < config.tilesPerSide; x += 1) {
        const key = { x, y, d: 0 };
        const samples = new Uint16Array(config.tileSize * config.tileSize);
        await this.store.writeTile(key, samples, { cache: false });
        dirty.push(key);
        generated += 1;
        options.onProgress?.({
          phase: 'generating',
          current: generated,
          total: fullTileCount,
          label: `Generating height tiles ${generated} / ${fullTileCount}`
        });
      }
    }

    const start = performance.now();
    const lodBuilder = this.createLodBuilder();
    await lodBuilder.rebuildFromDirty(dirty, (rebuilt) => {
      options.onProgress?.({
        phase: 'building-lod',
        current: rebuilt,
        total: lodTileCount,
        label: `Building LOD tiles ${rebuilt} / ${lodTileCount}`
      });
    });
    this.metrics.lodRebuildMs = performance.now() - start;
    this.metrics.lastGeneratedTiles = generated;
    this.store.clearCache();
    this.refreshStoreMetrics();
    return config;
  }

  async listProjects(): Promise<WorldConfig[]> {
    if (!navigator.storage?.getDirectory) {
      throw new Error('OPFS is not available in this browser.');
    }
    const opfsRoot = await navigator.storage.getDirectory();
    const projects = await opfsRoot.getDirectoryHandle('worldforge-projects', { create: true });
    try {
      const file = await (await projects.getFileHandle('index.json')).getFile();
      return (JSON.parse(await file.text()) as WorldConfig[]).map((project) => normalizeWorldConfig(project));
    } catch {
      return [];
    }
  }

  async openProject(projectId: string): Promise<WorldConfig> {
    await this.store.openProject(projectId);
    const config = await this.store.readConfig();
    this.config = config;
    localStorage.setItem('worldforge:lastProjectId', config.id);
    this.store.clearCache();
    this.refreshStoreMetrics();
    return config;
  }

  async openLastProject(): Promise<WorldConfig | null> {
    const projectId = localStorage.getItem('worldforge:lastProjectId');
    if (!projectId) return null;
    try {
      return await this.openProject(projectId);
    } catch {
      localStorage.removeItem('worldforge:lastProjectId');
      return null;
    }
  }

  async updateWaterConfig(water: WaterConfig): Promise<WorldConfig> {
    const config = this.requireConfig();
    const updated: WorldConfig = {
      ...config,
      water: normalizeWaterConfig(water),
      updatedAt: new Date().toISOString()
    };
    await this.store.writeConfig(updated);
    await this.registerProject(updated);
    this.config = updated;
    return updated;
  }

  async loadAuthoringDocument(): Promise<AuthoringDocumentV1> {
    const config = this.requireConfig();
    return this.store.readAuthoringDocument(config.id);
  }

  async saveAuthoringDocument(document: AuthoringDocumentV1): Promise<AuthoringDocumentV1> {
    const config = this.requireConfig();
    const normalized: AuthoringDocumentV1 = {
      ...document,
      version: 1,
      worldId: config.id
    };
    await this.store.writeAuthoringDocument(normalized);
    return normalized;
  }

  async bakeAuthoringDocument(document: AuthoringDocumentV1, waterLevel: number, onProgress?: (progress: BulkProgress) => void, options: { debugTelemetry?: boolean; preferWebGpu?: boolean } = {}): Promise<AuthoringDocumentV1> {
    const config = this.requireConfig();
    const normalized: AuthoringDocumentV1 = {
      ...document,
      version: 1,
      worldId: config.id
    };
    try {
      const start = performance.now();
      const result = await bakeStructuralAuthoring(
        config,
        normalized,
        waterLevel,
        {
          readTile: (key) => this.store.readTile(key, config.tileSize, { cache: false }),
          writeTile: (key, samples) => this.store.writeTile(key, samples, { cache: false }),
          readWaterMaskTile: (key) => this.store.readWaterMaskTile(key, config.tileSize),
          writeWaterMaskTile: (key, samples) => this.store.writeWaterMaskTile(key, samples)
        },
        onProgress,
        options
      );
      this.metrics.lodRebuildMs = performance.now() - start;
      this.metrics.lastGeneratedTiles = result.dirtyTiles.length;
      const baked = { ...normalized, rivers: result.rivers, lastBake: result.metadata };
      await this.store.writeAuthoringDocument(baked);
      this.store.clearCache();
      this.refreshStoreMetrics();
      return baked;
    } catch (error) {
      const failed = { ...normalized, lastBake: createFailedBakeMetadata(config, normalized, waterLevel, error) };
      await this.store.writeAuthoringDocument(failed);
      this.store.clearCache();
      this.refreshStoreMetrics();
      return failed;
    }
  }

  async deleteProject(projectId: string): Promise<void> {
    if (!navigator.storage?.getDirectory) {
      throw new Error('OPFS is not available in this browser.');
    }

    const opfsRoot = await navigator.storage.getDirectory();
    const projects = await opfsRoot.getDirectoryHandle('worldforge-projects', { create: true });
    try {
      await projects.removeEntry(projectId, { recursive: true });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error;
    }

    let index: WorldConfig[] = [];
    try {
      const file = await (await projects.getFileHandle('index.json')).getFile();
      index = JSON.parse(await file.text()) as WorldConfig[];
    } catch {
      index = [];
    }

    const next = index.filter((project) => project.id !== projectId);
    const handle = await projects.getFileHandle('index.json', { create: true });
    const writable = await handle.createWritable({ keepExistingData: false });
    await writable.write(JSON.stringify(next, null, 2));
    await writable.close();

    if (this.config?.id === projectId) {
      this.config = null;
      this.store.clearCache();
      this.metrics = {
        cachedTiles: 0,
        tileReadAvgMs: 0,
        tileWriteAvgMs: 0,
        renderedTiles: 0,
        triangles: 0,
        vertices: 0,
        ramUsedMb: 0,
        ramLimitMb: 0,
        computeBackend: this.computeBackend?.label ?? 'initializing',
        lodRebuildMs: 0,
        lastGeneratedTiles: 0
      };
    }

    if (localStorage.getItem('worldforge:lastProjectId') === projectId) {
      localStorage.removeItem('worldforge:lastProjectId');
    }
  }

  async readTile(key: TileKey): Promise<Uint16Array> {
    const config = this.requireConfig();
    assertTileKey(key, config.tilesPerSide);
    const samples = await this.store.readTile(key, config.tileSize);
    this.refreshStoreMetrics();
    return samples;
  }

  async sampleHeightAtWorld(worldX: number, worldZ: number): Promise<number | null> {
    const config = this.requireConfig();
    const worldSize = config.tileSize * config.tilesPerSide * config.unitSize;
    const localX = worldX + worldSize / 2;
    const localZ = worldZ + worldSize / 2;
    if (localX < 0 || localZ < 0 || localX > worldSize || localZ > worldSize) return null;

    const pixelX = Math.min(config.tileSize * config.tilesPerSide - 1.001, localX / config.unitSize);
    const pixelY = Math.min(config.tileSize * config.tilesPerSide - 1.001, localZ / config.unitSize);
    const tileX = Math.floor(pixelX / config.tileSize);
    const tileY = Math.floor(pixelY / config.tileSize);
    const sampleX = pixelX - tileX * config.tileSize;
    const sampleY = pixelY - tileY * config.tileSize;
    const samples = await this.readTile({ x: tileX, y: tileY, d: 0 });

    const x0 = Math.max(0, Math.min(config.tileSize - 1, Math.floor(sampleX)));
    const y0 = Math.max(0, Math.min(config.tileSize - 1, Math.floor(sampleY)));
    const x1 = Math.min(config.tileSize - 1, x0 + 1);
    const y1 = Math.min(config.tileSize - 1, y0 + 1);
    const tx = sampleX - x0;
    const ty = sampleY - y0;
    const h00 = samples[y0 * config.tileSize + x0];
    const h10 = samples[y0 * config.tileSize + x1];
    const h01 = samples[y1 * config.tileSize + x0];
    const h11 = samples[y1 * config.tileSize + x1];
    const top = h00 + (h10 - h00) * tx;
    const bottom = h01 + (h11 - h01) * tx;
    return r16ToElevation(top + (bottom - top) * ty, config.worldHeight);
  }

  async exportToDirectory(directory: FileSystemDirectoryHandle): Promise<void> {
    const config = this.requireConfig();
    await this.writeTextFile(directory, 'world.config.json', JSON.stringify(config, null, 2));

    const maxDepth = getMaxLodDepth(config.tilesPerSide);
    for (let d = 0; d <= maxDepth; d += 1) {
      const side = tilesPerSideAtDepth(config.tilesPerSide, d);
      for (let y = 0; y < side; y += 1) {
        for (let x = 0; x < side; x += 1) {
          const key = { x, y, d };
          const samples = await this.store.readTile(key, config.tileSize, { cache: false });
          const blob = await encodeGrayscale16Png(config.tileSize, config.tileSize, samples);
          await this.writeBlobFile(directory, tilePath(key, 'png'), blob);
          if (d === 0) {
            const waterMask = await this.store.readWaterMaskTile(key, config.tileSize);
            if (waterMask) {
              const maskBlob = await encodeGrayscale16Png(config.tileSize, config.tileSize, waterMask);
              await this.writeBlobFile(directory, waterMaskTilePath(key, 'png'), maskBlob);
            }
          }
        }
      }
    }
    this.store.clearCache();
    this.refreshStoreMetrics();
  }

  setRenderMetrics(renderedTiles: number, vertices: number, triangles: number): void {
    this.metrics.renderedTiles = renderedTiles;
    this.metrics.vertices = vertices;
    this.metrics.triangles = triangles;
    this.refreshStoreMetrics();
  }

  private createLodBuilder(): LodBuilder {
    const config = this.requireConfig();
    return new LodBuilder(
      {
        readTile: (key) => this.store.readTile(key, config.tileSize, { cache: false }),
        writeTile: (key, samples) => this.store.writeTile(key, samples, { cache: false })
      },
      config.tileSize,
      config.tilesPerSide
    );
  }

  private refreshStoreMetrics(): void {
    Object.assign(this.metrics, this.store.getMetrics());
    const memory = (performance as Performance & { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
    this.metrics.ramUsedMb = memory ? memory.usedJSHeapSize / 1024 / 1024 : 0;
    this.metrics.ramLimitMb = memory ? memory.jsHeapSizeLimit / 1024 / 1024 : 0;
    this.metrics.computeBackend = this.computeBackend?.label ?? this.metrics.computeBackend;
  }

  private async getComputeBackend(): Promise<HeightmapComputeBackend> {
    this.computeBackend ??= await createHeightmapComputeBackend();
    this.metrics.computeBackend = this.computeBackend.label;
    return this.computeBackend;
  }

  private countLodTiles(tilesPerSide: number): number {
    let total = 0;
    for (let side = tilesPerSide / 2; side >= 1; side /= 2) {
      total += side * side;
    }
    return total;
  }

  private requireConfig(): WorldConfig {
    if (!this.config) throw new Error('No active world.');
    return this.config;
  }

  private async writeTextFile(directory: FileSystemDirectoryHandle, path: string, text: string): Promise<void> {
    await this.writeBlobFile(directory, path, new Blob([text], { type: 'application/json' }));
  }

  private async writeBlobFile(directory: FileSystemDirectoryHandle, path: string, blob: Blob): Promise<void> {
    const parts = path.split('/');
    const fileName = parts.pop();
    if (!fileName) throw new Error('Invalid export path.');
    let cursor = directory;
    for (const part of parts) {
      cursor = await cursor.getDirectoryHandle(part, { create: true });
    }
    const handle = await cursor.getFileHandle(fileName, { create: true });
    const writable = await handle.createWritable({ keepExistingData: false });
    await writable.write(blob);
    await writable.close();
  }

  private async registerProject(config: WorldConfig): Promise<void> {
    const opfsRoot = await navigator.storage.getDirectory();
    const projects = await opfsRoot.getDirectoryHandle('worldforge-projects', { create: true });
    let index: WorldConfig[] = [];
    try {
      const file = await (await projects.getFileHandle('index.json')).getFile();
      index = JSON.parse(await file.text()) as WorldConfig[];
    } catch {
      index = [];
    }
    const next = [config, ...index.filter((project) => project.id !== config.id)];
    const handle = await projects.getFileHandle('index.json', { create: true });
    const writable = await handle.createWritable({ keepExistingData: false });
    await writable.write(JSON.stringify(next, null, 2));
    await writable.close();
    localStorage.setItem('worldforge:lastProjectId', config.id);
  }
}
