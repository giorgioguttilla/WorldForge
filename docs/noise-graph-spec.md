# Noise Graph Spec

WorldForge noise fields are JSON-backed node graphs. A field belongs to the client authoring document, and authoring primitives reference fields by id. No graph state is allowed to live outside the serialized field JSON.

## Implementation Chunks

1. Core schema and validation
   - Define serializable graph, node, port, edge, and parameter records.
   - Require exactly one `output` node.
   - Validate that edges connect output ports to input ports, or input ports to output ports after normalization.
   - Validate that connected ports have matching data types.
   - Keep node editor UI state, such as node positions and selected preview metadata, inside node JSON.

2. Evaluator library
   - Evaluate graph nodes into typed values from an evaluation context.
   - Support `float` and `vec2` values initially.
   - Include deterministic seeded simplex noise wrappers.
   - Normalize all base noise to `0..1` before module-level remapping.
   - The graph evaluator returns the output node value directly. Bake applies shape falloff so fields still fade at authoring boundaries.

3. Authoring document integration
   - Add `fieldLibrary` to every authoring document.
   - Add `fieldId` to authoring primitives.
   - Add `noiseScale` to baseline landform primitives.
   - Seed every client document with presets: Rolling Hills, Mountains, Canyon.
   - Keep primitives valid if a referenced field is removed by treating the missing field as no field.

4. Bake integration
   - Prepare field evaluators once per bake document.
   - Pass cartesian world-space position to every evaluation.
   - Baseline landforms evaluate at most one field target per priority layer: `lerp(existingHeight, baseHeight + noiseValue * noiseScale, edgeRamp)`.
   - Additive mountains contribute on top of the baseline: `existingHeight + noiseValue * shapeHeight * edgeRamp`.
   - Empty landform fields preserve the existing base-height behavior.
   - Empty mountain fields preserve the existing additive ridge behavior with `noiseValue = 1`.
   - Field graphs are compiled to specialized JavaScript functions before bake sampling.

5. Node graph editor
   - Provide a large modal editor for creating and editing field graphs.
   - Include a searchable module palette.
   - Support add/delete nodes and edges, single selection, drag-to-connect with preview splines, and keyboard delete/backspace.
   - Show valid drop targets while dragging based on port direction and type.
   - Keep all saved changes in the field graph JSON.

## Schema

```ts
type GraphValueType = 'float' | 'vec2';
type PortDirection = 'input' | 'output';

interface NoiseFieldGraphV1 {
  version: 1;
  id: string;
  name: string;
  description?: string;
  nodes: NoiseGraphNodeV1[];
  edges: NoiseGraphEdgeV1[];
}

interface NoiseGraphNodeV1 {
  id: string;
  type: NoiseGraphNodeTypeV1;
  label?: string;
  position: { x: number; y: number };
  params: Record<string, number | string | boolean>;
}

interface NoiseGraphEdgeV1 {
  id: string;
  from: NoiseGraphPortRefV1;
  to: NoiseGraphPortRefV1;
}
```

## Initial Node Set

- `output`: one `float` input named `value`; final result is the evaluated field value. Baseline shapes scale it by `noiseScale`; additive mountain shapes scale it by `height`. Bake attenuates both by the shape falloff at the sample point.
- `constFloat`: one `float` output.
- `cartesianPosition`: `x`, `y`, and `xy` outputs from world-space coordinates.
- `simplex2d`: float output from x/y inputs or a vec2 input, with frequency, amplitude, seed, skew, offset, and range min/max.
- `fbm2d`: layered simplex with octaves, lacunarity, gain, frequency, amplitude, seed, skew, offset, and range min/max.
- `ridged2d`: ridged multifractal derived from layered simplex, with the same common controls.
- `add`, `subtract`, `multiply`, `divide`: float math nodes.
- `clamp`, `power`, `terrace`, `smoothstep`: basic shaping nodes.

Voronoi and domain-warp nodes can be added later without changing graph structure.

## Coordinate Inputs

Cartesian position uses the tile sample's world x/z pair as x/y. Noise fields intentionally do not expose shape-relative or spline-relative coordinates; shape falloff and baseline/additive semantics are applied by bake code outside the graph.

## Noise Units And Frequency Guidelines

Noise graph coordinates are in world units. If the active world unit is feet, `cartesianPosition.x = 1000` means 1000 feet from world origin. If the active world unit is meters, it means 1000 meters. Raw position nodes do not normalize by world size, tile size, or shape bounds.

Noise modules convert world units to noise-space with:

```ts
noiseX = (inputX + offsetX) * frequency / skewX
noiseY = (inputY + offsetY) * frequency / skewY
```

The practical authoring rule is:

```ts
featureWavelengthInWorldUnits = 1 / frequency
frequency = 1 / desiredFeatureWavelengthInWorldUnits
```

Examples:

- `frequency = 0.0005` gives broad features around `2000` world units wide.
- `frequency = 0.001` gives features around `1000` world units wide.
- `frequency = 0.005` gives features around `200` world units wide.
- `frequency = 0.02` gives small detail around `50` world units wide.

Recommended bands:

- Continental/base undulation: `0.0002..0.0008` (`5000..1250` world units).
- Rolling hills: `0.0008..0.003` (`1250..333` world units).
- Mountain ridges: `0.0015..0.006` (`667..167` world units).
- Canyon basin terraces and broad carving: `0.0005..0.0015` (`2000..667` world units).
- Canyon striation or cliff bands: `0.003..0.02` (`333..50` world units); use sparingly for detail layers, not the main canyon preset.
- Surface detail/noise roughness: `0.01..0.05` (`100..20` world units).

For fBM and ridged modules, `frequency` is the first octave wavelength. Each next octave multiplies frequency by `lacunarity`, so a node with `frequency = 0.001`, `lacunarity = 2`, and `octaves = 4` samples approximate wavelengths of `1000`, `500`, `250`, and `125` world units. `gain` controls how much each higher-frequency octave contributes.

Skew stretches the sampling domain, not the output. `skewX = 2` doubles the feature wavelength along x. `skewY = 0.5` halves the feature wavelength along y. Use skew for elongated ridges, canyon bands, and wind/slope-like anisotropy.

Offsets are also in world units before frequency is applied. Use offsets to shift the phase of a noise pattern without changing its scale.

Preset fields should output normalized values, not world-unit heights:

- Baseline landform presets normally output `[-1, 1]` and rely on landform `noiseScale` for height magnitude.
- Additive mountain presets normally output `[0, 1]` and rely on mountain `height` for magnitude.
- Carving/canyon presets normally output `[-1, 0]` and rely on landform `noiseScale` for cut depth.

## Presets

Every client document receives three editable presets:

- Rolling Hills: low-frequency fBM normalized to roughly `[-1, 1]`.
- Mountains: ridged multifractal multiplied by a broad fBM mask, normalized to `[0, 1]`.
- Canyon: incised plateau carving driven by low-frequency ridged main cuts, terraced incision depth, restrained tributaries, and light sediment roughness, normalized to `[-1, 0]`.

These are ordinary field graphs, not hidden engine presets.
