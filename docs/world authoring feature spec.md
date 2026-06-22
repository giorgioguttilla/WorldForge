# Semantic Terrain Editor - Feature Spec

## Vision

Build a web-based semantic terrain editor for generating large game worlds.

The editor should let users author terrain through high-level landscape intent rather than manual sculpting. Users should describe the causes and constraints of a world, then run a deterministic bake that produces heightmaps, water networks, masks, and export metadata.

Primary targets:

* Unity
* Unreal Engine

Primary export formats:

* tiled R16 heightmaps
* river splines
* lake polygons
* terrain masks
* [future] generated scene data for target game engines

The long-term goal is to become an open-source alternative to World Machine, Gaea, and Houdini terrain workflows while remaining approachable enough that authors can reason about the world without thinking like geologists.

---

## Existing Systems

Already implemented:

* tile storage system
* heightmap tile layer
* editor scaffold
* LOD terrain visualization
* tiled world architecture
* world-level water display config with `visible` and `level`

V1 should build on these systems. Authoring data should live beside the existing world config and tile stores without breaking the current OPFS project layout.

Implementation is split into milestone sub-specs under [world-authoring-milestones](./world-authoring-milestones/README.md). The milestone specs are the execution plan; this document remains the broader product and architecture target.

---

## Core Design Principles

### Author Causes, Not Results

The editor should prefer semantic inputs:

* mountain ranges
* landmasses and sea basins
* basins and plains
* river guides
* climate regions
* terrain character regions

The editor should avoid making users paint final pixels unless a later detail-editing mode explicitly supports that workflow.

### Intuitive First, Expressive Underneath

Every primary control should answer a worldbuilding question:

* How high is this range?
* How wide is this feature?
* How rough or smooth should it feel?
* How strongly should this guide influence the bake?
* How softly should it blend into surrounding terrain?

Internal simulation concepts can exist, but they should not leak into the main authoring UI as vague geological terms.

### Deterministic, Rerollable Generation

Every bake must be deterministic from:

* world config
* authoring primitives
* generator settings
* seed values

Users should be able to reroll ambient detail without changing authored structure. Advanced users should be able to inspect and tune the noise objects used by each generator.

---

## V1 Authoring Model

The user edits a document of semantic primitives. The primitives are inputs. A bake produces generated outputs.

The authoring document should be stored as structured JSON, separate from generated tiles:

```ts
interface AuthoringDocument {
  version: 1;
  worldId: string;
  primitives: TerrainPrimitive[];
  generatorSettings: GeneratorSettings;
  noise: NoiseSettings;
  lastBake?: BakeMetadata;
}

interface TerrainPrimitiveBase {
  id: string;
  type: string;
  name: string;
  enabled: boolean;
  locked: boolean;
  priority: number;
}

interface AnchorPoint {
  id: string;
  x: number;
  z: number;
  tangentMode: 'auto' | 'linear' | 'manual';
  inTangent?: { x: number; z: number };
  outTangent?: { x: number; z: number };
  width?: number;
  strength?: number;
  height?: number;
}
```

Generated outputs should be treated as derived data:

* height tiles
* LOD tiles
* river networks
* lake polygons
* masks
* bake diagnostics

The editor should track whether outputs are stale when authoring inputs change. The user should make an explicit bake request to regenerate outputs.

The authored document must remain lightweight enough to save frequently. Generated outputs can be large and should be replaced only by bake operations.

### Persistence

Authoring primitives are core world generation inputs and must persist with the world project.

Persistence requirements:

* Save the authoring document in OPFS as project state, for example `authoring.json`, alongside `world.config.json`.
* Opening or restoring a world must restore all authoring primitives, generator settings, noise settings, selection-safe ids, and last bake metadata.
* Reloading the page or revisiting the app later must preserve the semantic inputs exactly, even if generated tiles are stale.
* Authoring edits should autosave or be saved frequently enough that primitives are not treated as transient editor overlays.
* Generated outputs may be deleted and recreated, but authoring primitives should be the durable source of truth for rebaking the world.
* Export should include `authoring.json` so a project can be reopened or audited from its semantic inputs.

