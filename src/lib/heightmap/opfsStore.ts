import { R16HeightmapCodec } from './r16Codec';
import { tilePath, type TileKey } from './tileKey';
import { normalizeWorldConfig, type WorldConfig } from './worldConfig';
import { normalizeAuthoringDocument, type AuthoringDocumentV1 } from '../authoring/authoringDocument';
import type { HydrologyTopologyV2 } from '../authoring/hydrologyBake';

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
  private readonly directoryCache = new Map<string, FileSystemDirectoryHandle>();
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
    this.directoryCache.clear();
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

  async writeDrainageSurfaceTile(key: TileKey, samples: Uint16Array): Promise<void> {
    await this.writeMaskTile(drainageSurfaceTilePath(key), samples, 'drainage surface');
  }

  async writeFlowStrengthTile(key: TileKey, samples: Uint16Array): Promise<void> {
    await this.writeMaskTile(flowStrengthTilePath(key), samples, 'flow strength');
  }

  async writeBasinIdTile(key: TileKey, samples: Uint32Array): Promise<void> {
    await this.writeTypedTile(basinIdTilePath(key), samples, 'basin id');
  }

  async writeReceiverDirectionTile(key: TileKey, samples: Uint16Array): Promise<void> {
    await this.writeTypedTile(receiverDirectionTilePath(key), samples, 'receiver direction');
  }

  async writeFlatDistanceTile(key: TileKey, samples: Uint32Array): Promise<void> {
    await this.writeTypedTile(flatDistanceTilePath(key), samples, 'flat distance');
  }

  async writeFlowAccumulationTile(key: TileKey, samples: Float32Array): Promise<void> {
    await this.writeTypedTile(flowAccumulationTilePath(key), samples, 'flow accumulation');
  }

  async writeHydrologyTopology(topology: HydrologyTopologyV2): Promise<void> {
    await Promise.all([
      this.writeTypedTile('hydrology/basin-ids.u32', topology.basinIds, 'hydrology basin ids'),
      this.writeTypedTile('hydrology/fill-heights.u16', topology.fillHeights, 'hydrology fill heights'),
      this.writeTypedTile('hydrology/downstream-ids.u32', topology.downstreamIds, 'hydrology downstream ids'),
      this.writeTypedTile('hydrology/spill-cells.u32', topology.spillCells, 'hydrology spill cells'),
      this.writeTypedTile('hydrology/downstream-cells.u32', topology.downstreamCells, 'hydrology downstream cells')
    ]);
    const root = this.requireRoot();
    const dir = await this.ensureDirectory(root, ['hydrology']);
    const handle = await dir.getFileHandle('topology.json', { create: true });
    const writable = await handle.createWritable({ keepExistingData: false });
    await writable.write(JSON.stringify({
      version: topology.version,
      width: topology.width,
      height: topology.height,
      nodeCount: topology.nodeCount,
      receiverEncoding: topology.receiverEncoding,
      arrayLength: topology.fillHeights.length,
      basinIds: 'basin-ids.u32',
      fillHeights: 'fill-heights.u16',
      downstreamIds: 'downstream-ids.u32',
      spillCells: 'spill-cells.u32',
      downstreamCells: 'downstream-cells.u32'
    }, null, 2));
    await writable.close();
  }

  async readHydrologyTopology(): Promise<HydrologyTopologyV2 | null> {
    const root = this.requireRoot();
    try {
      const file = await (await this.getFile(root, 'hydrology/topology.json')).getFile();
      const metadata = JSON.parse(await file.text()) as Record<string, unknown>;
      const length = Math.max(0, Math.trunc(Number(metadata.arrayLength)));
      if (metadata.version !== 2 || metadata.receiverEncoding !== 'd-infinity-angle-u16-turn65528' || length < 1) return null;
      const [basinIds, fillHeights, downstreamIds, spillCells, downstreamCells] = await Promise.all([
        this.readOptionalBinaryTile('hydrology/basin-ids.u32', length * Uint32Array.BYTES_PER_ELEMENT),
        this.readOptionalBinaryTile('hydrology/fill-heights.u16', length * Uint16Array.BYTES_PER_ELEMENT),
        this.readOptionalBinaryTile('hydrology/downstream-ids.u32', length * Uint32Array.BYTES_PER_ELEMENT),
        this.readOptionalBinaryTile('hydrology/spill-cells.u32', length * Uint32Array.BYTES_PER_ELEMENT),
        this.readOptionalBinaryTile('hydrology/downstream-cells.u32', length * Uint32Array.BYTES_PER_ELEMENT)
      ]);
      if (!basinIds || !fillHeights || !downstreamIds || !spillCells || !downstreamCells) throw new Error('Hydrology topology arrays are incomplete.');
      return {
        version: 2,
        width: Number(metadata.width),
        height: Number(metadata.height),
        nodeCount: Number(metadata.nodeCount),
        receiverEncoding: 'd-infinity-angle-u16-turn65528',
        basinIds: new Uint32Array(basinIds),
        fillHeights: new Uint16Array(fillHeights),
        downstreamIds: new Uint32Array(downstreamIds),
        spillCells: new Uint32Array(spillCells),
        downstreamCells: new Uint32Array(downstreamCells)
      };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') return null;
      throw error;
    }
  }

  async readLakeFillHeightTile(key: TileKey, tileSize: number): Promise<Uint16Array | null> {
    return this.readOptionalMaskTile(lakeFillHeightTilePath(key), tileSize);
  }

  async readDrainageSurfaceTile(key: TileKey, tileSize: number): Promise<Uint16Array | null> {
    return this.readOptionalMaskTile(drainageSurfaceTilePath(key), tileSize);
  }

  async readFlowStrengthTile(key: TileKey, tileSize: number): Promise<Uint16Array | null> {
    return this.readOptionalMaskTile(flowStrengthTilePath(key), tileSize);
  }

  async readBasinIdTile(key: TileKey, tileSize: number): Promise<Uint32Array | null> {
    const buffer = await this.readOptionalBinaryTile(basinIdTilePath(key), tileSize * tileSize * Uint32Array.BYTES_PER_ELEMENT);
    return buffer ? new Uint32Array(buffer) : null;
  }

  async readReceiverDirectionTile(key: TileKey, tileSize: number): Promise<Uint16Array | null> {
    const buffer = await this.readOptionalBinaryTile(receiverDirectionTilePath(key), tileSize * tileSize * Uint16Array.BYTES_PER_ELEMENT);
    return buffer ? new Uint16Array(buffer) : null;
  }

  async readFlatDistanceTile(key: TileKey, tileSize: number): Promise<Uint32Array | null> {
    const buffer = await this.readOptionalBinaryTile(flatDistanceTilePath(key), tileSize * tileSize * Uint32Array.BYTES_PER_ELEMENT);
    return buffer ? new Uint32Array(buffer) : null;
  }

  async readFlowAccumulationTile(key: TileKey, tileSize: number): Promise<Float32Array | null> {
    const buffer = await this.readOptionalBinaryTile(flowAccumulationTilePath(key), tileSize * tileSize * Float32Array.BYTES_PER_ELEMENT);
    return buffer ? new Float32Array(buffer) : null;
  }

  private async writeTypedTile(path: string, samples: ArrayBufferView, label: string): Promise<void> {
    const root = this.requireRoot();
    const pathParts = path.split('/');
    const fileName = pathParts.pop();
    if (!fileName) throw new Error(`Invalid ${label} tile path.`);
    const dir = await this.ensureDirectory(root, pathParts);
    const handle = await dir.getFileHandle(fileName, { create: true });
    const writable = await handle.createWritable({ keepExistingData: false });
    const buffer = samples.byteOffset === 0 && samples.byteLength === samples.buffer.byteLength && samples.buffer instanceof ArrayBuffer
      ? samples.buffer
      : samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength) as ArrayBuffer;
    await writable.write(buffer);
    await writable.close();
  }

  private async readOptionalBinaryTile(path: string, expectedBytes: number): Promise<ArrayBuffer | null> {
    const root = this.requireRoot();
    try {
      const file = await (await this.getFile(root, path)).getFile();
      const buffer = await file.arrayBuffer();
      if (buffer.byteLength !== expectedBytes) throw new Error(`Invalid binary tile byte length at ${path}: expected ${expectedBytes}, got ${buffer.byteLength}.`);
      return buffer;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') return null;
      throw error;
    }
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
    let path = '';
    for (const part of parts) {
      path = path ? `${path}/${part}` : part;
      const cached = this.directoryCache.get(path);
      if (cached) {
        cursor = cached;
        continue;
      }
      cursor = await cursor.getDirectoryHandle(part, { create: true });
      this.directoryCache.set(path, cursor);
    }
    return cursor;
  }

  private async getFile(root: FileSystemDirectoryHandle, path: string): Promise<FileSystemFileHandle> {
    const parts = path.split('/');
    const fileName = parts.pop();
    if (!fileName) throw new Error('Invalid file path.');
    let cursor = root;
    let directoryPath = '';
    for (const part of parts) {
      directoryPath = directoryPath ? `${directoryPath}/${part}` : part;
      const cached = this.directoryCache.get(directoryPath);
      if (cached) {
        cursor = cached;
        continue;
      }
      cursor = await cursor.getDirectoryHandle(part);
      this.directoryCache.set(directoryPath, cursor);
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

export function drainageSurfaceTilePath(key: TileKey, extension = 'r16'): string {
  return `hydrology/drainage-surface/d${key.d}/y${key.y}/x${key.x}.${extension}`;
}

export function flowStrengthTilePath(key: TileKey, extension = 'r16'): string {
  return `masks/flow-strength/d${key.d}/y${key.y}/x${key.x}.${extension}`;
}

export function basinIdTilePath(key: TileKey, extension = 'u32'): string {
  return `masks/basin-ids/d${key.d}/y${key.y}/x${key.x}.${extension}`;
}

export function receiverDirectionTilePath(key: TileKey, extension = 'u16'): string {
  return `masks/receivers/d${key.d}/y${key.y}/x${key.x}.${extension}`;
}

export function flatDistanceTilePath(key: TileKey, extension = 'u32'): string {
  return `hydrology/flat-distance/d${key.d}/y${key.y}/x${key.x}.${extension}`;
}

export function flowAccumulationTilePath(key: TileKey, extension = 'f32'): string {
  return `masks/flow-accumulation/d${key.d}/y${key.y}/x${key.x}.${extension}`;
}
