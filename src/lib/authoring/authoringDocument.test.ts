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
});
