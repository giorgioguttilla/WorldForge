import { LodBuilder } from '../heightmap/lodBuilder';
import type { TileKey } from '../heightmap/tileKey';
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

export interface StructuralBakeResult {
  metadata: BakeMetadataV1;
  dirtyTiles: TileKey[];
  lodTileCount: number;
}

export async function bakeStructuralAuthoring(
  config: WorldConfig,
  document: AuthoringDocumentV1,
  waterLevel: number,
  io: BakeTileIO,
  onProgress?: (progress: BakeProgress) => void
): Promise<StructuralBakeResult> {
  const startedAt = new Date().toISOString();
  const dirtyTiles: TileKey[] = [];
  const tileCount = config.tilesPerSide * config.tilesPerSide;
  let written = 0;

  for (let y = 0; y < config.tilesPerSide; y += 1) {
    for (let x = 0; x < config.tilesPerSide; x += 1) {
      const key = { x, y, d: 0 };
      const samples = bakeDepthZeroTile(config, document, waterLevel, x, y);
      await io.writeTile(key, samples);
      dirtyTiles.push(key);
      written += 1;
      onProgress?.({
        phase: 'baking',
        current: written,
        total: tileCount,
        label: `Baking structural tiles ${written} / ${tileCount}`
      });
    }
  }

  const lodBuilder = new LodBuilder(io, config.tileSize, config.tilesPerSide);
  let lodTileCount = 0;
  const expectedLodTiles = countLodTiles(config.tilesPerSide);
  lodTileCount = await lodBuilder.rebuildFromDirty(dirtyTiles, (rebuilt) => {
    onProgress?.({
      phase: 'building-lod',
      current: rebuilt,
      total: expectedLodTiles,
      label: `Building LOD tiles ${rebuilt} / ${expectedLodTiles}`
    });
  });

  return {
    metadata: {
      id: crypto.randomUUID(),
      startedAt,
      completedAt: new Date().toISOString(),
      status: 'clean',
      inputHash: stableAuthoringHash(config, document, waterLevel),
      primitiveCount: document.primitives.filter((primitive) => primitive.enabled).length,
      tileCount,
    },
    dirtyTiles,
    lodTileCount
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

function countLodTiles(tilesPerSide: number): number {
  let total = 0;
  for (let side = tilesPerSide / 2; side >= 1; side /= 2) {
    total += side * side;
  }
  return total;
}
