# Milestone 2 - Editor Ergonomics And Raster Field Pipeline

## Goal

Turn the Milestone 1 authoring proof into a dependable editor foundation, then introduce raster fields as explicit bake artifacts.

Milestone 1 already provides primitive persistence, overlays, a pass-based worker bake, basic selection, basic undo/redo, and structural R16 tile output. Milestone 2 should avoid rebuilding those pieces and instead make them reliable enough for repeated editing and future generators.

## Current Baseline

Already implemented or partially implemented:

* Landform Area and Mountain Spline primitives persist in `authoring.json`.
* Bake runs as explicit passes and uses ephemeral workers for structural depth-0 tiles and LOD downsampling.
* Empty worlds bake to uniform zero height.
* Landforms layer from low priority to high priority; mountains add on top.
* Basic selection, anchor dragging, deletion, Escape cancel/deselect, and overlapping primitive cycling exist.
* Mountain splines show a thick centerline plus a transparent width preview.
* The current inspector edits primitive-level parameters.

Milestone 2 should harden these workflows rather than duplicate them.

## Scope

### Editor Interaction Hardening

Make primitive editing feel predictable under repeated use:

* hover state for primitive, anchor, and segment targets
* anchor insertion on hovered segments
* anchor deletion rules that preserve valid shapes
* explicit invalid-shape visual state for drafts and edited primitives
* clear cursor/tool feedback for select, area creation, spline creation, dragging, and disabled states
* selected primitive translation control for moving the entire shape
* selected primitive rotation control around the Y axis only
* keyboard shortcuts for select, landform, spline, bake, delete, undo, redo, cancel/deselect
* keep single-selection as the editor model for this milestone

Do not add multi-selection, sculpting, or manual terrain painting.

Translation and rotation controls operate on the primitive's anchors as a group. Rotation is 2D XZ-plane rotation around a primitive pivot, such as the centroid or selected transform gizmo origin; it must not introduce pitch/roll or move anchors off the XZ plane.

### Inspector And State Architecture

Split the current all-in-one app state into maintainable editor surfaces:

* separate contextual inspector component
* separate authoring toolbar component
* separate bake/runtime panel component
* authoring state helpers or store for selection, draft creation, and dirty state

Inspector states:

* no selection: world metrics, water preview, bake state, primitive count
* primitive selected: primitive parameters
* anchor selected: anchor position and valid anchor-level controls for the current primitive
* draft active: draft anchors, validity, finish/cancel actions

### Command History

Replace snapshot-only undo/redo with a formal command history API.

Required commands:

* create/delete primitive
* create/delete anchor
* insert anchor on segment
* move anchor
* translate primitive
* rotate primitive around Y
* edit primitive parameter
* finish/cancel draft, where useful

Coalescing requirements:

* anchor drag becomes one undo step
* primitive translation/rotation drag becomes one undo step committed on mouse release
* slider/input drags become one undo step
* repeated text edits may coalesce until blur or Enter

Bake output replacement can remain outside undo/redo unless a clean design falls out naturally.

### Smoothness And Influence Previews

Make preview and bake falloff visually agree:

* Landform Area preview shows selected target area and edge blend band.
* Mountain Spline preview shows centerline, full-strength corridor, and edge falloff band.
* Region smoothness uses world-space distance from polygon edge.
* Spline smoothness uses world-space transition band near `width / 2`.
* Preview colors/opacity distinguish hard interior from soft transition.

The preview does not need to display exact per-sample values, but it must communicate the same distances the bake uses.

### Raster Field Pipeline

Introduce rebuildable raster fields as named bake artifacts and migrate the structural bake toward field sampling.

Milestone 2 field channels:

* `baseElevation`
* `landSeaIntent`
* `uplift`
* `ridge`

Minimum in-memory API:

```ts
interface RasterFieldSet {
  version: 1;
  worldId: string;
  bakeInputHash: string;
  width: number;
  height: number;
  worldBounds: { minX: number; minZ: number; maxX: number; maxZ: number };
  cellSize: number;
  fields: RasterFieldPlane[];
}

interface RasterFieldPlane {
  name: string;
  encoding: 'u8Norm' | 'u16Norm' | 'i16Norm' | 'f32';
  minValue: number;
  maxValue: number;
  channels: 1;
  data: Uint8Array | Uint16Array | Int16Array | Float32Array;
}
```

Storage:

* Fields may be in-memory only for Milestone 2.
* If persisted for debug/cache, use a field set manifest plus raw channel planes.
* Authoring primitives remain the durable source of truth.
* Field planes are generated bake artifacts, never durable authoring state.
* Store debug/cache planes as separate named files first; do not hard-code an early packed texture layout into the project format.
* GPU packing is allowed later, but any GPU texture layout must be derived from the manifest and treated as a cache.

Persistent manifest shape:

