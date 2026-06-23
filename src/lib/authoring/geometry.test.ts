import { describe, expect, it } from 'vitest';
import type { AuthoringDocumentV1, LandformAreaV1, MountainSplineV1 } from './authoringDocument';
import { evaluateStructuralHeight, landformWeightAt, mountainWeightAt } from './geometry';
import type { WorldConfig } from '../heightmap/worldConfig';

const config: WorldConfig = {
  id: 'world',
  name: 'World',
  tileSize: 4,
  tilesPerSide: 1,
  unitSize: 1,
  unit: 'meter',
  worldHeight: 1000,
  water: { visible: false, level: 100 },
  createdAt: 'now',
  updatedAt: 'now',
  version: 1
};

function land(id: string, elevation: number, priority: number, createdAt: string): LandformAreaV1 {
  return {
    id,
    type: 'landformArea',
    name: id,
    enabled: true,
    createdAt,
    updatedAt: createdAt,
    mode: 'land',
    elevation,
    edgeSmoothness: 0,
    priority,
    anchors: [
      { id: `${id}-a`, x: -10, z: -10 },
      { id: `${id}-b`, x: 10, z: -10 },
      { id: `${id}-c`, x: 10, z: 10 },
      { id: `${id}-d`, x: -10, z: 10 }
    ]
  };
}

describe('authoring geometry', () => {
  it('uses zero elevation when no primitives influence a sample', () => {
    const document: AuthoringDocumentV1 = {
      version: 1,
      worldId: 'world',
      primitives: []
    };

    expect(evaluateStructuralHeight(config, document, 0, 0, 100).elevation).toBe(0);
  });

  it('resolves landform overlaps by priority and then later primitive order', () => {
    const document: AuthoringDocumentV1 = {
      version: 1,
      worldId: 'world',
      primitives: [
        land('low', 200, 1, 'a'),
        land('high', 600, 2, 'b'),
        land('later', 400, 2, 'c')
      ]
    };

    expect(evaluateStructuralHeight(config, document, 0, 0, 100).landform?.id).toBe('later');
    expect(evaluateStructuralHeight(config, document, 0, 0, 100).elevation).toBe(400);
  });

  it('fades landforms near polygon edges', () => {
    const primitive = land('soft', 500, 0, 'a');
    primitive.edgeSmoothness = 5;

    expect(landformWeightAt(primitive, 0, 0)).toBe(1);
    expect(landformWeightAt(primitive, 9.5, 0)).toBeLessThan(0.1);
    expect(landformWeightAt(primitive, 20, 0)).toBe(0);
  });

  it('computes mountain spline falloff', () => {
    const primitive: MountainSplineV1 = {
      id: 'range',
      type: 'mountainSpline',
      name: 'Range',
      enabled: true,
      createdAt: 'a',
      updatedAt: 'a',
      height: 300,
      width: 10,
      edgeSmoothness: 5,
      anchors: [{ id: 'a', x: -10, z: 0 }, { id: 'b', x: 10, z: 0 }]
    };

    expect(mountainWeightAt(primitive, 0, 0)).toBe(1);
    expect(mountainWeightAt(primitive, 0, 4)).toBeGreaterThan(0);
    expect(mountainWeightAt(primitive, 0, 5)).toBe(0);
    expect(mountainWeightAt(primitive, 0, 6)).toBe(0);
  });
});
