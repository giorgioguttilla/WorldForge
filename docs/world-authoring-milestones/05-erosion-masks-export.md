# Milestone 5 - Erosion, Masks, And Export Completeness

## Goal

Move from structural terrain generation to production-oriented terrain output: erosion, masks, complete export metadata, and game-engine-friendly artifacts.

## Scope

### Hydraulic Erosion

Add deterministic hydraulic erosion behind a stable interface.

Implementation approach:

* CPU prototype is acceptable while algorithms stabilize.
* GPU compute is the production target.
* Avoid making particle droplets the only erosion path in V1.
* Use explicit tile-neighborhood inputs for seam-aware computation.

Inputs:

* current terrain height
* flow/drainage analysis
* wear rate
* rainfall/source settings
* deterministic seeds

Outputs:

* eroded height
* sediment
* flow

### Thermal Erosion

Add slope relaxation influenced by `slopeHold`.

Purpose:

* talus slopes
* cliff breakdown
* mountain shoulders
* canyon wall stability

### Mask Generation

Generate masks from final terrain and analysis:

* slope
* flow
* moisture
* snow
* sediment
* rock exposure
* terrain character/material
* biome

Biome remains derived from fields and final terrain. It is not directly painted in this milestone.

### Export

Complete export package:

* R16 height tiles
* 16-bit PNG height tiles
* masks
* `rivers.json`
* `rivers.geojson`
* `lakes.json`
* `world.json`
* `tiles.json`
* `authoring.json`
* `bake.json`

### Tile Simulation

Use the 3x3 tile-neighborhood compute contract:

* read target tile plus 8 neighbors when needed
* write only target tile
* explicit world-edge policy
* internal halos allowed only as pass-specific implementation details

## Non-Goals

* Manual sculpting.
* Generated engine scenes.
* Local waterbody levels.
* Advanced hydrology areas unless a dedicated water design has already been written.

## Acceptance Criteria

* Erosion changes the terrain deterministically.
* Tile boundaries do not show obvious seams.
* Masks export with documented names, ranges, and formats.
* Exported package can be consumed by Unity/Unreal import workflows with minimal manual cleanup.
* `authoring.json` plus bake settings can reproduce the exported terrain.

## Suggested Implementation Chunks

1. Erosion interface and CPU prototype.
2. Tile-neighborhood read API.
3. Hydraulic erosion pass.
4. Thermal erosion pass.
5. Mask generation pipeline.
6. Export manifest updates.
7. PNG mask/height export.
8. Seam testing and deterministic bake tests.
