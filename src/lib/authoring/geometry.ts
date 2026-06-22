import type { AnchorV1, AuthoringDocumentV1, LandformAreaV1, MountainSplineV1 } from './authoringDocument';
import type { WorldConfig } from '../heightmap/worldConfig';

export interface StructuralEvaluation {
  elevation: number;
  landform?: LandformAreaV1;
  mountainContribution: number;
}

interface LandformCandidate {
  primitive: LandformAreaV1;
  elevation: number;
  weight: number;
  order: number;
}

export function evaluateStructuralHeight(config: WorldConfig, document: AuthoringDocumentV1, worldX: number, worldZ: number, waterLevel: number): StructuralEvaluation {
  const baseElevation = clamp(waterLevel + config.worldHeight * 0.05, 0, config.worldHeight);
  const landforms = document.primitives.filter((primitive): primitive is LandformAreaV1 => (
    primitive.enabled && primitive.type === 'landformArea' && primitive.anchors.length >= 3
  ));
  const mountains = document.primitives.filter((primitive): primitive is MountainSplineV1 => (
    primitive.enabled && primitive.type === 'mountainSpline' && primitive.anchors.length >= 2
  ));

  const candidates: LandformCandidate[] = [];
  landforms.forEach((primitive, order) => {
    const weight = landformWeightAt(primitive, worldX, worldZ);
    if (weight <= 0) return;
    candidates.push({
      primitive,
      elevation: getLandformTargetElevation(primitive, waterLevel, config.worldHeight),
      weight,
      order
    });
  });

  candidates.sort((a, b) => b.primitive.priority - a.primitive.priority || b.order - a.order);
  const selected = candidates[0];
  let elevation = selected ? lerp(baseElevation, selected.elevation, selected.weight) : baseElevation;
  let mountainContribution = 0;
  for (const primitive of mountains) {
    mountainContribution += mountainWeightAt(primitive, worldX, worldZ) * Math.max(0, primitive.height);
  }
  elevation = clamp(elevation + mountainContribution, 0, config.worldHeight);

  return {
    elevation,
    landform: selected?.primitive,
    mountainContribution
  };
}

export function landformWeightAt(primitive: LandformAreaV1, x: number, z: number): number {
  if (primitive.anchors.length < 3) return 0;
  if (!pointInPolygon(x, z, primitive.anchors)) return 0;
  const edgeDistance = distanceToPolyline(x, z, primitive.anchors, true);
  if (primitive.edgeSmoothness <= 0) return 1;
  return smoothstep(0, primitive.edgeSmoothness, edgeDistance);
}

export function mountainWeightAt(primitive: MountainSplineV1, x: number, z: number): number {
  if (primitive.anchors.length < 2 || primitive.width <= 0) return 0;
  const halfWidth = primitive.width / 2;
  const distance = distanceToPolyline(x, z, primitive.anchors, false);
  if (distance >= halfWidth) return 0;
  const edgeSmoothness = Math.max(0, Math.min(primitive.edgeSmoothness, halfWidth));
  if (edgeSmoothness === 0) return 1 - distance / halfWidth;
  const fadeStart = Math.max(0, halfWidth - edgeSmoothness);
  if (distance <= fadeStart) return 1;
  return 1 - smoothstep(fadeStart, halfWidth, distance);
}

export function pointInPolygon(x: number, z: number, polygon: AnchorV1[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const pi = polygon[i];
    const pj = polygon[j];
    const intersects = pi.z > z !== pj.z > z && x < ((pj.x - pi.x) * (z - pi.z)) / (pj.z - pi.z || Number.EPSILON) + pi.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

export function distanceToPolyline(x: number, z: number, anchors: AnchorV1[], closed: boolean): number {
  let best = Number.POSITIVE_INFINITY;
  const segmentCount = closed ? anchors.length : anchors.length - 1;
  for (let i = 0; i < segmentCount; i += 1) {
    const a = anchors[i];
    const b = anchors[(i + 1) % anchors.length];
    best = Math.min(best, distanceToSegment(x, z, a.x, a.z, b.x, b.z));
  }
  return best;
}

export function distanceToSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const lengthSq = dx * dx + dz * dz;
  if (lengthSq === 0) return Math.hypot(px - ax, pz - az);
  const t = clamp(((px - ax) * dx + (pz - az) * dz) / lengthSq, 0, 1);
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}

export function smoothstep(edge0: number, edge1: number, value: number): number {
  if (edge0 === edge1) return value >= edge1 ? 1 : 0;
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

export function elevationToR16(elevation: number, worldHeight: number): number {
  return Math.round((clamp(elevation, 0, worldHeight) / worldHeight) * 65535);
}

export function stableAuthoringHash(config: Pick<WorldConfig, 'id' | 'tileSize' | 'tilesPerSide' | 'unitSize' | 'worldHeight'>, document: AuthoringDocumentV1, waterLevel: number): string {
  const payload = JSON.stringify({
    config,
    waterLevel,
    primitives: document.primitives
  });
  let hash = 2166136261;
  for (let i = 0; i < payload.length; i += 1) {
    hash ^= payload.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function getLandformTargetElevation(primitive: LandformAreaV1, waterLevel: number, worldHeight: number): number {
  if (primitive.mode === 'water') return clamp(Math.min(primitive.elevation, waterLevel - 1), 0, worldHeight);
  return clamp(Math.max(primitive.elevation, waterLevel + 1), 0, worldHeight);
}
