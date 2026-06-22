import { describe, expect, it } from 'vitest';
import { createEmptyAuthoringDocument, normalizeAuthoringDocument } from './authoringDocument';

describe('authoring document', () => {
  it('creates an empty v1 document for a world', () => {
    expect(createEmptyAuthoringDocument('world-a')).toEqual({
      version: 1,
      worldId: 'world-a',
      primitives: []
    });
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
      edgeSmoothness: 0,
      priority: 3,
      anchors: [{ id: 'a', x: 1, z: 2 }]
    });
  });
});
