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
   - Seed every client document with presets: Rolling Hills, Mountains, Canyon.
   - Keep primitives valid if a referenced field is removed by treating the missing field as no field.

4. Bake integration
   - Prepare field evaluators once per bake document.
   - Pass cartesian position and spline-space position to every evaluation.
   - For landforms, apply field displacement after the structural elevation target is blended by landform falloff.
   - For mountains, add field displacement inside the mountain falloff. Empty field preserves the current structural contribution.
   - Compilation/caching can be added later, but the JSON evaluator is the source of truth.

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

- `output`: one `float` input named `value`; final result is the evaluated field value. Bake attenuates it by the shape falloff at the sample point.
- `constFloat`: one `float` output.
- `cartesianPosition`: `x`, `y`, and `xy` outputs from world-space coordinates.
- `splinePosition`: `x`, `y`, and `xy` outputs from contour-relative coordinates.
- `simplex2d`: float output from x/y inputs or a vec2 input, with frequency, amplitude, seed, skew, offset, and range min/max.
- `fbm2d`: layered simplex with octaves, lacunarity, gain, frequency, amplitude, seed, skew, offset, and range min/max.
- `ridged2d`: ridged multifractal derived from layered simplex, with the same common controls.
- `add`, `subtract`, `multiply`, `divide`: float math nodes.
- `clamp`, `power`, `smoothstep`: basic shaping nodes.

Voronoi and domain-warp nodes can be added later without changing graph structure.

## Coordinate Inputs

Cartesian position uses the tile sample's world x/z pair as x/y. Spline-space position is only meaningful for spline-backed primitives. It maps the nearest point on the primitive contour to an x coordinate measured along the contour, and maps signed lateral distance to y. For closed landforms or unavailable spline context, spline-space falls back to cartesian coordinates until a richer contour mapping is supplied.

## Presets

Every client document receives three editable presets:

- Rolling Hills: low-frequency fBM with softened contrast.
- Mountains: ridged multifractal multiplied by a broad fBM mask.
- Canyon: stretched ridged/simplex bands shaped through smoothstep.

These are ordinary field graphs, not hidden engine presets.