---

## Authoring Primitives

### Landmass Area

Defines broad land and ocean/sea intent relative to the world-level water height.

This solves the question: "Where is land, where is water, and how should shorelines transition?"

Shape:

* polygon region
* single closed outer boundary
* holes are not supported in V1

Parameters:

* `mode`: `land`, `sea`, `lowland`, `highland`
* `elevationBias`: signed vertical offset applied before terrain structure
* `shorelineSoftness`: horizontal blend distance around the region edge
* `priority`: conflict resolution order when landmass areas overlap

Outputs:

* base elevation field
* land/sea intent field

Notes:

* The existing world water `level` remains the global water plane used for preview and export.
* Landmasses describe terrain relative to that plane. They do not create a separate water level.
* Lakes are not authored through landmass areas in V1 except indirectly through basin inputs and optional river guide outlets.

### Mountain Range Spline

Represents a mountain chain.

Shape:

* editable spline with anchor points
* per-anchor optional width and height overrides

Parameters:

* `height`: target uplift contribution at the ridge core
* `width`: total influence width
* `ridgeSharpness`: how quickly the ridge falls from peak to shoulder
* `ruggedness`: amount of deterministic secondary detail
* `asymmetry`: optional cross-slope bias for one steep side and one gentler side
* `edgeSmoothness`: blend distance from zero influence to full influence around the spline corridor

Outputs:

* uplift field
* ridge field
* surface roughness field

### Basin Area

Represents broad ground shape: depressions, valleys, plains, bowls, and potential lake catchments.

Use a Basin Area when the user wants to shape the terrain that could hold or route water. A basin is a landform tool first. It can make a lake possible by lowering and smoothing terrain, but it is not itself a lake authoring tool.

Shape:

* polygon region

Parameters:

* `depth`: signed lowering amount
* `floorFlatness`: how strongly the basin floor should settle toward a smooth grade
* `rimSoftness`: blend distance around the basin border

Outputs:

* basin elevation delta field
* flatness field

The basin elevation delta is a structural height contribution, not an independent hydrology fact. After structural height is composed, the solver should detect actual closed basins and local minima from the resulting height field. A basin can exist at high absolute elevation, such as an alpine lake bowl or volcanic caldera, because "basin" means locally lower than surrounding terrain, not globally low.

### River Guide Spline

Provides a soft routing preference for drainage. It should guide the solver without forcing impossible uphill flow.

Shape:

* editable spline with anchor points
* per-anchor optional width override

Parameters:

* `influence`: how strongly drainage is biased toward this corridor
* `width`: corridor width
* `edgeSmoothness`: blend distance from zero influence to full influence around the corridor

Outputs:

* drainage cost field

### Authoring Lakes

Lakes are generated outputs, not a separate V1 primitive.

Recommended workflow:

1. Use a Basin Area to create the bowl, valley widening, crater, or low plain that can physically hold water.
2. Use a River Guide Spline when the basin should have a preferred outlet or downstream connection.
3. The bake decides whether the result becomes a lake from final terrain height, world water level, basin filling, rainfall/flow, and outlet state.

V1 distinction:

* Basin Area answers: "What is the shape of the ground?"
* River Guide Spline answers: "Where should drainage prefer to flow?"
* Lake extraction answers: "Given the ground and water behavior, what water bodies exist?"

If the product needs a one-click lake UX, it should be a preset or macro that creates a Basin Area and optional River Guide outlet together. It should still compile down to those primitives rather than introduce a separate lake system.

### Climate Area

Defines broad environmental conditions.

Shape:

* polygon region

Parameters:

* `temperature`
* `moisture`
* `edgeSmoothness`

