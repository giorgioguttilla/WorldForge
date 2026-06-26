import type { AnchorV1, AuthoringDocumentV1, LandformAreaV1, MountainSplineV1 } from './authoringDocument';
import type { WorldConfig } from '../heightmap/worldConfig';
import { sampleSplineAnchors } from './spline';
import { compileNoiseFieldGraph, type CompiledNoiseFieldGraph } from '../noiseGraph';
import type { NoiseFieldGraphV1 } from '../noiseGraph';

export interface StructuralEvaluation {
  elevation: number;
  landform?: LandformAreaV1;
  mountainContribution: number;
}

export interface Bounds2D {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface PreparedLandform {
  primitive: LandformAreaV1;
  order: number;
  xs: number[];
  zs: number[];
  segments: PreparedSegment[];
  bounds: Bounds2D;
}

export interface PreparedMountain {
  primitive: MountainSplineV1;
  xs: number[];
  zs: number[];
  segments: PreparedSegment[];
  bounds: Bounds2D;
}

interface PreparedSegment {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  startDistance: number;
  length: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface PreparedStructuralDocument {
  landforms: PreparedLandform[];
  mountains: PreparedMountain[];
  fieldLibrary: NoiseFieldGraphV1[];
  compiledFields: Map<string, CompiledNoiseFieldGraph>;
}

export function evaluateStructuralHeight(config: WorldConfig, document: AuthoringDocumentV1, worldX: number, worldZ: number, waterLevel: number): StructuralEvaluation {
  return evaluatePreparedStructuralHeight(config, prepareStructuralDocument(document), worldX, worldZ, waterLevel);
}

export function prepareStructuralDocument(document: AuthoringDocumentV1): PreparedStructuralDocument {
  const landforms = document.primitives
    .map((primitive, order) => ({ primitive, order }))
    .filter((entry): entry is { primitive: LandformAreaV1; order: number } => (
      entry.primitive.enabled && entry.primitive.type === 'landformArea' && entry.primitive.anchors.length >= 3
    ))
    .map(({ primitive, order }) => ({
      primitive,
      order,
      ...prepareAnchorArrays(sampleSplineAnchors(primitive.anchors, true, primitive.splineSmoothness), 0, true)
    }))
    .sort((a, b) => a.primitive.priority - b.primitive.priority || a.order - b.order);

  const mountains = document.primitives
    .filter((primitive): primitive is MountainSplineV1 => (
      primitive.enabled && primitive.type === 'mountainSpline' && primitive.anchors.length >= 2
    ))
    .map((primitive) => ({
      primitive,
      ...prepareAnchorArrays(sampleSplineAnchors(primitive.anchors, false, primitive.splineSmoothness), primitive.width / 2, false)
    }));

  const fieldLibrary = Array.isArray(document.fieldLibrary) ? document.fieldLibrary : [];
  return {
    landforms,
    mountains,
    fieldLibrary,
    compiledFields: compileFieldLibrary(fieldLibrary)
  };
}

export function filterPreparedStructuralDocumentForBounds(document: PreparedStructuralDocument, bounds: Bounds2D): PreparedStructuralDocument {
  return {
    landforms: document.landforms.filter((landform) => boundsOverlap(landform.bounds, bounds)),
    mountains: document.mountains
      .filter((mountain) => boundsOverlap(mountain.bounds, bounds))
      .map((mountain) => filterPreparedMountainForBounds(mountain, bounds))
      .filter((mountain): mountain is PreparedMountain => Boolean(mountain)),
    fieldLibrary: document.fieldLibrary,
    compiledFields: document.compiledFields
  };
}

export function evaluatePreparedStructuralHeight(
  config: WorldConfig,
  document: PreparedStructuralDocument,
  worldX: number,
  worldZ: number,
  waterLevel: number
): StructuralEvaluation {
  const baseElevation = 0;
  let elevation = baseElevation;
  let appliedLandform: LandformAreaV1 | undefined;
  for (const landform of document.landforms) {
    const primitive = landform.primitive;
    if (!boundsContains(landform.bounds, worldX, worldZ)) continue;
    const weight = preparedLandformWeightAt(landform, worldX, worldZ);
    if (weight <= 0) continue;
    elevation = lerp(elevation, getLandformTargetElevation(primitive, waterLevel, config.worldHeight), weight);
    appliedLandform = primitive;
  }

  let mountainContribution = 0;
  for (const mountain of document.mountains) {
    if (!boundsContains(mountain.bounds, worldX, worldZ)) continue;
    mountainContribution += preparedMountainWeightAt(mountain, worldX, worldZ) * Math.max(0, mountain.primitive.height);
  }
  elevation = clamp(elevation + mountainContribution, 0, config.worldHeight);

  return {
    elevation,
    landform: appliedLandform,
    mountainContribution
  };
}

export function landformWeightAt(primitive: LandformAreaV1, x: number, z: number): number {
  if (primitive.anchors.length < 3) return 0;
  const points = sampleSplineAnchors(primitive.anchors, true, primitive.splineSmoothness);
  if (!pointInSampledPolygon(x, z, points)) return 0;
  const edgeDistance = distanceToSampledPolyline(x, z, points, true);
  if (primitive.edgeSmoothness <= 0) return 1;
  return smoothstep(0, primitive.edgeSmoothness, edgeDistance);
}

export function mountainWeightAt(primitive: MountainSplineV1, x: number, z: number): number {
  if (primitive.anchors.length < 2 || primitive.width <= 0) return 0;
  const points = sampleSplineAnchors(primitive.anchors, false, primitive.splineSmoothness);
  const halfWidth = primitive.width / 2;
  const distance = distanceToSampledPolyline(x, z, points, false);
  if (distance >= halfWidth) return 0;
  const edgeSmoothness = Math.max(0, Math.min(primitive.edgeSmoothness, halfWidth));
  if (edgeSmoothness === 0) return 1 - distance / halfWidth;
  const fadeStart = Math.max(0, halfWidth - edgeSmoothness);
  if (distance <= fadeStart) return 1;
  return 1 - smoothstep(fadeStart, halfWidth, distance);
}

export function preparedLandformWeightAt(landform: PreparedLandform, x: number, z: number): number {
  if (!pointInPreparedPolygon(x, z, landform.xs, landform.zs)) return 0;
  if (landform.primitive.edgeSmoothness <= 0) return 1;
  const edgeDistance = distanceToPreparedSegments(x, z, landform.segments, landform.primitive.edgeSmoothness);
  return smoothstep(0, landform.primitive.edgeSmoothness, edgeDistance);
}

export function preparedMountainWeightAt(mountain: PreparedMountain, x: number, z: number): number {
  const primitive = mountain.primitive;
  if (primitive.width <= 0) return 0;
  const halfWidth = primitive.width / 2;
  const distance = distanceToPreparedSegments(x, z, mountain.segments, halfWidth);
  if (distance >= halfWidth) return 0;
  const edgeSmoothness = Math.max(0, Math.min(primitive.edgeSmoothness, halfWidth));
  if (edgeSmoothness === 0) return 1 - distance / halfWidth;
  const fadeStart = Math.max(0, halfWidth - edgeSmoothness);
  if (distance <= fadeStart) return 1;
  return 1 - smoothstep(fadeStart, halfWidth, distance);
}

function filterPreparedMountainForBounds(mountain: PreparedMountain, bounds: Bounds2D): PreparedMountain | null {
  const padding = mountain.primitive.width / 2;
  const segments = mountain.segments.filter((segment) => segmentOverlapsBounds(segment, bounds, padding));
  if (segments.length === 0) return null;
  return {
    ...mountain,
    segments,
    bounds: boundsFromSegments(segments, padding)
  };
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

export function pointInSplinePolygon(x: number, z: number, polygon: AnchorV1[], smoothness: number): boolean {
  return pointInSampledPolygon(x, z, sampleSplineAnchors(polygon, true, smoothness));
}

export function distanceToPolyline(x: number, z: number, anchors: AnchorV1[], closed: boolean): number {
  let bestSq = Number.POSITIVE_INFINITY;
  const segmentCount = closed ? anchors.length : anchors.length - 1;
  for (let i = 0; i < segmentCount; i += 1) {
    const a = anchors[i];
    const b = anchors[(i + 1) % anchors.length];
    bestSq = Math.min(bestSq, distanceToSegmentSq(x, z, a.x, a.z, b.x, b.z));
  }
  return Math.sqrt(bestSq);
}

export function distanceToSpline(x: number, z: number, anchors: AnchorV1[], closed: boolean, smoothness: number): number {
  return distanceToSampledPolyline(x, z, sampleSplineAnchors(anchors, closed, smoothness), closed);
}

function pointInPreparedPolygon(x: number, z: number, xs: number[], zs: number[]): boolean {
  let inside = false;
  for (let i = 0, j = xs.length - 1; i < xs.length; j = i, i += 1) {
    const zi = zs[i];
    const zj = zs[j];
    const intersects = zi > z !== zj > z && x < ((xs[j] - xs[i]) * (z - zi)) / (zj - zi || Number.EPSILON) + xs[i];
    if (intersects) inside = !inside;
  }
  return inside;
}

function pointInSampledPolygon(x: number, z: number, polygon: { x: number; z: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const pi = polygon[i];
    const pj = polygon[j];
    const intersects = pi.z > z !== pj.z > z && x < ((pj.x - pi.x) * (z - pi.z)) / (pj.z - pi.z || Number.EPSILON) + pi.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

function distanceToPreparedSegments(x: number, z: number, segments: PreparedSegment[], maxDistance: number): number {
  let bestSq = Number.POSITIVE_INFINITY;
  const maxDistanceSq = maxDistance * maxDistance;
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    if (
      x < segment.minX - maxDistance ||
      x > segment.maxX + maxDistance ||
      z < segment.minZ - maxDistance ||
      z > segment.maxZ + maxDistance
    ) {
      continue;
    }
    bestSq = Math.min(bestSq, distanceToSegmentSq(x, z, segment.ax, segment.az, segment.bx, segment.bz));
    if (bestSq === 0) return 0;
  }
  if (bestSq === Number.POSITIVE_INFINITY || bestSq > maxDistanceSq) return maxDistance + 1;
  return Math.sqrt(bestSq);
}

function distanceToSampledPolyline(x: number, z: number, points: { x: number; z: number }[], closed: boolean): number {
  let bestSq = Number.POSITIVE_INFINITY;
  const segmentCount = closed ? points.length : points.length - 1;
  for (let i = 0; i < segmentCount; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    bestSq = Math.min(bestSq, distanceToSegmentSq(x, z, a.x, a.z, b.x, b.z));
  }
  return Math.sqrt(bestSq);
}

export function distanceToSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  return Math.sqrt(distanceToSegmentSq(px, pz, ax, az, bx, bz));
}

function distanceToSegmentSq(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const lengthSq = dx * dx + dz * dz;
  if (lengthSq === 0) {
    const pointDx = px - ax;
    const pointDz = pz - az;
    return pointDx * pointDx + pointDz * pointDz;
  }
  const t = clamp(((px - ax) * dx + (pz - az) * dz) / lengthSq, 0, 1);
  const closestDx = px - (ax + dx * t);
  const closestDz = pz - (az + dz * t);
  return closestDx * closestDx + closestDz * closestDz;
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

function prepareAnchorArrays(anchors: { x: number; z: number }[], padding: number, closed: boolean): { xs: number[]; zs: number[]; segments: PreparedSegment[]; bounds: Bounds2D } {
  const xs: number[] = [];
  const zs: number[] = [];
  const segments: PreparedSegment[] = [];
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (const anchor of anchors) {
    xs.push(anchor.x);
    zs.push(anchor.z);
    minX = Math.min(minX, anchor.x);
    maxX = Math.max(maxX, anchor.x);
    minZ = Math.min(minZ, anchor.z);
    maxZ = Math.max(maxZ, anchor.z);
  }

  const segmentCount = closed ? anchors.length : anchors.length - 1;
  let distance = 0;
  for (let i = 0; i < segmentCount; i += 1) {
    const a = anchors[i];
    const b = anchors[(i + 1) % anchors.length];
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    segments.push({
      ax: a.x,
      az: a.z,
      bx: b.x,
      bz: b.z,
      startDistance: distance,
      length,
      minX: Math.min(a.x, b.x),
      maxX: Math.max(a.x, b.x),
      minZ: Math.min(a.z, b.z),
      maxZ: Math.max(a.z, b.z)
    });
    distance += length;
  }

  return {
    xs,
    zs,
    segments,
    bounds: {
      minX: minX - padding,
      maxX: maxX + padding,
      minZ: minZ - padding,
      maxZ: maxZ + padding
    }
  };
}

function compileFieldLibrary(fields: NoiseFieldGraphV1[]): Map<string, CompiledNoiseFieldGraph> {
  const compiled = new Map<string, CompiledNoiseFieldGraph>();
  for (const field of fields) {
    const evaluator = compileNoiseFieldGraph(field);
    if (evaluator) compiled.set(field.id, evaluator);
  }
  return compiled;
}

function boundsOverlap(a: Bounds2D, b: Bounds2D): boolean {
  return a.maxX >= b.minX && a.minX <= b.maxX && a.maxZ >= b.minZ && a.minZ <= b.maxZ;
}

function boundsContains(bounds: Bounds2D, x: number, z: number): boolean {
  return x >= bounds.minX && x <= bounds.maxX && z >= bounds.minZ && z <= bounds.maxZ;
}

function segmentOverlapsBounds(segment: PreparedSegment, bounds: Bounds2D, padding: number): boolean {
  return (
    segment.maxX + padding >= bounds.minX &&
    segment.minX - padding <= bounds.maxX &&
    segment.maxZ + padding >= bounds.minZ &&
    segment.minZ - padding <= bounds.maxZ
  );
}

function boundsFromSegments(segments: PreparedSegment[], padding: number): Bounds2D {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const segment of segments) {
    minX = Math.min(minX, segment.minX);
    maxX = Math.max(maxX, segment.maxX);
    minZ = Math.min(minZ, segment.minZ);
    maxZ = Math.max(maxZ, segment.maxZ);
  }
  return {
    minX: minX - padding,
    maxX: maxX + padding,
    minZ: minZ - padding,
    maxZ: maxZ + padding
  };
}
