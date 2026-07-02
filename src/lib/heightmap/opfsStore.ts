import { R16HeightmapCodec } from './r16Codec';
import { tilePath, type TileKey } from './tileKey';
import { normalizeWorldConfig, type WorldConfig } from './worldConfig';
import { normalizeAuthoringDocument, type AuthoringDocumentV1 } from '../authoring/authoringDocument';

export interface TileMetricsSnapshot {
  cachedTiles: number;
  tileReadAvgMs: number;
  tileWriteAvgMs: number;
}

interface CacheEntry {
  key: string;
  samples: Uint16Array;
  lastUsed: number;
}

interface TileAccessOptions {
  cache?: boolean;
}

export class HeightmapTileStore {
  private root: FileSystemDirectoryHandle | null = null;
  private readonly cache = new Map<string, CacheEntry>();
  private readTotal = 0;
  private readCount = 0;
  private writeTotal = 0;
  private writeCount = 0;

  constructor(private readonly maxCacheTiles = 32) {}

  async openProject(projectId: string): Promise<void> {
    if (!navigator.storage?.getDirectory) {
      throw new Error('OPFS is not available in this browser.');
    }
    this.clearCache();
    const opfsRoot = await navigator.storage.getDirectory();
    const projects = await opfsRoot.getDirectoryHandle('worldforge-projects', { create: true });
    this.root = await projects.getDirectoryHandle(projectId, { create: true });
  }

