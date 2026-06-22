# Milestone 2 - Editor Ergonomics And Field Pipeline

## Goal

Turn the Milestone 1 proof of workflow into a reliable editing foundation and introduce the raster field pipeline needed by later generators.

## Scope

### Editor Interactions

Improve the primitive editor:

* robust selection hit testing
* anchor insertion on segments
* anchor deletion rules that preserve valid shapes
* keyboard shortcuts for select, bake, delete, undo, redo, cancel
* better visual states: hover, selected primitive, selected anchor, in-progress primitive, invalid shape
* single-selection only

### Region And Spline Smoothness

Make smoothness behavior consistent:

* region smoothness uses world-space blend distance
* spline smoothness uses transition band near corridor edge
* overlay preview shows hard interior and soft transition band
* rasterization and preview use the same falloff model

### Context Inspector

Replace the runtime-only panel with contextual behavior:

* no selection: runtime/world metrics, water preview, bake state
* primitive selected: primitive parameters
* anchor selected: anchor position and local overrides that exist for the current milestone

### Undo/Redo

Make command history dependable:

* create/delete primitive
* create/delete anchor
* move anchor
* edit primitive parameter
* bake result replacement if practical

Coalesce:

* anchor drags into one command
* slider drags into one command

### Raster Field Pipeline

Introduce rebuildable raster fields as bake artifacts.

Milestone 2 fields:

* base elevation
* land/sea intent
* uplift
* ridge

Storage:

* Fields may be in-memory only at first.
* If persisted for debug/cache, use the manifest-plus-raw-planes format from the main spec.
* Authoring primitives remain the source of truth.

Resolution:

* Field grid can be coarser than depth-0 height tiles.
* Sampling must be deterministic in world coordinates.
* Tile boundaries must not require special field padding.

## Non-Goals

* Hydraulic erosion.
* Drainage/lake analysis.
* Terrain character.
* Climate/biome generation.
* Advanced hydrology areas.
* Full export package beyond height tiles and `authoring.json`.

## Acceptance Criteria

* Editor interactions feel stable enough for repeated authoring.
* Undo/redo handles common primitive edits.
* Inspector reliably reflects no selection, primitive selection, and anchor selection.
* Bake can use raster fields instead of directly querying every primitive for every height sample, or the implementation has a clear adapter boundary for doing so.
* Field previews/debug views can be added without changing the authoring model.

## Suggested Implementation Chunks

1. Formal command history API.
2. Hit testing and selection cleanup.
3. Inspector component split.
4. Smoothness preview rendering.
5. Raster field data structures and sampling API.
6. Field rasterizers for Landform Area and Mountain Spline.
7. Bake service migration to field sampling.
8. Debug view or logging for field outputs.
