# World Authoring Milestone Specs

This folder splits the semantic terrain editor spec into implementation-sized milestones.

The main feature spec describes the long-term design. These milestone specs define smaller deliverables that can be built and verified independently.

## Milestones

1. [Milestone 1 - Authoring Loop And Structural Bake](./01-authoring-loop-structural-bake.md)
2. [Milestone 2 - Editor Ergonomics And Field Pipeline](./02-editor-ergonomics-field-pipeline.md)
3. [Milestone 3 - Basins, Drainage, Lakes, And Rivers](./03-basins-drainage-lakes-rivers.md)
4. [Milestone 4 - Terrain Character And Noise System](./04-terrain-character-noise.md)
5. [Milestone 5 - Erosion, Masks, And Export Completeness](./05-erosion-masks-export.md)

## Sequencing Principle

Each milestone should leave the app usable. Avoid building invisible infrastructure without a thin visible workflow. The editor should progressively move from "I can draw intent and bake tiles" toward "I can author expressive terrain and export useful game-engine data."

## Shared Terms

* `authoring.json`: durable semantic input document saved with the world project.
* `bake`: explicit operation that converts authoring inputs into generated height tiles, LODs, and later derived outputs.
* `raster field`: generated bake artifact used internally by generation. Fields are rebuildable and are not the source of truth.
* `depth-0 tiles`: full-resolution R16 height tiles.
* `LOD tiles`: downsampled parent tiles rebuilt after depth-0 tiles are written.