  async writeConfig(config: WorldConfig): Promise<void> {
    const root = this.requireRoot();
    const handle = await root.getFileHandle('world.config.json', { create: true });
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify(config, null, 2));
    await writable.close();
  }

  async readConfig(): Promise<WorldConfig> {
    const root = this.requireRoot();
    const file = await (await root.getFileHandle('world.config.json')).getFile();
    return normalizeWorldConfig(JSON.parse(await file.text()));
  }

  async writeAuthoringDocument(document: AuthoringDocumentV1): Promise<void> {
    const root = this.requireRoot();
    const handle = await root.getFileHandle('authoring.json', { create: true });
    const writable = await handle.createWritable({ keepExistingData: false });
    await writable.write(JSON.stringify(document, null, 2));
    await writable.close();
  }

  async readAuthoringDocument(worldId: string): Promise<AuthoringDocumentV1> {
    const root = this.requireRoot();
    try {
      const file = await (await root.getFileHandle('authoring.json')).getFile();
      return normalizeAuthoringDocument(JSON.parse(await file.text()), worldId);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') {
        return normalizeAuthoringDocument(null, worldId);
      }
      if (error instanceof SyntaxError) {
        return normalizeAuthoringDocument(null, worldId);
      }
      throw error;
    }
  }

  async writeTile(key: TileKey, samples: Uint16Array, options: TileAccessOptions = {}): Promise<void> {
    const start = performance.now();
    const root = this.requireRoot();
    const pathParts = tilePath(key).split('/');
    const fileName = pathParts.pop();
    if (!fileName) throw new Error('Invalid tile path.');
    const dir = await this.ensureDirectory(root, pathParts);
    const handle = await dir.getFileHandle(fileName, { create: true });
    const writable = await handle.createWritable({ keepExistingData: false });
    await writable.write(R16HeightmapCodec.encode(samples));
    await writable.close();
    if (options.cache !== false) {
      this.setCache(key, samples);
    }
    this.writeTotal += performance.now() - start;
    this.writeCount += 1;
  }

  async writeWaterMaskTile(key: TileKey, samples: Uint16Array): Promise<void> {
    await this.writeMaskTile(waterMaskTilePath(key), samples, 'water mask');
  }

  async writeLakeFillHeightTile(key: TileKey, samples: Uint16Array): Promise<void> {
    await this.writeMaskTile(lakeFillHeightTilePath(key), samples, 'lake fill height');
  }

  async readLakeFillHeightTile(key: TileKey, tileSize: number): Promise<Uint16Array | null> {
    return this.readOptionalMaskTile(lakeFillHeightTilePath(key), tileSize);
  }

  private async writeMaskTile(path: string, samples: Uint16Array, label: string): Promise<void> {
    const root = this.requireRoot();
    const pathParts = path.split('/');
    const fileName = pathParts.pop();
    if (!fileName) throw new Error(`Invalid ${label} tile path.`);
    const dir = await this.ensureDirectory(root, pathParts);
    const handle = await dir.getFileHandle(fileName, { create: true });
    const writable = await handle.createWritable({ keepExistingData: false });
    await writable.write(R16HeightmapCodec.encode(samples));
    await writable.close();
  }

  async readWaterMaskTile(key: TileKey, tileSize: number): Promise<Uint16Array | null> {
    return this.readOptionalMaskTile(waterMaskTilePath(key), tileSize);
  }

  private async readOptionalMaskTile(path: string, tileSize: number): Promise<Uint16Array | null> {
    const root = this.requireRoot();
    try {
      const file = await (await this.getFile(root, path)).getFile();
      return R16HeightmapCodec.decode(await file.arrayBuffer(), tileSize);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') return null;
      throw error;
    }
  }

  async readTile(key: TileKey, tileSize: number, options: TileAccessOptions = {}): Promise<Uint16Array> {
    const id = tilePath(key);
    const shouldCache = options.cache !== false;
    const cached = shouldCache ? this.cache.get(id) : undefined;
    if (cached) {
      cached.lastUsed = performance.now();
      return cached.samples;
    }

    const start = performance.now();
    const root = this.requireRoot();
    const file = await (await this.getFile(root, tilePath(key))).getFile();
    const samples = R16HeightmapCodec.decode(await file.arrayBuffer(), tileSize);
    if (shouldCache) {
      this.setCache(key, samples);
    }
    this.readTotal += performance.now() - start;
    this.readCount += 1;
    return samples;
  }

  getMetrics(): TileMetricsSnapshot {
    return {
      cachedTiles: this.cache.size,
      tileReadAvgMs: this.readCount === 0 ? 0 : this.readTotal / this.readCount,
      tileWriteAvgMs: this.writeCount === 0 ? 0 : this.writeTotal / this.writeCount
    };
  }

  clearCache(): void {
    this.cache.clear();
  }

  private setCache(key: TileKey, samples: Uint16Array): void {
    this.cache.set(tilePath(key), { key: tilePath(key), samples, lastUsed: performance.now() });
    if (this.cache.size <= this.maxCacheTiles) return;
    const oldest = [...this.cache.values()].sort((a, b) => a.lastUsed - b.lastUsed)[0];
    if (oldest) this.cache.delete(oldest.key);
  }

  private requireRoot(): FileSystemDirectoryHandle {
    if (!this.root) throw new Error('No OPFS project is open.');
    return this.root;
  }

  private async ensureDirectory(root: FileSystemDirectoryHandle, parts: string[]): Promise<FileSystemDirectoryHandle> {
    let cursor = root;
    for (const part of parts) {
      cursor = await cursor.getDirectoryHandle(part, { create: true });
    }
    return cursor;
  }

  private async getFile(root: FileSystemDirectoryHandle, path: string): Promise<FileSystemFileHandle> {
    const parts = path.split('/');
    const fileName = parts.pop();
    if (!fileName) throw new Error('Invalid file path.');
    let cursor = root;
    for (const part of parts) {
      cursor = await cursor.getDirectoryHandle(part);
    }
    return cursor.getFileHandle(fileName);
  }
}

export function waterMaskTilePath(key: TileKey, extension = 'r16'): string {
  return `masks/water/d${key.d}/y${key.y}/x${key.x}.${extension}`;
}

export function lakeFillHeightTilePath(key: TileKey, extension = 'r16'): string {
  return `masks/lakes/d${key.d}/y${key.y}/x${key.x}.${extension}`;
}
