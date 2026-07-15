import { describe, expect, it } from 'vitest';
import { createEmptyAuthoringDocument, normalizeAuthoringDocument } from './authoringDocument';

describe('authoring document', () => {
  it('creates an empty v1 document for a world', () => {
    const document = createEmptyAuthoringDocument('world-a');
    expect(document).toMatchObject({
      version: 1,
      worldId: 'world-a',
      primitives: []
    });
    expect(document.fieldLibrary.map((field) => field.id)).toEqual([
      'preset-plains',
      'preset-rolling-hills',
      'preset-dunes',
      'preset-mountains',
      'preset-himalayas',
      'preset-canyon'
    ]);
  });

  it('normalizes missing or corrupt documents to an empty document', () => {
    expect(normalizeAuthoringDocument(null, 'world-a')).toEqual(createEmptyAuthoringDocument('world-a'));
    expect(normalizeAuthoringDocument({ primitives: [{ type: 'unknown' }] }, 'world-a')).toEqual(createEmptyAuthoringDocument('world-a'));
  });

  it('normalizes erosion settings with medium defaults', () => {
    const document = normalizeAuthoringDocument({
      erosion: {
        enabled: true,
        preset: 'heavy',
        hydraulicIterations: '12',
        hardness: 4,
        overlap: 1
      }
    }, 'world-a');

    expect(document.erosion).toMatchObject({
      enabled: true,
      preset: 'heavy',
      hydraulicIterations: 12,
      hardness: 1,
      overlap: 2,
      outputWaterMask: true
    });
  });

  it('normalizes saved primitive fields conservatively', () => {
    const document = normalizeAuthoringDocument({
      worldId: 'old',
      primitives: [{
        id: 'land-1',
        type: 'landformArea',
        name: 'Land',
        enabled: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        mode: 'plateau',
        elevation: '120',
        edgeSmoothness: -4,
        splineSmoothness: '2',
        priority: '3',
        anchors: [{ id: 'a', x: 1, z: 2 }, { id: 'bad', x: 'nope', z: 3 }]
      }]
    }, 'world-a');

    expect(document.worldId).toBe('world-a');
    expect(document.primitives).toHaveLength(1);
    expect(document.primitives[0]).toMatchObject({
      id: 'land-1',
      type: 'landformArea',
      mode: 'plateau',
      elevation: 120,
      noiseScale: 80,
      edgeSmoothness: 0,
      splineSmoothness: 1,
      priority: 3,
      anchors: [{ id: 'a', x: 1, z: 2 }]
    });
  });

  it('adds default spline smoothness to older primitives', () => {
    const document = normalizeAuthoringDocument({
      primitives: [{
        id: 'mountain-1',
        type: 'mountainSpline',
        name: 'Range',
        enabled: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        height: 100,
        width: 400,
        edgeSmoothness: 80,
        anchors: [{ id: 'a', x: 0, z: 0 }, { id: 'b', x: 100, z: 100 }]
      }]
    }, 'world-a');

    expect(document.primitives[0]).toMatchObject({
      type: 'mountainSpline',
      splineSmoothness: 0.65
    });
  });

  it('normalizes authored hydrology objects conservatively', () => {
    const document = normalizeAuthoringDocument({
      hydrology: {
        version: 1,
        waterBodies: [{
          id: 'waterBody-1',
          name: 'Lake One',
          sourceCellX: 4,
          sourceCellY: 5,
          waterLevelR16: 10,
          areaCells: 4,
          maxDepthR16: 8,
          rings: [[
            { x: 0, z: 0 },
            { x: 1, z: 0 },
            { x: 1, z: 1 },
            { x: 0, z: 0 }
          ]]
        }, {
          id: 'bad',
          rings: []
        }],
        rivers: [{
          id: 'river-1',
          points: [{ x: 0, z: 0, heightR16: 9 }, { x: 1, z: 1, heightR16: 8 }],
          mouth: 'edge',
          waterBodyIds: ['waterBody-1'],
          maxFlowStrengthR16: 40000,
          widthHint: 2
        }, {
          id: 'bad-river',
          points: [{ x: 0, z: 0 }]
        }]
      }
    }, 'world-a');

    expect(document.hydrology.waterBodies).toHaveLength(1);
    expect(document.hydrology.waterBodies[0]).toMatchObject({ name: 'Lake One', sourceCellX: 4, sourceCellY: 5 });
    expect(document.hydrology.rivers).toHaveLength(1);
    expect(document.hydrology.rivers[0]).toMatchObject({ mouth: 'edge', waterBodyIds: ['waterBody-1'] });
    expect(document.hydrology.rivers[0].segments).toEqual([expect.objectContaining({
      id: 'river-1-segment-1',
      termination: 'edge',
      initialMomentum: { x: 0, z: 0 },
      finalMomentum: { x: 0, z: 0 }
    })]);
    expect(document.hydrology.riverTrace).toEqual({ maxMomentum: 64 });
  });

  it('migrates only the legacy default river momentum', () => {
    const legacy = normalizeAuthoringDocument({ hydrology: { version: 1, riverTrace: { maxMomentum: 6 } } }, 'world-a');
    const customized = normalizeAuthoringDocument({ hydrology: { version: 1, riverTrace: { maxMomentum: 24 } } }, 'world-a');

    expect(legacy.hydrology.riverTrace.maxMomentum).toBe(64);
    expect(customized.hydrology.riverTrace.maxMomentum).toBe(24);
  });
});