```ts
interface RasterFieldSetManifest {
  version: 1;
  worldId: string;
  bakeInputHash: string;
  width: number;
  height: number;
  worldBounds: { minX: number; minZ: number; maxX: number; maxZ: number };
  cellSize: number;
  fields: RasterFieldManifest[];
}

interface RasterFieldManifest {
  name: string;
  path: string;
  encoding: 'u8Norm' | 'u16Norm' | 'i16Norm' | 'f32';
  minValue: number;
  maxValue: number;
  channels: 1;
}
```

Storage buffer/datatype rules:

* `u8Norm`: store as `Uint8Array`; normalized unsigned values for influence/control fields where 256 steps are enough.
* `u16Norm`: store as `Uint16Array`; normalized unsigned values for absolute elevation-like fields where banding would be visible.
* `i16Norm`: store as `Int16Array`; normalized signed values for height deltas that can raise or lower terrain.
* `f32`: store as `Float32Array`; transient working/debug format when precision or range is unknown. Do not use as the default persistent format.

Recommended Milestone 2 encodings:

| Field | Encoding | Notes |
| --- | --- | --- |
| `baseElevation` | `u16Norm` | Absolute structural elevation in world units over `[0, worldHeight]`. |
| `landSeaIntent` | `u8Norm` | Use `0` for sea, `0.5` for neutral, and `1` for land. |
| `uplift` | `u16Norm` | Use unsigned for Milestone 2 because current mountain uplift only raises terrain. Switch to `i16Norm` if negative structural contribution is added. |
| `ridge` | `u8Norm` | Normalized ridge/profile emphasis, not an absolute height plane. |

Resolution:

* Field grid may be coarser than depth-0 height tiles.
* Sampling must be deterministic in world coordinates.
* Tile boundaries must not require special field padding for structural fields.

Execution:

* Field rasterization should be a bake pass before height tile generation.
* Worker execution should remain the default for CPU field passes.
* Keep the direct primitive evaluator as a correctness reference until field sampling has tests.
* Full-resolution height generation samples field planes in world coordinates with interpolation.
* If a field is absent, downstream generators use a documented default instead of requiring every bake to materialize every plane.

Generation details:

* Initialize field planes to documented defaults: `baseElevation = 0`, `landSeaIntent = 0.5`, `uplift = 0`, `ridge = 0`.
* Rasterize each enabled primitive into one or more planes using normalized influence in `[0, 1]`.
* Region influence is based on distance from polygon boundary toward the interior: `smoothstep(0, edgeSmoothness, insideDistance)`.
* Spline influence is based on distance to centerline: full strength inside `width / 2 - edgeSmoothness`, then fades to zero at `width / 2`.
* Landform Area rasterization writes or blends `baseElevation` and `landSeaIntent` according to priority/layering semantics.
* Mountain Spline rasterization writes `uplift` and `ridge`; uplift contributes height, ridge marks crest/profile emphasis for later terrain shaping.
* Compatible fields may use weighted blending; absolute/priority-like fields must preserve the same order/priority semantics as the direct evaluator.
* The structural height pass composes final sample height from the sampled fields, then writes R16 depth-0 tiles and rebuilds LODs.

### Debug Views

Add a minimal way to inspect generated fields:

* selectable field preview mode or temporary debug panel
* show min/max and resolution
* preview at least `baseElevation`, `uplift`, and `ridge`

This can be utilitarian. It does not need final art direction.

Also add to the runtime stats the total memory usage of any tiles and raster fields to 
help understand current memory impact

## Non-Goals

* Hydraulic erosion.
* Drainage/lake analysis.
* Terrain Character Area.
* Climate/biome generation.
* Advanced hydrology areas.
* Full export package beyond height tiles and `authoring.json`.
* Multi-selection.
* Manual sculpting.
* GPU compute backend.

## Acceptance Criteria

* Repeated primitive editing feels stable: hover, selection, insertion, deletion, drag, undo, redo, and cancel/deselect behave predictably.
* Inspector clearly reflects no selection, primitive selection, anchor selection, and active draft states.
* Command history handles common edits without snapshot-only behavior.
* Previewed smoothness/influence regions match bake semantics.
* Bake can produce named raster fields and then generate height tiles from field sampling, or a field-backed adapter exists alongside the direct evaluator.
* Field previews/debug views can be added without changing the authoring document model.
* Existing Milestone 1 workflows continue to work: reload persistence, bake to R16, rebuild LODs, and terrain refresh.

## Suggested Implementation Chunks

1. Split authoring UI into toolbar, inspector, and bake/runtime panels.
2. Add formal selection/hover model and cursor feedback.
3. Implement anchor insertion and stricter anchor deletion validity.
4. Replace snapshot undo/redo with command history and coalescing.
5. Add landform and spline smoothness/influence preview bands.
6. Add raster field data structures and deterministic sampling API.
7. Add Landform Area and Mountain Spline field rasterizers.
8. Add field-backed structural height bake path behind the existing bake pass interface.
9. Add field debug preview mode or panel.
10. Keep direct evaluator tests as reference tests for field-backed bake output.
