import { DEFAULT_SPLINE_SMOOTHNESS } from './spline';
import { createDefaultNoiseFieldLibrary, normalizeNoiseGraph, type NoiseFieldGraphV1 } from '../noiseGraph';

export type PrimitiveTypeV1 = 'landformArea' | 'mountainSpline';
export type LandformModeV1 = 'land' | 'water' | 'plateau';
export type BakeStatusV1 = 'clean' | 'failed';
export type ErosionPresetV1 = 'light' | 'medium' | 'heavy' | 'custom';

export interface AnchorV1 {
  id: string;
  x: number;
  z: number;
}

export interface PrimitiveBaseV1 {
  id: string;
  type: PrimitiveTypeV1;
  name: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface LandformAreaV1 extends PrimitiveBaseV1 {
  type: 'landformArea';
  mode: LandformModeV1;
  elevation: number;
  fieldId?: string;
  noiseScale: number;
  edgeSmoothness: number;
  splineSmoothness: number;
  priority: number;
  anchors: AnchorV1[];
}

export interface MountainSplineV1 extends PrimitiveBaseV1 {
  type: 'mountainSpline';
  height: number;
  width: number;
  fieldId?: string;
  edgeSmoothness: number;
  splineSmoothness: number;
  anchors: AnchorV1[];
}

export type PrimitiveV1 = LandformAreaV1 | MountainSplineV1;

export interface BakeMetadataV1 {
  id: string;
  startedAt: string;
  completedAt?: string;
  status: BakeStatusV1;
  inputHash: string;
  primitiveCount: number;
  tileCount: number;
  erosion?: ErosionBakeSummaryV1;
  hydrology?: HydrologyBakeSummaryV1;
  error?: string;
}

export interface ErosionSettingsV1 {
  enabled: boolean;
  preset: ErosionPresetV1;
  hydraulicIterations: number;
  rainfall: number;
  evaporation: number;
  erosionStrength: number;
  depositionStrength: number;
  sedimentCapacity: number;
  hardness: number;
  thermalEnabled: boolean;
  thermalStrength: number;
  thermalIterations: number;
  talusAngleDegrees: number;
  chunkSize: number;
  overlap: number;
  outputWaterMask: boolean;
  waterMaskScale: number;
}

export interface ErosionBakeSummaryV1 {
  enabled: boolean;
  preset: ErosionPresetV1;
  hydraulicIterations: number;
  thermalIterations: number;
  chunkSize: number;
  overlap: number;
  waterMask: 'accumulated-water-influence';
  maxHeightDelta?: number;
  meanAbsHeightDelta?: number;
  maxWaterMask?: number;
  warnings: string[];
}

export interface HydrologyBasinSummaryV1 {
  id: number;
  fillHeight: number;
  minTerrainHeight: number;
  maxDepth: number;
  areaCells: number;
  volumeCellHeight: number;
  touchesOcean: boolean;
}

export interface HydrologyBakeSummaryV1 {
  enabled: boolean;
  epsilonR16: number;
  tileCount: number;
  basinCount: number;
  lakeCellCount: number;
  maxDepth: number;
  volumeCellHeight: number;
  lakeFillHeight: 'closed-basin-fill-height-r16';
  basinIds?: 'physical-filled-basin-id-u32';
  receiverDirections?: 'conditioned-flat-resolved-d-infinity-u16';
  topology?: 'physical-basin-topology-v3';
  flowStrength?: 'log1p-contributing-area-r16';
  flowAccumulation?: 'contributing-area-f32';
  maxFlowAccumulation?: number;
  flowTileCount?: number;
  basins: HydrologyBasinSummaryV1[];
  warnings: string[];
}

export interface HydrologyPointV1 {
  x: number;
  z: number;
  heightR16?: number;
}

export interface WaterBodyV1 {
  id: string;
  name: string;
  createdAt: string;
  sourceCellX: number;
  sourceCellY: number;
  waterLevelR16: number;
  areaCells: number;
  maxDepthR16: number;
  rings: HydrologyPointV1[][];
  basinId?: number;
}

export interface RiverSourceConstraintV2 {
  id: string;
  name: string;
  createdAt: string;
  sourceCellX: number;
  sourceCellY: number;
  discharge: number;
}

export interface RiverReachV2 {
  id: string;
  startCellId: number;
  endCellId: number;
  points: HydrologyPointV1[];
  downstreamReachId?: string;
  targetWaterBodyId?: string;
  targetBasinId?: number;
  termination: 'reach' | 'water-body' | 'edge' | 'stuck';
  sourceIds: string[];
  discharge: number;
  maxFlowStrengthR16: number;
  widthHint: number;
}

/** Derived connector that contracts a filled basin into one graph node. */
export interface RiverBasinNodeV2 {
  id: string;
  basinId: number;
  waterBodyId: string;
  status: 'continuous' | 'terminal';
  inletReachIds: string[];
  outletReachId?: string;
  spillCellId?: number;
  downstreamCellId?: number;
  sourceIds: string[];
  inflowDischarge: number;
  outflowDischarge: number;
}

export interface HydrologySceneV2 {
  version: 2;
  channelThreshold: number;
  waterBodies: WaterBodyV1[];
  riverSources: RiverSourceConstraintV2[];
  reaches: RiverReachV2[];
  basinNodes: RiverBasinNodeV2[];
}

export const DEFAULT_CHANNEL_THRESHOLD = 512;

export interface AuthoringDocumentV1 {
  version: 1;
  worldId: string;
  fieldLibrary: NoiseFieldGraphV1[];
  primitives: PrimitiveV1[];
  erosion: ErosionSettingsV1;
  hydrology: HydrologySceneV2;
  lastBake?: BakeMetadataV1;
}

const LAND_MODES = new Set<LandformModeV1>(['land', 'water', 'plateau']);

export const EROSION_PRESETS: Record<ErosionPresetV1, ErosionSettingsV1> = {
  light: {
    enabled: true,
    preset: 'light',
    hydraulicIterations: 24,
    rainfall: 0.18,
    evaporation: 0.38,
    erosionStrength: 0.12,
    depositionStrength: 0.2,
    sedimentCapacity: 0.7,
    hardness: 0.78,
    thermalEnabled: true,
    thermalStrength: 0.22,
    thermalIterations: 8,
    talusAngleDegrees: 42,
    chunkSize: 512,
    overlap: 32,
    outputWaterMask: true,
    waterMaskScale: 9
  },
  medium: {
    enabled: true,
    preset: 'medium',
    hydraulicIterations: 48,
    rainfall: 0.34,
    evaporation: 0.32,
    erosionStrength: 0.22,
    depositionStrength: 0.28,
    sedimentCapacity: 1,
    hardness: 0.58,
    thermalEnabled: true,
    thermalStrength: 0.34,
    thermalIterations: 14,
    talusAngleDegrees: 38,
    chunkSize: 512,
    overlap: 48,
    outputWaterMask: true,
    waterMaskScale: 14
  },
  heavy: {
    enabled: true,
    preset: 'heavy',
    hydraulicIterations: 80,
    rainfall: 0.52,
    evaporation: 0.26,
    erosionStrength: 0.34,
    depositionStrength: 0.36,
    sedimentCapacity: 1.25,
    hardness: 0.42,
    thermalEnabled: true,
    thermalStrength: 0.48,
    thermalIterations: 24,
    talusAngleDegrees: 34,
    chunkSize: 512,
    overlap: 64,
    outputWaterMask: true,
    waterMaskScale: 22
  },
  custom: {
    enabled: true,
    preset: 'custom',
    hydraulicIterations: 48,
    rainfall: 0.34,
    evaporation: 0.32,
    erosionStrength: 0.22,
    depositionStrength: 0.28,
    sedimentCapacity: 1,
    hardness: 0.58,
    thermalEnabled: true,
    thermalStrength: 0.34,
    thermalIterations: 14,
    talusAngleDegrees: 38,
    chunkSize: 512,
    overlap: 48,
    outputWaterMask: true,
    waterMaskScale: 14
  }
};

export function createEmptyAuthoringDocument(worldId: string): AuthoringDocumentV1 {
  return {
    version: 1,
    worldId,
    fieldLibrary: createDefaultNoiseFieldLibrary(),
    primitives: [],
    erosion: { ...EROSION_PRESETS.medium, enabled: false },
    hydrology: { version: 2, channelThreshold: DEFAULT_CHANNEL_THRESHOLD, waterBodies: [], riverSources: [], reaches: [], basinNodes: [] }
  };
}

export function normalizeAuthoringDocument(value: unknown, worldId: string): AuthoringDocumentV1 {
  if (!isRecord(value)) return createEmptyAuthoringDocument(worldId);
  const primitives = Array.isArray(value.primitives)
    ? value.primitives.map(normalizePrimitive).filter((primitive): primitive is PrimitiveV1 => Boolean(primitive))
    : [];
  const normalizedFields = Array.isArray(value.fieldLibrary)
    ? value.fieldLibrary.map((field, index) => normalizeNoiseGraph(field, `field-${index + 1}`, `Field ${index + 1}`))
    : [];
  const document: AuthoringDocumentV1 = {
    version: 1,
    worldId,
    fieldLibrary: mergeDefaultFields(normalizedFields),
    primitives,
    erosion: normalizeErosionSettings(value.erosion),
    hydrology: normalizeHydrologyScene(value.hydrology)
  };
  const lastBake = normalizeBakeMetadata(value.lastBake);
  if (lastBake) document.lastBake = lastBake;
  return document;
}

export function applyErosionPreset(preset: ErosionPresetV1, previous?: ErosionSettingsV1): ErosionSettingsV1 {
  if (preset === 'custom') {
    return normalizeErosionSettings({ ...previous, preset: 'custom' });
  }
  return {
    ...EROSION_PRESETS[preset],
    enabled: previous?.enabled ?? EROSION_PRESETS[preset].enabled,
    outputWaterMask: previous?.outputWaterMask ?? EROSION_PRESETS[preset].outputWaterMask
  };
}

export function createAnchor(x: number, z: number): AnchorV1 {
  return {
    id: crypto.randomUUID(),
    x,
    z
  };
}

export function createLandformArea(anchors: AnchorV1[], waterLevel: number, index: number): LandformAreaV1 {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    type: 'landformArea',
    name: `Landform ${index}`,
    enabled: true,
    createdAt: now,
    updatedAt: now,
    mode: 'land',
    elevation: Math.max(0, waterLevel + 80),
    noiseScale: 80,
    edgeSmoothness: 120,
    splineSmoothness: DEFAULT_SPLINE_SMOOTHNESS,
    priority: 0,
    anchors
  };
}

