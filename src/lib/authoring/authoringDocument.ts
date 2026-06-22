export type PrimitiveTypeV1 = 'landformArea' | 'mountainSpline';
export type LandformModeV1 = 'land' | 'water' | 'plateau';
export type BakeStatusV1 = 'clean' | 'failed';

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
  edgeSmoothness: number;
  priority: number;
  anchors: AnchorV1[];
}

export interface MountainSplineV1 extends PrimitiveBaseV1 {
  type: 'mountainSpline';
  height: number;
  width: number;
  edgeSmoothness: number;
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
  error?: string;
}

export interface AuthoringDocumentV1 {
  version: 1;
  worldId: string;
  primitives: PrimitiveV1[];
  lastBake?: BakeMetadataV1;
}

const LAND_MODES = new Set<LandformModeV1>(['land', 'water', 'plateau']);

export function createEmptyAuthoringDocument(worldId: string): AuthoringDocumentV1 {
  return {
    version: 1,
    worldId,
    primitives: []
  };
}

export function normalizeAuthoringDocument(value: unknown, worldId: string): AuthoringDocumentV1 {
  if (!isRecord(value)) return createEmptyAuthoringDocument(worldId);
  const primitives = Array.isArray(value.primitives)
    ? value.primitives.map(normalizePrimitive).filter((primitive): primitive is PrimitiveV1 => Boolean(primitive))
    : [];
  const document: AuthoringDocumentV1 = {
    version: 1,
    worldId,
    primitives
  };
  const lastBake = normalizeBakeMetadata(value.lastBake);
  if (lastBake) document.lastBake = lastBake;
  return document;
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
    edgeSmoothness: 120,
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
      edgeSmoothness: Math.max(0, finiteNumber(value.edgeSmoothness, 0)),
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
      edgeSmoothness: Math.max(0, finiteNumber(value.edgeSmoothness, 0)),
      anchors
    };
  }
  return null;
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
    error: typeof value.error === 'string' ? value.error : undefined
  };
}

function finiteNumber(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
