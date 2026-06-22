# Milestone 4 - Terrain Character And Noise System

## Goal

Add expressive terrain surface controls and deterministic noise infrastructure without changing the core authoring model.

## Scope

### Terrain Character Area

Add Terrain Character Area.

Shape:

* single closed polygon

Presets:

* hard rock
* soft sediment
* layered canyon rock
* volcanic rough
* loose sand
* fertile lowland

Parameters:

* `wearRate`
* `slopeHold`
* `layering`
* `surfaceRoughness`
* `edgeSmoothness`

Outputs:

* wear rate
* slope hold
* strata/layering
* surface roughness

### Noise System

Introduce a deterministic noise abstraction.

Requirements:

* seedable
* serializable settings
* stable world-space sampling
* per-generator named noise channels
* reroll per channel
* reroll all ambient detail
* inspector/editor for advanced settings

Candidate wrapper:

```ts
interface NoiseSource {
  id: string;
  seed: number;
  type: 'value' | 'simplex' | 'ridged' | 'fbm';
  scale: number;
  octaves: number;
  gain: number;
  lacunarity: number;
}
```

The wrapper can initially use local CPU noise. Third-party libraries should be hidden behind this interface.

### Structural Detail

Use noise and terrain character fields to add deterministic local detail:

* mountain ruggedness
* plateau/landform subtle variation
* terrain character roughness
* strata/layering hints

Noise must not move authored primitives or redirect major drainage.

## Non-Goals

* Full erosion simulation.
* Biome painting.
* Material rendering pipeline.
* Complex node graph.
* 3D noise unless needed by implementation.

## Acceptance Criteria

* Terrain Character Areas influence baked terrain detail.
* Re-running bake with same seeds gives identical output.
* Rerolling a noise channel changes ambient detail without changing authored structure.
* Noise settings persist in `authoring.json`.
* Advanced settings can be edited without exposing third-party library APIs directly.

## Suggested Implementation Chunks

1. Noise abstraction and deterministic sampler.
2. Noise settings persistence.
3. Reroll UI.
4. Terrain Character Area primitive.
5. Terrain character raster fields.
6. Structural bake integration.
7. Noise preview/debug UI.