export function createMountainSpline(anchors: AnchorV1[], index: number): MountainSplineV1 {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    type: 'mountainSpline',
    name: `Mountain ${index}`,
    enabled: true,
    createdAt: now,
    updatedAt: now,
    height: 220,
    width: 550,
    edgeSmoothness: 180,
    splineSmoothness: DEFAULT_SPLINE_SMOOTHNESS,
    anchors
  };
}

function normalizePrimitive(value: unknown): PrimitiveV1 | null {
  if (!isRecord(value)) return null;
  const base = normalizeBase(value);
  if (!base) return null;
  const anchors = Array.isArray(value.anchors) ? value.anchors.map(normalizeAnchor).filter((anchor): anchor is AnchorV1 => Boolean(anchor)) : [];
  if (base.type === 'landformArea') {
    return {
      ...base,
      type: 'landformArea',
      mode: LAND_MODES.has(value.mode as LandformModeV1) ? (value.mode as LandformModeV1) : 'land',
      elevation: finiteNumber(value.elevation, 0),
      fieldId: typeof value.fieldId === 'string' && value.fieldId ? value.fieldId : undefined,
      noiseScale: finiteNumber(value.noiseScale, 80),
      edgeSmoothness: Math.max(0, finiteNumber(value.edgeSmoothness, 0)),
      splineSmoothness: clamp(finiteNumber(value.splineSmoothness, DEFAULT_SPLINE_SMOOTHNESS), 0, 1),
      priority: finiteNumber(value.priority, 0),
      anchors
    };
  }
  if (base.type === 'mountainSpline') {
    return {
      ...base,
      type: 'mountainSpline',
      height: finiteNumber(value.height, 0),
      width: Math.max(0, finiteNumber(value.width, 0)),
      fieldId: typeof value.fieldId === 'string' && value.fieldId ? value.fieldId : undefined,
      edgeSmoothness: Math.max(0, finiteNumber(value.edgeSmoothness, 0)),
      splineSmoothness: clamp(finiteNumber(value.splineSmoothness, DEFAULT_SPLINE_SMOOTHNESS), 0, 1),
      anchors
    };
  }
  return null;
}