Outputs:

* temperature field
* moisture field

Biome remains derived data. Users should not author biome pixels directly in V1.

### Terrain Character Area

Replaces "material area" as the primary user-facing concept.

The goal is to let authors shape how terrain erodes and reads visually without requiring geological expertise. The UI can expose friendly presets and a small set of plain-language controls. Internally, these controls feed material and erosion fields.

Shape:

* polygon region

Presets:

* hard rock
* soft sediment
* layered canyon rock
* volcanic rough
* loose sand
* fertile lowland

Parameters:

* `wearRate`: how easily water carves channels
* `slopeHold`: ability to keep steep cliffs before thermal relaxation
* `layering`: strength and spacing of horizontal banding or stepped strata
* `surfaceRoughness`: amount of deterministic small and medium detail
* `edgeSmoothness`

Outputs:

* wear rate field
* slope hold field
* strata/layering field
* surface roughness field

Canyon terrain fits here plus river and terrain character authoring:

* Use a `layered canyon rock` terrain character area for steep walls, strata, and high slope hold.
* Use a river guide to prefer the canyon drainage path.
* Use basin or landmass shaping for mesas, plateaus, and broad elevation context.

### Point Of Interest

Reserved for a future version.

Landmarks such as guaranteed peaks, craters, passes, settlements, and hand-authored lakes are useful, but they are a different interaction model from V1 region/spline authoring. They should not be part of the V1 success criteria unless the rest of the semantic editing loop is already solid.

---

## Spline And Region Editing

### Coordinate Plane

Authoring primitives are 2D world-space shapes.

Coordinate rules:

* Primitive control geometry lives on the world's XZ plane.
* Anchor positions store `x` and `z` world coordinates. They do not store terrain height.
* The editor may project mouse picks from terrain hits into XZ coordinates, but the primitive itself remains independent of the sampled terrain elevation.
* Generation samples these 2D primitives into fields; fields then affect the final height output.

Preview/rendering rules:

* Authoring primitive meshes, fills, outlines, handles, labels, and other editor collateral should render at the current world water level in Y.
* These editor overlays should render regardless of occlusion by terrain chunks or water.
* Use overlay/depth behavior equivalent to disabled depth testing or an always-visible editor pass.
* Selection handles should remain clickable even when terrain rises above the water-level overlay plane.
* This rendering behavior is editor-only and should not affect exported terrain, water, or masks.

The editor should include a view-mode toggle to show or hide all authoring primitives. Hiding authoring primitives should hide their meshes and editor collateral without disabling the primitives or excluding them from the next bake.

### Anchor Points

Splines and closed regions are edited through anchor points.

Common anchor operations:

* click empty terrain with an active draw tool to create an anchor
* drag an anchor to move it
* click a segment to insert an anchor
* select an anchor to edit per-anchor overrides
* delete the selected anchor
* split or continue an open spline

Region closing rules:

* Region tools create an open boundary until the user closes it.
* A region is closed by clicking near its starting anchor after at least three anchors exist.
* The starting anchor should display a clear close affordance when the pointer is within the close threshold.
* Clicking near the starting anchor commits the final edge from the last anchor to the first anchor.
* Pressing Enter can commit an already valid closed region, but it should not invent a closing edge for an open region unless the pointer/selection is explicitly on the starting anchor affordance.
* Escape cancels the in-progress region.
* V1 supports only one closed outer boundary per region. Holes, islands, and multi-polygons are deferred.

Spline anchors should support:

* `x`/`z` position
* tangent mode: `auto`, `linear`, `manual`
* optional local width override
* optional local strength/height override

### Influence Smoothness

Every region and spline that rasterizes into a field needs a smoothness control. The UI label can be primitive-specific, such as `shorelineSoftness`, `rimSoftness`, or `edgeSmoothness`, but the rasterization behavior should be consistent.

For regions:

