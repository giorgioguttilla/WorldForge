# WorldForge Heightmap Architecture

## World Lifecycle

WorldForge edits one active world at a time. The Svelte shell owns the current `TileManager`, and the manager owns the active `WorldConfig`, OPFS tile store, LOD rebuild flow, export flow, and metrics. Creating a world validates config, opens an OPFS project directory, writes `world.config.json`, generates full-resolution raw R16 tiles, and builds the LOD pyramid before the renderer starts requesting tiles.

## Storage Layout

Working projects live in OPFS under `worldforge-projects/<world-id>/`.

```text
world.config.json
tiles/
  d0/y0/x0.r16
  d0/y0/x1.r16
  d1/y0/x0.r16
```

Tile keys are `{ x, y, d }`. Depth `d = 0` is full resolution. Higher `d` values are lower-detail parent levels. A depth-1 tile represents a 2x2 neighborhood of depth-0 tiles, depth 2 represents 4x4 full-resolution tiles, and so on until the root tile.

## Formats

The editor working format is raw little-endian R16, one unsigned 16-bit channel per height sample. This keeps OPFS reads and writes cheap and predictable. Export converts those working tiles into 16-bit grayscale PNG files plus `world.config.json`, so game-engine terrain importers have a more common interchange format.

R16 values map to elevation as `value / 65535 * worldHeight`. `unitSize` and `unit` describe horizontal scale; elevation uses the same world unit family.

## LOD Rebuild Flow

Dirty full-resolution tiles are propagated upward with `ancestorsForDirtyTile`. `LodBuilder` rebuilds parent tiles depth by depth. For each parent tile, it reads the four child tiles, downsamples each child by 2x2 averaging into the correct parent quadrant, writes the parent, then releases temporary arrays by allowing them to fall out of scope. This keeps memory usage proportional to a small neighborhood instead of the full world.

## Rendering Responsibilities

`EditorViewport` owns Three setup, stats.js, camera controls, and the animation loop. `TerrainQuadtreeRenderer` selects visible tile keys from the active camera state, reuses pooled mesh nodes, requests tile samples from `TileManager`, and updates render metrics. The current implementation uses CPU-updated geometries for the v1 foundation while keeping tile IO and LOD operations isolated behind interfaces that can later be backed by WebGPU compute passes.

View modes are:

- Free camera: right-click drag adjusts heading/pitch, WASD moves relative to heading, Q/E moves vertically.
- Ortho top down: right-click drag and WASD pan, mouse wheel zooms.
- Character: selectable stub reserved for a future controller.

## Metrics And Cache Ownership

`HeightmapTileStore` owns the bounded tile cache and records average read/write timings. `TerrainQuadtreeRenderer` reports rendered tile count, vertex count, and triangle count. `TileManager.metrics` is the single UI-facing metrics snapshot.

## Future Edit Guide

- Add new map types beside `heightmap` modules with their own codecs and stores, then compose them through `TileManager`.
- Add brush editing by writing changed full-resolution R16 tiles, marking them dirty, and invoking `LodBuilder.rebuildFromDirty`.
- Add GPU compute by introducing compute implementations behind generation/downsample interfaces; keep OPFS and config contracts unchanged.
- Add smarter terrain streaming inside `TerrainQuadtreeRenderer` without changing tile key conventions.
- Add import/open flows by adding project discovery and config loading to `TileManager`; keep one active world in the app context.