function mergeDefaultFields(fields: NoiseFieldGraphV1[]): NoiseFieldGraphV1[] {
  const defaults = createDefaultNoiseFieldLibrary();
  const seen = new Set(fields.map((field) => field.id));
  return [...fields, ...defaults.filter((field) => !seen.has(field.id))];
}

function normalizeBase(value: Record<string, unknown>): PrimitiveBaseV1 | null {
  if (value.type !== 'landformArea' && value.type !== 'mountainSpline') return null;
  const now = new Date().toISOString();
  return {
    id: typeof value.id === 'string' && value.id ? value.id : crypto.randomUUID(),
    type: value.type,
    name: typeof value.name === 'string' && value.name.trim() ? value.name : 'Primitive',
    enabled: value.enabled !== false,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : now,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : now
  };
}

function normalizeAnchor(value: unknown): AnchorV1 | null {
  if (!isRecord(value)) return null;
  const x = finiteNumber(value.x, Number.NaN);
  const z = finiteNumber(value.z, Number.NaN);
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  return {
    id: typeof value.id === 'string' && value.id ? value.id : crypto.randomUUID(),
    x,
    z
  };
}

function normalizeBakeMetadata(value: unknown): BakeMetadataV1 | undefined {
  if (!isRecord(value)) return undefined;
  if (value.status !== 'clean' && value.status !== 'failed') return undefined;
  return {
    id: typeof value.id === 'string' ? value.id : crypto.randomUUID(),
    startedAt: typeof value.startedAt === 'string' ? value.startedAt : new Date().toISOString(),
    completedAt: typeof value.completedAt === 'string' ? value.completedAt : undefined,
    status: value.status,
    inputHash: typeof value.inputHash === 'string' ? value.inputHash : '',
    primitiveCount: Math.max(0, finiteNumber(value.primitiveCount, 0)),
    tileCount: Math.max(0, finiteNumber(value.tileCount, 0)),
    erosion: normalizeErosionBakeSummary(value.erosion),
    hydrology: normalizeHydrologyBakeSummary(value.hydrology),
    error: typeof value.error === 'string' ? value.error : undefined
  };
}

