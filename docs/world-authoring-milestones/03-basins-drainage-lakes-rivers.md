# Milestone 3 - Basins, Drainage, Lakes, And Rivers

## Goal

Add the first real terrain-analysis layer: basins, drainage, generated lakes, and generated rivers. Water features are still generated outputs, not manually authored objects.

## Scope

### Basin Area

Add Basin Area if not already present.

Shape:

* single closed polygon

Parameters:

* `depth`
* `floorFlatness`
* `rimSoftness`

Outputs:

* basin elevation delta
* flatness

Notes:

* Basin Area shapes terrain.
* It does not directly create a lake.
* Actual retained water comes from final/current terrain height and basin filling analysis.

### River Guide Spline

Upgrade River Guide from visual/simple data to actual drainage cost authoring.

Parameters:

* `influence`
* `width`
* `edgeSmoothness`

Output:

* drainage cost

Rules:

* Drainage cost is a soft routing preference.
* Gravity wins.
* Guides must not create long uphill rivers.

### Drainage Analysis

Implement deterministic analysis from final/current height:

* flow direction
* flow accumulation
* closed basins and local minima
* outlet/drainage state
* basin filling

The solver reads:

* final/current height
* world water level
* optional drainage cost

### Generated Rivers

Extract river centerlines from flow accumulation and channels.

Minimum output:

```ts
interface GeneratedRiver {
  id: string;
  points: { x: number; z: number }[];
  flow: number;
  width: number;
}
```

### Generated Lakes

Extract lake polygons from filled basins and world water level.

Minimum output:

```ts
interface GeneratedLake {
  id: string;
  surfaceElevation: number;
  boundary: { x: number; z: number }[];
  sourceBasinId?: string;
  inflowRiverIds?: string[];
  outflowRiverIds?: string[];
}
```

### Visualization

Add debug/preview overlays:

* flow accumulation
* generated river centerlines
* generated lake polygons
* drainage cost field preview

## Non-Goals

* Hydrology Areas.
* Wetlands/deltas/floodplains.
* Multiple local water levels.
* Hydraulic erosion.
* Sophisticated river width modeling.
* Manual editing of generated rivers/lakes.

## Acceptance Criteria

* Basin areas can create terrain that may retain water after bake.
* River guides influence drainage without overriding gravity.
* Bake generates deterministic river centerlines.
* Bake generates deterministic lake polygons where final terrain supports them.
* Generated water data is saved as derived bake output, not as authoring primitives.
* Rebuilding from the same authoring inputs and seed produces the same rivers/lakes.

## Suggested Implementation Chunks

1. Basin Area primitive and rasterizer.
2. Drainage cost rasterizer for River Guide.
3. Flow direction and accumulation prototype.
4. Closed basin/local minima detection.
5. Basin filling and outlet analysis.
6. River extraction.
7. Lake polygon extraction.
8. Generated water overlay rendering.
9. Save generated rivers/lakes as bake outputs.
