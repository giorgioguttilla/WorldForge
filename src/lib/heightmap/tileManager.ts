import { LodBuilder } from './lodBuilder';
import { generateNoiseTile } from './noise';
import { HeightmapTileStore, type TileMetricsSnapshot } from './opfsStore';
import { encodeGrayscale16Png } from './png16';
import { assertTileKey, tilePath, tilesPerSideAtDepth, type TileKey } from './tileKey';
import { createWorldConfig, getMaxLodDepth, type WorldConfig, type WorldConfigInput } from './worldConfig';

export interface EditorMetrics extends TileMetricsSnapshot {
  renderedTiles: number;
  triangles: number;
  vertices: number;
  ramUsedMb: number;
  ramLimitMb: number;
  lodRebuildMs: number;
  lastGeneratedTiles: number;
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
    lodRebuildMs: 0,
    lastGeneratedTiles: 0
  };

  constructor(store = new HeightmapTileStore()) {
    this.store = store;
  }

  async createWorld(input: WorldConfigInput, options: { replaceProjectId?: string } = {}): Promise<WorldConfig> {
    if (options.replaceProjectId) {
      await this.deleteProject(options.replaceProjectId);
    }

    const config = createWorldConfig(input);
    await this.store.openProject(config.id);
    await this.store.writeConfig(config);
    await this.registerProject(config);
    this.config = config;

    const dirty: TileKey[] = [];
    let generated = 0;
    for (let y = 0; y < config.tilesPerSide; y += 1) {
      for (let x = 0; x < config.tilesPerSide; x += 1) {
        const key = { x, y, d: 0 };
        const samples = generateNoiseTile(config.tileSize, x, y, 137);
        await this.store.writeTile(key, samples);
        dirty.push(key);
        generated += 1;
      }
    }

    const start = performance.now();
    const lodBuilder = this.createLodBuilder();
    await lodBuilder.rebuildFromDirty(dirty);
    this.metrics.lodRebuildMs = performance.now() - start;
    this.metrics.lastGeneratedTiles = generated;
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
      return JSON.parse(await file.text()) as WorldConfig[];
    } catch {
      return [];
    }
  }

  async openProject(projectId: string): Promise<WorldConfig> {
    await this.store.openProject(projectId);
    const config = await this.store.readConfig();
    this.config = config;
    this.store.clearCache();
    this.refreshStoreMetrics();
    return config;
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
        lodRebuildMs: 0,
        lastGeneratedTiles: 0
      };
    }
  }

  async readTile(key: TileKey): Promise<Uint16Array> {
    const config = this.requireConfig();
    assertTileKey(key, config.tilesPerSide);
    const samples = await this.store.readTile(key, config.tileSize);
    this.refreshStoreMetrics();
    return samples;
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
          const samples = await this.readTile(key);
          const blob = await encodeGrayscale16Png(config.tileSize, config.tileSize, samples);
          await this.writeBlobFile(directory, tilePath(key, 'png'), blob);
        }
      }
    }
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
        readTile: (key) => this.store.readTile(key, config.tileSize),
        writeTile: (key, samples) => this.store.writeTile(key, samples)
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
  }
}
