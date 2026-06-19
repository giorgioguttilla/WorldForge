import { ancestorsForDirtyTile, childTileKeys, type TileKey, tileKeyToId } from './tileKey';
import { getMaxLodDepth } from './worldConfig';

export interface TileReadWrite {
  readTile(key: TileKey): Promise<Uint16Array>;
  writeTile(key: TileKey, samples: Uint16Array): Promise<void>;
}

export function downsample2x2Children(tileSize: number, children: Uint16Array[]): Uint16Array {
  if (children.length !== 4) {
    throw new Error('LOD downsample requires exactly four child tiles.');
  }

  const parent = new Uint16Array(tileSize * tileSize);
  const half = tileSize / 2;
  const childOffsets = [
    { child: children[0], xOffset: 0, yOffset: 0 },
    { child: children[1], xOffset: half, yOffset: 0 },
    { child: children[2], xOffset: 0, yOffset: half },
    { child: children[3], xOffset: half, yOffset: half }
  ];

  for (const { child, xOffset, yOffset } of childOffsets) {
    for (let y = 0; y < half; y += 1) {
      for (let x = 0; x < half; x += 1) {
        const sx = x * 2;
        const sy = y * 2;
        const i0 = sy * tileSize + sx;
        const average = (child[i0] + child[i0 + 1] + child[i0 + tileSize] + child[i0 + tileSize + 1]) / 4;
        parent[(y + yOffset) * tileSize + x + xOffset] = Math.round(average);
      }
    }
  }

  return parent;
}

export class LodBuilder {
  constructor(
    private readonly io: TileReadWrite,
    private readonly tileSize: number,
    private readonly fullTilesPerSide: number
  ) {}

  getDirtyAncestors(dirtyTiles: TileKey[]): TileKey[] {
    const unique = new Map<string, TileKey>();
    for (const tile of dirtyTiles) {
      for (const ancestor of ancestorsForDirtyTile(tile, this.fullTilesPerSide)) {
        unique.set(tileKeyToId(ancestor), ancestor);
      }
    }
    return [...unique.values()].sort((a, b) => a.d - b.d || a.y - b.y || a.x - b.x);
  }

  async rebuildFromDirty(dirtyTiles: TileKey[]): Promise<number> {
    const maxDepth = getMaxLodDepth(this.fullTilesPerSide);
    let rebuilt = 0;

    for (let depth = 1; depth <= maxDepth; depth += 1) {
      const parents = this.getDirtyAncestors(dirtyTiles).filter((key) => key.d === depth);
      for (const parent of parents) {
        const children = await Promise.all(childTileKeys(parent).map((child) => this.io.readTile(child)));
        const downsampled = downsample2x2Children(this.tileSize, children);
        await this.io.writeTile(parent, downsampled);
        rebuilt += 1;
      }
    }

    return rebuilt;
  }
}