* The smoothness value controls the world-space distance over which the region blends from outside value 0 to inside value 1.
* A value near 0 creates a crisp boundary.
* Larger values create broad transitions.

For spline corridors:

* `width` controls the full corridor width.
* `edgeSmoothness` controls the transition band near the corridor edge.
* The centerline influence should remain 1 unless per-anchor strength lowers it.

The rasterized influence should use a continuous falloff, such as smoothstep, to avoid visible cliffs in generated fields. Primitive previews should visualize the full influence width and smooth transition band before baking.

---

## Tool Selection And Interaction

### Tool Modes

V1 should have an explicit tool stack:

* Select
* Landmass Area
* Mountain Range
* Basin Area
* River Guide
* Climate Area
* Terrain Character Area
* Pan/Orbit remains a viewport interaction mode, not an authoring primitive

Tool behavior:

* Selecting a creation tool arms that primitive type.
* Clicking terrain starts a new primitive or appends to the active primitive.
* Region tools close only when the user clicks near the starting anchor after the minimum anchor count.
* Escape cancels the in-progress primitive.
* Enter commits an in-progress open spline or an already closed region.
* Select mode allows picking, moving, and editing existing primitives.
* Delete or Backspace removes the selected primitive.
* If an anchor is selected, Delete or Backspace removes that anchor instead of the entire primitive.

### Selection Model

The editor should support:

* no selection
* one primitive selected
* one anchor selected

Selection should drive the inspector panel.

V1 does not support multiple primitive selection or multiple anchor selection.

### Inspector Panel

The current runtime metrics panel should become contextual screen real estate.

Behavior:

* When nothing is selected, show runtime/world information: backend, compute mode, tile metrics, cache metrics, water preview controls, bake status.
* When a primitive is selected, show that primitive's editable parameters.
* When an anchor is selected, show anchor-local parameters and inherited primitive parameters.

The panel should feel similar to a Unity inspector: direct fields, sliders, toggles, segmented controls, and clear grouping. It should not explain the entire feature in prose inside the app.

### Undo And Redo

Undo/redo must be first-class in V1.

Undoable commands:

* create primitive
* delete primitive
* move primitive
* edit primitive parameter
* create anchor
* delete anchor
* move anchor
* edit anchor parameter
* change generator setting
* bake output replacement

Implementation expectations:

* Use a command history over semantic document mutations.
* Coalesce drag updates into a single undo command when the drag ends.
* Coalesce slider edits into a single undo command when the control is released or blurred.
* Keep generated bake outputs separate from authoring edits, but allow undoing a bake result replacement if practical.
* Mark the authoring document dirty independently from generated outputs being stale.

---

## Bake Model

The editor should separate authoring from generation.

Inputs:

* world config
* water config
* authoring primitives
* generator settings
* noise settings
* seed values

Outputs:

* full-resolution R16 height tiles
* rebuilt LOD tiles
* generated rivers
* generated lakes
* generated masks
* bake metadata and diagnostics

Bake states:

* `clean`: outputs match inputs
* `stale`: inputs changed since last bake
* `baking`: generation is running
* `failed`: last bake failed with diagnostics

The bake step should be explicit. Editing a primitive should not continuously rewrite height tiles. Lightweight preview overlays are allowed, but final generated outputs should be replaced by a deliberate bake action.

---

## Field Rasterization

Pass 1 rasterizes authoring primitives into continuous fields consumed by generation.

Fields:

* base elevation
* land/sea intent
* uplift
* ridge
* basin elevation delta
* flatness
* drainage cost
* moisture
* temperature
* wear rate
* slope hold
* strata/layering
* surface roughness

### Field Definitions

`base elevation`

Broad starting elevation before local features are applied. Landmass areas primarily write this field. It answers whether an area is generally ocean, lowland, highland, plateau, etc. It is part of structural height composition.

`land/sea intent`