export function normalizeErosionSettings(value: unknown): ErosionSettingsV1 {
  const source = isRecord(value) ? value : {};
  const preset = source.preset === 'light' || source.preset === 'heavy' || source.preset === 'custom' ? source.preset : 'medium';
  const defaults = EROSION_PRESETS[preset];
  return {
    enabled: Boolean(source.enabled),
    preset,
    hydraulicIterations: clamp(Math.trunc(finiteNumber(source.hydraulicIterations, defaults.hydraulicIterations)), 0, 500),
    rainfall: clamp(finiteNumber(source.rainfall, defaults.rainfall), 0, 10),
    evaporation: clamp(finiteNumber(source.evaporation, defaults.evaporation), 0, 1),
    erosionStrength: clamp(finiteNumber(source.erosionStrength, defaults.erosionStrength), 0, 10),
    depositionStrength: clamp(finiteNumber(source.depositionStrength, defaults.depositionStrength), 0, 10),
    sedimentCapacity: clamp(finiteNumber(source.sedimentCapacity, defaults.sedimentCapacity), 0, 20),
    hardness: clamp(finiteNumber(source.hardness, defaults.hardness), 0, 1),
    thermalEnabled: source.thermalEnabled !== false,
    thermalStrength: clamp(finiteNumber(source.thermalStrength, defaults.thermalStrength), 0, 10),
    thermalIterations: clamp(Math.trunc(finiteNumber(source.thermalIterations, defaults.thermalIterations)), 0, 500),
    talusAngleDegrees: clamp(finiteNumber(source.talusAngleDegrees, defaults.talusAngleDegrees), 1, 89),
    chunkSize: clamp(Math.trunc(finiteNumber(source.chunkSize, defaults.chunkSize)), 64, 4096),
    overlap: clamp(Math.trunc(finiteNumber(source.overlap, defaults.overlap)), 2, 512),
    outputWaterMask: source.outputWaterMask !== false,
    waterMaskScale: Math.max(0.0001, finiteNumber(source.waterMaskScale, defaults.waterMaskScale))
  };
}

function normalizeErosionBakeSummary(value: unknown): ErosionBakeSummaryV1 | undefined {
  if (!isRecord(value)) return undefined;
  const settings = normalizeErosionSettings(value);
  return {
    enabled: Boolean(value.enabled),
    preset: settings.preset,
    hydraulicIterations: settings.hydraulicIterations,
    thermalIterations: settings.thermalIterations,
    chunkSize: settings.chunkSize,
    overlap: settings.overlap,
    waterMask: 'accumulated-water-influence',
    maxHeightDelta: Number.isFinite(value.maxHeightDelta) ? Number(value.maxHeightDelta) : undefined,
    meanAbsHeightDelta: Number.isFinite(value.meanAbsHeightDelta) ? Number(value.meanAbsHeightDelta) : undefined,
    maxWaterMask: Number.isFinite(value.maxWaterMask) ? Number(value.maxWaterMask) : undefined,
    warnings: Array.isArray(value.warnings) ? value.warnings.filter((warning): warning is string => typeof warning === 'string') : []
  };
}

