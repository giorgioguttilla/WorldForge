import { getMaxLodDepth } from './worldConfig';

export interface TileKey {
  x: number;
  y: number;
  d: number;
}

export function tileKeyToId(key: TileKey): string {
  return `d${key.d}/y${key.y}/x${key.x}`;
}

export function tilePath(key: TileKey, extension = 'r16'): string {
  return `tiles/d${key.d}/y${key.y}/x${key.x}.${extension}`;
}

export function tilesPerSideAtDepth(fullTilesPerSide: number, depth: number): number {
  return fullTilesPerSide / 2 ** depth;
}

export function assertTileKey(key: TileKey, fullTilesPerSide: number): void {
  const maxDepth = getMaxLodDepth(fullTilesPerSide);
  if (!Number.isInteger(key.d) || key.d < 0 || key.d > maxDepth) {
    throw new Error(`Invalid tile depth ${key.d}.`);
  }
  const side = tilesPerSideAtDepth(fullTilesPerSide, key.d);
  if (!Number.isInteger(key.x) || !Number.isInteger(key.y) || key.x < 0 || key.y < 0 || key.x >= side || key.y >= side) {
    throw new Error(`Tile ${tileKeyToId(key)} is outside the world.`);
  }
}

export function parentTileKey(key: TileKey): TileKey | null {
  if (key.d < 0) throw new Error('Tile depth cannot be negative.');
  if (key.d === Number.MAX_SAFE_INTEGER) throw new Error('Tile depth is too large.');
  return { x: Math.floor(key.x / 2), y: Math.floor(key.y / 2), d: key.d + 1 };
}

export function childTileKeys(parent: TileKey): TileKey[] {
  if (parent.d <= 0) return [];
  const d = parent.d - 1;
  const x = parent.x * 2;
  const y = parent.y * 2;
  return [
    { x, y, d },
    { x: x + 1, y, d },
    { x, y: y + 1, d },
    { x: x + 1, y: y + 1, d }
  ];
}

export function ancestorsForDirtyTile(key: TileKey, fullTilesPerSide: number): TileKey[] {
  const maxDepth = getMaxLodDepth(fullTilesPerSide);
  const ancestors: TileKey[] = [];
  let cursor = key;
  while (cursor.d < maxDepth) {
    const parent = parentTileKey(cursor);
    if (!parent) break;
    ancestors.push(parent);
    cursor = parent;
  }
  return ancestors;
}