A semantic hint for whether terrain should resolve above or below the world water level. This helps shorelines and broad landmass generation, but it is not a separate water simulation. The existing world water level remains the global water plane.

`uplift`

Large-scale positive terrain-building force, usually from mountain range splines. It raises terrain before erosion and should be interpreted as structural mountain mass, not final peak detail.

`ridge`

The centerline/profile emphasis of a mountain range. It shapes where the sharpest crest or spine should appear within an uplifted area. Ridge contributes to structural terrain shape and watershed formation, but water still follows the final/current height field.

`basin elevation delta`

A local structural height contribution from Basin Areas. It usually lowers terrain relative to nearby surroundings, but it is not a hydrology fact by itself. A basin can exist at high absolute elevation, such as an alpine bowl or caldera. After structural height is composed, drainage and lake detection should derive actual closed basins, minima, outlets, and flow paths from the resulting height field.

`flatness`

How strongly an area should smooth toward a floor, plain, plateau, lakebed, or valley bottom during structural generation. Flatness affects shape composition; it should not force perfectly flat final terrain after erosion unless generator settings explicitly choose that behavior.

`drainage cost`

Solver-facing movement/routing cost for water flow. Lower cost makes flow prefer a corridor or outlet when gravity and local slope allow it. It is similar in spirit to pathfinding cost, but it must remain subordinate to terrain height so authored guides do not create impossible uphill rivers.

`moisture`

Broad environmental moisture input from climate areas and hydrology outputs. It contributes to biome and mask generation and may influence erosion parameters such as rainfall amount, but it is not a direct height field.

`temperature`

Broad environmental temperature input from climate areas. It contributes to biome, snow, and mask generation. It should not directly sculpt terrain in V1.

`wear rate`

How easily hydraulic erosion cuts or transports material in an area. High wear rate means flowing water carves channels more readily. Low wear rate preserves forms against water erosion.

`slope hold`

How steep terrain can remain before thermal erosion relaxes it. High slope hold allows cliffs, canyon walls, hard ridges, and sharp shoulders. Low slope hold produces softer hills, slumped slopes, and more relaxed sediment-like terrain.

`strata/layering`

Controls horizontal or directional banding/stepping used for canyon walls, sedimentary shelves, mesas, and exposed layered rock. This can influence height detail, masks, and material appearance, but should remain subordinate to authored large-scale form.

`surface roughness`

Deterministic small- and medium-scale terrain variation contributed by terrain character areas or generator noise. It adds local texture such as broken volcanic ground, rocky chatter, subtle plain variation, or canyon wall roughness. Surface roughness is detail, not structure: it should not move mountain ranges, erase basins, or redirect major rivers.

Rasterization does not need to happen at full tile resolution.

V1 should support a lower-resolution field grid for semantic inputs:

* Field resolution may be coarser than depth-0 height tiles.
* Full-resolution generation samples the field grid with interpolation.
* Field resolution should be stored in bake metadata.
* Field sampling should use deterministic world-space coordinates so tile boundaries do not need special padding.

This lets large semantic shapes remain cheap while the final height pass still writes full-resolution R16 tiles.

### Raster Field Storage And Encoding

Rasterized fields are generated bake artifacts, not durable authoring state. They may be kept in memory only, written as a bake cache, or exported for debugging. If stored, use a field set: a small manifest plus raw channel planes. The manifest records grid dimensions, world bounds, cell size, encoding, value range, and channel paths. Fields may be packed into GPU textures during bake, but the debuggable representation should stay explicit.

Example manifest shape:

```ts
interface RasterFieldSet {
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

Recommended persistent encodings:

* `u8Norm`: normalized unsigned 8-bit values for soft influence, masks, and user-authored scalar controls where 256 steps are enough.
* `u16Norm`: normalized unsigned 16-bit values for absolute elevation-like fields where banding would be visible.
* `i16Norm`: normalized signed 16-bit values for height deltas that can raise or lower terrain.
* `f32`: transient working format for simulation or debug data when precision/range is unknown. Avoid using it as the default persistent format because it is larger and harder to inspect.

Recommended field encodings:

| Field | Encoding | Notes |
| --- | --- | --- |
| `base elevation` | `u16Norm` | Absolute structural elevation in world units over `[0, worldHeight]`. Use 16-bit to avoid visible height banding. |
| `land/sea intent` | `u8Norm` | Semantic above/below-water influence. Use `0` for sea, `0.5` for neutral, and `1` for land. 8-bit is sufficient because it is a broad blend/control field. |
| `uplift` | `u16Norm` or `i16Norm` | Use `u16Norm` if uplift only raises terrain. Use `i16Norm` if the generator allows negative tectonic/structural contribution. |
| `ridge` | `u8Norm` | Normalized ridge strength/profile emphasis. It shapes composition but is not an absolute height plane. |
| `basin elevation delta` | `i16Norm` | Signed structural height delta in world units. Usually negative, but signed storage keeps the field general. |
| `flatness` | `u8Norm` | Normalized smoothing/floor strength. 8-bit is enough for authored control. |
| `drainage cost` | `u8Norm` | Normalized routing cost modifier. Use `0.5` as neutral, lower values as cheaper/preferred flow, and higher values as more expensive/avoided flow. |
| `moisture` | `u8Norm` | Normalized climate/mask input. |
| `temperature` | `u8Norm` | Normalized climate input; metadata maps it to real/preset temperature ranges if needed. |
| `wear rate` | `u8Norm` | Normalized hydraulic erosion susceptibility. |
| `slope hold` | `u8Norm` | Normalized thermal erosion/cliff stability. |
| `strata/layering` | `u8Norm` | Normalized layer strength; spacing/orientation should live in terrain character settings unless a future field needs them. |
| `surface roughness` | `u8Norm` | Normalized local detail strength. |

Packing rules:

* Treat raster fields as rebuildable bake artifacts. The authoring document remains the source of truth.
* Store debug/cache raster fields as separate named planes first. This keeps the bake debuggable and avoids hard-coding early texture layouts into the project format.
* GPU bake code may pack compatible `u8Norm` fields into RGBA8 textures for efficiency, for example `flatness/drainageCost/wearRate/slopeHold`.
* Do not pack 16-bit height-like fields into 8-bit textures. Height contributors should preserve enough precision before final R16 height output.
* Any GPU packing layout should be derived from the manifest and treated as a cache, not the source of truth.
* If a field is absent, generators should use a documented default rather than requiring every bake to materialize every plane.

### Influence Evaluation

Each primitive rasterizes to one or more fields through a normalized influence value in `[0, 1]`.

For a region:

```text
signedDistance = distance outside or inside polygon boundary
insideDistance = positive distance from boundary toward polygon interior
influence = smoothstep(0, edgeSmoothness, insideDistance)
```

For a spline corridor:

```text
distance = shortest distance from sample point to spline centerline
halfWidth = width * 0.5
inner = max(0, halfWidth - edgeSmoothness)
influence = 1                    when distance <= inner
influence = 1 - smoothstep(inner, halfWidth, distance) when inner < distance < halfWidth
influence = 0                    when distance >= halfWidth
```

Per-anchor width, height, and strength overrides should be interpolated along the spline by arc length before rasterization.

Fields should be sampled in world coordinates. A primitive crossing tile boundaries should produce identical field values regardless of which tile asks for the sample.

---

## Drainage And Lake Solver Model

The V1 water model should stay small.

V1 solver inputs:

* world water level from the existing world config
* final/current terrain height
* optional drainage cost from River Guide Splines

V1 generated analysis:

* flow direction
* flow accumulation
* closed basins and local minima
* basin filling
* lake polygons
* river centerlines

`drainageCost` is the only V1 hydrology raster field. It is a soft routing preference, similar in spirit to pathfinding cost, but it must remain subordinate to terrain height. Gravity wins.

Water retention is still important, but in V1 it should be a derived analysis result rather than an authored raster field. The solver determines where water is retained by analyzing final/current terrain height, closed basins, outlets, basin filling, and world water level. A future Hydrology Area system may add an explicit `waterRetention` field when authors need wetlands, reservoirs, floodplains, or other water behavior that terrain shape alone cannot express.

V1 river guide behavior:

* River guides lower local drainage cost inside their corridor.
* Drainage can be biased toward the guide only when a downhill or near-level route exists.
* The solver must never create long uphill rivers to satisfy a guide.
* `influence` controls cost reduction.
* `width` and `edgeSmoothness` control the corridor shape.

V1 lake behavior:

* Lakes come from final/current terrain height, basin filling, outlet state, and world water level analysis.
* Basin areas provide the physical container.
* River guides can provide preferred outlets or downstream connections.
* There is no `lakeChance`.
* Generated lake polygons should include water surface elevation, polygon boundary, connected inflows/outflows, and source basin id when available.

Deferred water authoring behavior:

* Future Hydrology Areas can create wetlands, deltas, reservoir-like collection zones, and explicit avoidance zones. They are not V1 primitives.
* A future design may introduce additional fields such as water retention, source/sink strength, local waterbody level, or floodplain spread.
* Multiple water bodies may have local elevations, but this should not be mixed into V1 until the global water-level model is stable.
* The complete water solver deserves a dedicated design document before implementing advanced lake authoring.

---

## Generation Pipeline

### Pass 1 - Influence Rasterization

Rasterize all primitives into simulation fields.

Conflict rules:

* Use weighted blending for compatible fields.
* Use priority for land/sea conflicts.
* Use max or additive accumulation for uplift depending on generator setting.
* Store field previews for debugging.

### Pass 2 - Structural Terrain

Generate the initial terrain before erosion.

Sources:

* landmass base elevation
* mountain uplift
* basin elevation delta
* terrain character roughness
* deterministic low-frequency noise

Result:

* structural height field

This pass should create a plausible world-scale terrain shape before hydraulic erosion.

### Pass 3 - Drainage And Lake Analysis

This pass analyzes water movement from final/current terrain height, world water level, and optional river guide drainage cost.

V1 scope:

* compute flow direction
* compute flow accumulation
* detect closed basins and local minima from height
* identify potential lake basins
* apply river guides as soft drainage cost inputs
* respect gravity over authored guides

Future design doc:

* area-based hydrology authoring
* lake outlets
* basin filling
* wetlands and floodplains
* multiple local water bodies
* relationship between generated lakes and the world-level water plane

### Pass 4 - Hydraulic Erosion

Primary realism pass.

Implementation target:

* GPU compute shaders for production-quality bakes
* CPU prototypes are acceptable behind the same interfaces while algorithms stabilize
* deterministic execution
* explicit tile-neighborhood inputs for seam-aware computation
* avoid making particle droplets the only erosion path in V1

Simulation state:

* terrain height
* water depth
* sediment load
* flow velocity or flux

Per iteration:

1. add rainfall/source water
2. route water using terrain and drainage cost
3. erode terrain according to flow, slope, and terrain character fields
4. transport sediment
5. deposit sediment
6. evaporate or drain water

Outputs:

* eroded height field
* sediment field
* flow field

### Pass 5 - Thermal Erosion

Applies slope relaxation.

Purpose:

* talus slopes
* cliff breakdown
* mountain shoulders
* canyon wall stability

Influenced by:

* slope hold

### Pass 6 - River Extraction

Extract rivers from final flow accumulation and carved channels.

Generate:

* centerlines
* widths
* flow strength
* hierarchy/order

Export:

* `RiverSpline[]`
* optional GeoJSON

### Pass 7 - Lake Extraction

Generate lakes from:

* closed basins
* world water level
* computed outlet/drainage state

Export:

* `LakePolygon[]`

Lakes should be deterministic outputs, not random outcomes.

### Pass 8 - Mask Generation

Generate:

* slope
* flow
* moisture
* snow
* sediment
* rock exposure
* material/terrain character
* biome

Biome is derived from:

* elevation
* slope
* moisture
* temperature
* river proximity
* water proximity
* terrain character

---

## Noise System

WorldForge needs a robust deterministic noise library instead of one-off noise functions embedded in generators.

Required capabilities:

* seedable noise objects
* stable world-space sampling
* 2D and future 3D noise
* fractal Brownian motion
* domain warp
* ridged noise
* value remapping
* per-generator named noise channels
* serializable settings
* previewable noise in the inspector
* reroll seed per channel and reroll all ambient detail

Suggested V1 approach:

* Create a `NoiseGraph` or `NoiseSource` abstraction owned by generator settings.
* Wrap third-party implementations rather than exposing library APIs directly.
* Evaluate `simplex-noise` plus a seedable PRNG such as `alea` for lightweight JS/browser use.
* Evaluate `fastnoise-lite` for broader algorithm coverage if its package shape works well in the browser build.
* Keep the wrapper small enough that WebGPU/WGSL equivalents can be introduced later.

Noise should be used for ambient variation, not for violating authored structure. Rerolling a mountain range's ambient noise should change surface detail, not move the mountain range.

---

## Tile Simulation

Tile simulation should avoid seams without requiring every operation to allocate a large padded tile buffer.

Default compute contract:

* A tile compute call receives the target tile plus the surrounding 8 neighbor tiles when the operation needs cross-boundary context.
* Kernels read from the 3x3 neighborhood and write only the target tile.
* World-edge tiles receive a documented edge policy such as clamp, mirror, or virtual sea/void samples depending on the pass.
* Export writes the full target tile. There is no special rendering overlap requirement.

Halo/padding policy:

* Internal halo buffers are allowed as an implementation detail when a kernel is simpler or faster with contiguous padded memory.
* Halo size should be pass-specific and derived from the kernel radius, not a blanket fixed 32 pixels.
* A 3x3 tile neighborhood is enough for local kernels whose radius is less than one tile.
* Passes with larger spatial reach should operate on coarser field grids, multi-tile batches, or iterative global/streaming algorithms rather than silently increasing per-tile padding.

Field rasterization and noise sampling should be world-space deterministic so adjacent tiles agree at boundaries. Tile-local random state should be avoided unless it is derived from world coordinates and stable seeds.

---

## Export

Heightmaps:

* R16
* 16-bit PNG for engine import

Masks:

* PNG

Water:

* `rivers.json`
* `rivers.geojson`
* `lakes.json`

Metadata:

* `world.json`
* `tiles.json`
* `authoring.json`
* `bake.json`

---

## V1 Success Criteria

A user can:

1. Create or open a tiled world.
2. Set world size, world height, unit scale, and water level.
3. Draw landmass areas.
4. Draw mountain ranges.
5. Draw basins.
6. Draw river guides.
7. Define climate regions.
8. Define terrain character regions.
9. Select primitives and anchors.
10. Edit selected parameters in a contextual inspector.
11. Undo and redo authoring edits.
12. Explicitly bake the world.
13. Generate rivers automatically.
14. Generate lakes deterministically from terrain and water inputs.
15. Export tiled heightmaps, river splines, lake polygons, and terrain masks.

The resulting world should look closer to a naturally formed landscape than a manually sculpted heightmap while still feeling directly authorable.

---

## Deferred Topics

These are important, but should not block a coherent V1:

* point-of-interest and landmark authoring
* full lake/wetland/waterbody influence authoring
* local manual sculpting
* biome painting
* generated engine scenes
* multiple local water levels
* advanced erosion graph editing