function normalizeHydrologyBakeSummary(value: unknown): HydrologyBakeSummaryV1 | undefined {
  if (!isRecord(value)) return undefined;
  const basins = Array.isArray(value.basins)
    ? value.basins.map((basin) => {
        if (!isRecord(basin)) return null;
        return {
          id: Math.max(0, Math.trunc(finiteNumber(basin.id, 0))),
          fillHeight: finiteNumber(basin.fillHeight, 0),
          minTerrainHeight: finiteNumber(basin.minTerrainHeight, 0),
          maxDepth: finiteNumber(basin.maxDepth, 0),
          areaCells: Math.max(0, Math.trunc(finiteNumber(basin.areaCells, 0))),
          volumeCellHeight: Math.max(0, finiteNumber(basin.volumeCellHeight, 0)),
          touchesOcean: Boolean(basin.touchesOcean)
        };
      }).filter((basin): basin is HydrologyBasinSummaryV1 => Boolean(basin))
    : [];
  return {
    enabled: Boolean(value.enabled),
    epsilonR16: Math.max(1, Math.trunc(finiteNumber(value.epsilonR16, 1))),
    tileCount: Math.max(0, Math.trunc(finiteNumber(value.tileCount, 0))),
    basinCount: Math.max(0, Math.trunc(finiteNumber(value.basinCount, basins.length))),
    lakeCellCount: Math.max(0, Math.trunc(finiteNumber(value.lakeCellCount, 0))),
    maxDepth: Math.max(0, finiteNumber(value.maxDepth, 0)),
    volumeCellHeight: Math.max(0, finiteNumber(value.volumeCellHeight, 0)),
    lakeFillHeight: 'closed-basin-fill-height-r16',
    basinIds: value.basinIds === 'physical-filled-basin-id-u32' ? value.basinIds : undefined,
    receiverDirections: value.receiverDirections === 'conditioned-flat-resolved-d-infinity-u16' ? value.receiverDirections : undefined,
    topology: value.topology === 'physical-basin-topology-v3' ? value.topology : undefined,
    flowStrength: value.flowStrength === 'log1p-contributing-area-r16' ? value.flowStrength : undefined,
    flowAccumulation: value.flowAccumulation === 'contributing-area-f32' ? value.flowAccumulation : undefined,
    maxFlowAccumulation: Number.isFinite(value.maxFlowAccumulation) ? Math.max(0, Number(value.maxFlowAccumulation)) : undefined,
    flowTileCount: Number.isFinite(value.flowTileCount) ? Math.max(0, Math.trunc(Number(value.flowTileCount))) : undefined,
    basins,
    warnings: Array.isArray(value.warnings) ? value.warnings.filter((warning): warning is string => typeof warning === 'string') : []
  };
}

function normalizeHydrologyScene(value: unknown): HydrologySceneV2 {
  if (!isRecord(value)) return { version: 2, channelThreshold: DEFAULT_CHANNEL_THRESHOLD, waterBodies: [], riverSources: [], reaches: [], basinNodes: [] };
  return {
    version: 2,
    channelThreshold: Math.max(1, finiteNumber(value.channelThreshold, DEFAULT_CHANNEL_THRESHOLD)),
    waterBodies: Array.isArray(value.waterBodies)
      ? value.waterBodies.map(normalizeWaterBody).filter((body): body is WaterBodyV1 => Boolean(body))
      : [],
    riverSources: value.version === 2 && Array.isArray(value.riverSources)
      ? value.riverSources.map(normalizeRiverSource).filter((source): source is RiverSourceConstraintV2 => Boolean(source))
      : [],
    reaches: value.version === 2 && Array.isArray(value.reaches)
      ? value.reaches.map(normalizeRiverReach).filter((reach): reach is RiverReachV2 => Boolean(reach))
      : [],
    basinNodes: value.version === 2 && Array.isArray(value.basinNodes)
      ? value.basinNodes.map(normalizeRiverBasinNode).filter((node): node is RiverBasinNodeV2 => Boolean(node))
      : []
  };
}

