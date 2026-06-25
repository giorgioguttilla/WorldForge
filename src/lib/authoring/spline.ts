import type { AnchorV1 } from './authoringDocument';

export const DEFAULT_SPLINE_SMOOTHNESS = 0.65;

export interface SplinePoint2D {
  x: number;
  z: number;
}

export function normalizeSplineSmoothness(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? clamp(number, 0, 1) : DEFAULT_SPLINE_SMOOTHNESS;
}

export function sampleSplineAnchors(anchors: AnchorV1[], closed: boolean, smoothness = DEFAULT_SPLINE_SMOOTHNESS): SplinePoint2D[] {
  if (anchors.length === 0) return [];
  if (anchors.length < 3 || smoothness <= 0) return anchors.map(({ x, z }) => ({ x, z }));

  const segmentCount = closed ? anchors.length : anchors.length - 1;
  const points: SplinePoint2D[] = [];
  const clampedSmoothness = clamp(smoothness, 0, 1);

  for (let i = 0; i < segmentCount; i += 1) {
    const p0 = getControlPoint(anchors, i - 1, closed);
    const p1 = getControlPoint(anchors, i, closed);
    const p2 = getControlPoint(anchors, i + 1, closed);
    const p3 = getControlPoint(anchors, i + 2, closed);
    const length = Math.hypot(p2.x - p1.x, p2.z - p1.z);
    const steps = Math.max(4, Math.ceil(length / 80));

    for (let step = 0; step < steps; step += 1) {
      if (i > 0 && step === 0) continue;
      const t = step / steps;
      const curved = catmullRom(p0, p1, p2, p3, t);
      const linear = {
        x: p1.x + (p2.x - p1.x) * t,
        z: p1.z + (p2.z - p1.z) * t
      };
      points.push({
        x: linear.x + (curved.x - linear.x) * clampedSmoothness,
        z: linear.z + (curved.z - linear.z) * clampedSmoothness
      });
    }
  }

  if (!closed) {
    const last = anchors[anchors.length - 1];
    points.push({ x: last.x, z: last.z });
  }

  return points;
}

function getControlPoint(anchors: AnchorV1[], index: number, closed: boolean): AnchorV1 {
  if (closed) return anchors[(index + anchors.length) % anchors.length];
  return anchors[clamp(index, 0, anchors.length - 1)];
}

function catmullRom(p0: AnchorV1, p1: AnchorV1, p2: AnchorV1, p3: AnchorV1, t: number): SplinePoint2D {
  const t2 = t * t;
  const t3 = t2 * t;
  return {
    x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
    z: 0.5 * ((2 * p1.z) + (-p0.z + p2.z) * t + (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2 + (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * t3)
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
