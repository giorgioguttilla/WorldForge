# Milestone 1 - Authoring Loop And Structural Bake

## Goal

Prove the full semantic authoring loop with the smallest useful toolset:

1. Create or open a world.
2. Draw simple land/water/plateau intent.
3. Draw barebones mountain ranges.
4. Persist authoring primitives with the world.
5. Run an explicit bake.
6. Write real depth-0 R16 height tiles.
7. Rebuild LOD tiles.
8. See the baked terrain in the existing viewport.

This milestone is about the workflow working end to end. It is not about realism yet.

## Scope

### Primitive Types

Implement only two primitive families.

#### Landform Area

This is the Milestone 1 subset of the future Landmass/Basin tools. It exists to establish broad terrain height and the land/water distinction.

Shape:

* single closed polygon on the XZ plane
* no holes
* no multipolygons

Parameters:

* `mode`: `land`, `water`, `plateau`
* `elevation`: target elevation in world units
* `edgeSmoothness`: blend distance in world units
* `priority`: overlap resolution

Behavior:

* `land` and `plateau` areas raise/hold terrain above the world water level.
* `water` areas lower/hold terrain below the world water level.
* `plateau` is not a separate geological concept yet; it is a practical authoring mode that writes a broad target elevation with soft edges.
* Overlaps resolve by higher `priority`, then later-created primitive.

Outputs:

* structural elevation contribution
* optional land/sea preview classification

#### Mountain Spline

Barebones mountain range authoring.

Shape:

* open polyline or simple spline on the XZ plane
* editable anchors
* no per-anchor tangent editing required in this milestone

Parameters:

* `height`: peak height contribution in world units
* `width`: total influence width in world units
* `edgeSmoothness`: blend distance near the range boundary

Behavior:

* Each sample computes distance to the spline centerline.
* Height contribution is strongest near the centerline and fades to zero at the range edge.
* A simple smoothstep/falloff profile is enough.
* No erosion, drainage, ridge networks, or realistic mountain shoulders are required.

Outputs:

* structural height contribution

### Authoring Document

Create and persist `authoring.json` inside the active OPFS world project.

Minimum shape:

```ts
interface AuthoringDocumentV1 {
  version: 1;
  worldId: string;
  primitives: PrimitiveV1[];
  lastBake?: BakeMetadataV1;
}

type PrimitiveV1 = LandformAreaV1 | MountainSplineV1;

interface PrimitiveBaseV1 {
  id: string;
  type: 'landformArea' | 'mountainSpline';
  name: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface AnchorV1 {
  id: string;
  x: number;
  z: number;
}
```

Persistence requirements:

* Save authoring primitives with the world.
* Restore primitives on page reload and "open latest world."
* Generated tiles may become stale, but primitives must survive.
* Autosave after primitive creation, deletion, anchor move, and parameter edit.

### Tools

Milestone 1 tool stack:

* Select
* Landform Area
* Mountain Spline
* Bake
* Show/hide authoring primitives

Required interactions:

* Click to add anchors.
* Close a Landform Area by clicking near the starting anchor after at least three anchors.
* Escape cancels in-progress primitive creation.
* Select a primitive.
* Select and drag an anchor.
* Delete or Backspace removes selected anchor or primitive.
* Inspector edits selected primitive parameters.

Undo/redo can be basic in this milestone:

* Must support create/delete primitive.
* Must support parameter edits.
* Anchor drag coalescing can be refined later.

### Authoring Overlay Rendering

* Authoring primitives live on the XZ plane.
* Render overlays at current world water level in Y.
* Overlay meshes, handles, and outlines render through terrain and water.
* Show/hide toggle affects only editor overlays, not bake participation.

### Bake Skeleton

The bake must actually write terrain tiles.

Inputs:

* active `WorldConfig`
* `authoring.json`
* current water level
* deterministic bake seed, even if only stored for future use

Algorithm:

1. Mark bake state `baking`.
2. For each depth-0 tile, evaluate structural height per sample in world coordinates.
3. Start from a deterministic default base elevation: `clamp(waterLevel + worldHeight * 0.05, 0, worldHeight)`.
4. Apply Landform Area target elevations with smooth blending and priority conflict resolution.
5. Add Mountain Spline height contributions.
6. Clamp to `[0, worldHeight]`.
7. Convert elevation to R16.
8. Write depth-0 tile through the existing tile store.
9. Rebuild LODs using the existing LOD builder.
10. Refresh the renderer.
11. Save bake metadata in `authoring.json`.
12. Mark bake state `clean` or `failed`.

Important constraints:

* No erosion.
* No hydraulic simulation.
* No drainage analysis.
* No generated rivers.
* No generated lakes.
* No masks.
* No field cache required.
* No GPU implementation required.

### Bake Metadata

Minimum metadata:

```ts
interface BakeMetadataV1 {
  id: string;
  startedAt: string;
  completedAt?: string;
  status: 'clean' | 'failed';
  inputHash: string;
  primitiveCount: number;
  tileCount: number;
  error?: string;
}
```

### Staleness

* Editing any primitive marks generated outputs `stale`.
* Running bake marks outputs `clean` if successful.
* Failed bake keeps outputs `stale` and records an error.

## Non-Goals

* Basin Area.
* River Guide drainage solving.
* Lake extraction.
* Erosion.
* Terrain Character Area.
* Climate Area.
* Noise graph.
* Advanced tangent editing.
* Per-anchor width/height overrides.
* Multi-selection.
* Exporting rivers, lakes, or masks.

## Acceptance Criteria

* User can draw a closed landform area and see its overlay.
* User can draw a mountain spline and see its overlay.
* User can edit primitive parameters in the inspector.
* User can reload the page and see primitives restored.
* User can click Bake and generate real R16 depth-0 tiles.
* LOD tiles rebuild after bake.
* Baked terrain changes are visible in the viewport.
* Deleting a primitive and rebaking changes the terrain.
* No erosion, drainage, generated lake, or generated river UI appears in this milestone.

## Suggested Implementation Chunks

1. Authoring document storage in OPFS.
2. Primitive data model and Svelte state store.
3. Overlay rendering for polygons, splines, anchors, and selection.
4. Landform Area creation/editing.
5. Mountain Spline creation/editing.
6. Inspector panel replacement for selected primitives.
7. Basic undo/redo.
8. Structural bake service that writes depth-0 R16 tiles.
9. LOD rebuild and renderer refresh.
10. Stale/clean/failed bake state UI.