function normalizeWaterBody(value: unknown): WaterBodyV1 | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id) return null;
  const rings = Array.isArray(value.rings)
    ? value.rings.map((ring) => Array.isArray(ring) ? ring.map(normalizeHydrologyPoint).filter((point): point is HydrologyPointV1 => Boolean(point)) : []).filter((ring) => ring.length >= 4)
    : [];
  if (rings.length === 0) return null;
  return {
    id: value.id,
    name: typeof value.name === 'string' && value.name ? value.name : 'Water body',
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date().toISOString(),
    sourceCellX: Math.max(0, Math.trunc(finiteNumber(value.sourceCellX, 0))),
    sourceCellY: Math.max(0, Math.trunc(finiteNumber(value.sourceCellY, 0))),
    waterLevelR16: clamp(Math.trunc(finiteNumber(value.waterLevelR16, finiteNumber(value.maxFillHeightR16, 0))), 0, 65535),
    areaCells: Math.max(0, Math.trunc(finiteNumber(value.areaCells, 0))),
    maxDepthR16: clamp(Math.trunc(finiteNumber(value.maxDepthR16, 0)), 0, 65535),
    rings,
    basinId: Number.isFinite(value.basinId) ? Math.max(1, Math.trunc(Number(value.basinId))) : undefined
  };
}

function normalizeRiverSource(value: unknown): RiverSourceConstraintV2 | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id) return null;
  return {
    id: value.id,
    name: typeof value.name === 'string' && value.name ? value.name : 'River source',
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date().toISOString(),
    sourceCellX: Math.max(0, Math.trunc(finiteNumber(value.sourceCellX, 0))),
    sourceCellY: Math.max(0, Math.trunc(finiteNumber(value.sourceCellY, 0))),
    discharge: Math.max(0.001, finiteNumber(value.discharge, 1))
  };
}

function normalizeRiverReach(value: unknown): RiverReachV2 | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id) return null;
  const points = Array.isArray(value.points) ? value.points.map(normalizeHydrologyPoint).filter((point): point is HydrologyPointV1 => Boolean(point)) : [];
  if (points.length < 2) return null;
  return {
    id: value.id,
    startCellId: Math.max(0, Math.trunc(finiteNumber(value.startCellId, 0))),
    endCellId: Math.max(0, Math.trunc(finiteNumber(value.endCellId, 0))),
    points,
    downstreamReachId: typeof value.downstreamReachId === 'string' ? value.downstreamReachId : undefined,
    targetWaterBodyId: typeof value.targetWaterBodyId === 'string' ? value.targetWaterBodyId : undefined,
    targetBasinId: Number.isFinite(value.targetBasinId) ? Math.max(1, Math.trunc(Number(value.targetBasinId))) : undefined,
    termination: value.termination === 'reach' || value.termination === 'water-body' || value.termination === 'edge' ? value.termination : 'stuck',
    sourceIds: stringArray(value.sourceIds),
    discharge: Math.max(0, finiteNumber(value.discharge, 0)),
    maxFlowStrengthR16: clamp(Math.trunc(finiteNumber(value.maxFlowStrengthR16, 0)), 0, 65535),
    widthHint: Math.max(1, finiteNumber(value.widthHint, 1))
  };
}

function normalizeRiverBasinNode(value: unknown): RiverBasinNodeV2 | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id || !Number.isFinite(value.basinId) || typeof value.waterBodyId !== 'string') return null;
  return {
    id: value.id,
    basinId: Math.max(1, Math.trunc(Number(value.basinId))),
    waterBodyId: value.waterBodyId,
    status: value.status === 'continuous' ? 'continuous' : 'terminal',
    inletReachIds: stringArray(value.inletReachIds),
    outletReachId: typeof value.outletReachId === 'string' ? value.outletReachId : undefined,
    spillCellId: Number.isFinite(value.spillCellId) ? Math.max(0, Math.trunc(Number(value.spillCellId))) : undefined,
    downstreamCellId: Number.isFinite(value.downstreamCellId) ? Math.max(0, Math.trunc(Number(value.downstreamCellId))) : undefined,
    sourceIds: stringArray(value.sourceIds),
    inflowDischarge: Math.max(0, finiteNumber(value.inflowDischarge, 0)),
    outflowDischarge: Math.max(0, finiteNumber(value.outflowDischarge, 0))
  };
}

function normalizeHydrologyPoint(value: unknown): HydrologyPointV1 | null {
  if (!isRecord(value)) return null;
  const x = finiteNumber(value.x, Number.NaN);
  const z = finiteNumber(value.z, Number.NaN);
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  return {
    x,
    z,
    heightR16: Number.isFinite(value.heightR16) ? clamp(Math.trunc(Number(value.heightR16)), 0, 65535) : undefined
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function finiteNumber(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
