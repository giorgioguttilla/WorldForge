import { describe, expect, it } from 'vitest';
import { r16ToElevation, type WorldConfig } from '../heightmap/worldConfig';
import { tileKeyToId, type TileKey } from '../heightmap/tileKey';
import { createEmptyAuthoringDocument, type AuthoringDocumentV1 } from './authoringDocument';
import { bakeStructuralAuthoring } from './structuralBake';

const config: WorldConfig = {
  id: 'world',
  name: 'World',
  tileSize: 2,
  tilesPerSide: 2,
  unitSize: 1,
  unit: 'meter',
  worldHeight: 100,
  water: { visible: false, level: 10 },
  createdAt: 'now',
  updatedAt: 'now',
  version: 1
};

describe('structural bake', () => {
  it('writes depth-0 tiles, rebuilds LODs, and records metadata', async () => {
    const tiles = new Map<string, Uint16Array>();
    const writes: TileKey[] = [];
    const document: AuthoringDocumentV1 = {
      ...createEmptyAuthoringDocument('world'),
      version: 1,
      worldId: 'world',
      fieldLibrary: [],
      primitives: [{
        id: 'plateau',
        type: 'landformArea',
        name: 'Plateau',
        enabled: true,
        createdAt: 'a',
        updatedAt: 'a',
        mode: 'plateau',
        elevation: 80,
        noiseScale: 80,
        edgeSmoothness: 0,
        priority: 0,
        anchors: [
          { id: 'a', x: -2, z: -2 },
          { id: 'b', x: 2, z: -2 },
          { id: 'c', x: 2, z: 2 },
          { id: 'd', x: -2, z: 2 }
        ]
      }]
    };

    const result = await bakeStructuralAuthoring(config, document, 10, {
      async readTile(key) {
        const tile = tiles.get(tileKeyToId(key));
        if (!tile) throw new Error(`missing ${tileKeyToId(key)}`);
        return tile;
      },
      async writeTile(key, samples) {
        writes.push(key);
        tiles.set(tileKeyToId(key), samples);
      }
    });

    expect(writes.slice(0, 4)).toEqual([
      { x: 0, y: 0, d: 0 },
      { x: 1, y: 0, d: 0 },
      { x: 0, y: 1, d: 0 },
      { x: 1, y: 1, d: 0 }
    ]);
    expect(writes).toContainEqual({ x: 0, y: 0, d: 1 });
    expect(result.metadata.status).toBe('clean');
    expect(result.metadata.tileCount).toBe(4);
    expect(result.metadata.primitiveCount).toBe(1);
    const centerSample = tiles.get('d0/y1/x1')?.[0] ?? 0;
    expect(r16ToElevation(centerSample, config.worldHeight)).toBeCloseTo(80, 0);
  });

  it('applies selected noise fields during depth-0 bake', async () => {
    const tiles = new Map<string, Uint16Array>();
    const document: AuthoringDocumentV1 = {
      ...createEmptyAuthoringDocument('world'),
      version: 1,
      worldId: 'world',
      fieldLibrary: [{
        version: 1,
        id: 'field-const',
        name: 'Constant Lift',
        nodes: [
          { id: 'const', type: 'constFloat', position: { x: 0, y: 0 }, params: { value: 1 } },
          { id: 'output', type: 'output', position: { x: 200, y: 0 }, params: {} }
        ],
        edges: [{
          id: 'const-output',
          from: { nodeId: 'const', portId: 'value' },
          to: { nodeId: 'output', portId: 'value' }
        }]
      }],
      primitives: [{
        id: 'plateau',
        type: 'landformArea',
        name: 'Plateau',
        enabled: true,
        createdAt: 'a',
        updatedAt: 'a',
        mode: 'plateau',
        elevation: 50,
        fieldId: 'field-const',
        noiseScale: 20,
        edgeSmoothness: 0,
        splineSmoothness: 0,
        priority: 0,
        anchors: [
          { id: 'a', x: -2, z: -2 },
          { id: 'b', x: 2, z: -2 },
          { id: 'c', x: 2, z: 2 },
          { id: 'd', x: -2, z: 2 }
        ]
      }]
    };

    await bakeStructuralAuthoring(config, document, 10, {
      async readTile(key) {
        const tile = tiles.get(tileKeyToId(key));
        if (!tile) throw new Error(`missing ${tileKeyToId(key)}`);
        return tile;
      },
      async writeTile(key, samples) {
        tiles.set(tileKeyToId(key), samples);
      }
    });

    const centerSample = tiles.get('d0/y1/x1')?.[0] ?? 0;
    expect(r16ToElevation(centerSample, config.worldHeight)).toBeCloseTo(70, 0);
  });
});
