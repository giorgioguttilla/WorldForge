import { expect, it } from 'vitest';
import { materializeGlobalReceivers } from './hydrologyBake';

const DX = new Int8Array([0, 1, 0, 1, -1, 0, -1, 1, -1]);
const DY = new Int8Array([0, 0, 1, 1, 0, -1, -1, -1, 1]);
const CODES = new Uint8Array([1, 3, 2, 8, 4, 6, 5, 7]);
const STEPS = 65528;
const NO_DISTANCE = 0xffffffff;

function legacy(size: number, tiles: number, tileX: number, tileY: number, surface: Uint16Array, distances: Uint32Array): Uint16Array {
  const stride = size + 2;
  const full = size * tiles;
  const output = new Uint16Array(size * size);
  output.fill(0xffff);
  const epsilon = 0.25 / (full * full + 1);
  const potential = (x: number, y: number) => {
    const index = y * stride + x;
    return surface[index] + (distances[index] === NO_DISTANCE ? 0 : distances[index] * epsilon);
  };
  const normalize = (angle: number) => angle < 0 ? angle + Math.PI * 2 : angle;
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
    const gx = tileX * size + x;
    const gy = tileY * size + y;
    if (gx === 0 || gy === 0 || gx === full - 1 || gy === full - 1) continue;
    const hx = x + 1;
    const hy = y + 1;
    const current = potential(hx, hy);
    let bestSlope = 0;
    let bestAngle = -1;
    for (let facet = 0; facet < 8; facet += 1) {
      const codeA = CODES[facet];
      const codeB = CODES[(facet + 1) & 7];
      const ax = DX[codeA], ay = DY[codeA], bx = DX[codeB], by = DY[codeB];
      const za = potential(hx + ax, hy + ay);
      const zb = potential(hx + bx, hy + by);
      const determinant = ax * by - bx * ay;
      const da = za - current, db = zb - current;
      const downX = -(da * by - db * ay) / determinant;
      const downY = -(ax * db - bx * da) / determinant;
      const planeSlope = Math.hypot(downX, downY);
      const startAngle = facet * Math.PI / 4;
      const planeAngle = normalize(Math.atan2(downY, downX));
      let relative = (planeAngle - startAngle) % (Math.PI * 2);
      if (relative < 0) relative += Math.PI * 2;
      if (planeSlope > 0 && relative <= Math.PI / 4 + 1e-12) {
        const fractionB = Math.min(1, Math.max(0, relative / (Math.PI / 4)));
        const usesA = fractionB < 1 - 1e-12;
        const usesB = fractionB > 1e-12;
        if ((!usesA || za < current) && (!usesB || zb < current) && planeSlope > bestSlope) {
          bestSlope = planeSlope;
          bestAngle = planeAngle;
        }
      }
      const slopeA = (current - za) / Math.hypot(ax, ay);
      if (slopeA > bestSlope) { bestSlope = slopeA; bestAngle = startAngle; }
      const slopeB = (current - zb) / Math.hypot(bx, by);
      if (slopeB > bestSlope) { bestSlope = slopeB; bestAngle = normalize(startAngle + Math.PI / 4); }
    }
    if (bestAngle >= 0) output[y * size + x] = Math.round(bestAngle / (Math.PI * 2) * STEPS) % STEPS;
  }
  return output;
}

function selectedSlope(encoded: number, cell: number, size: number, tiles: number, surface: Uint16Array, distances: Uint32Array): number {
  if (encoded >= STEPS) return 0;
  const stride = size + 2;
  const epsilon = 0.25 / ((size * tiles) ** 2 + 1);
  const potential = (x: number, y: number) => {
    const index = y * stride + x;
    return surface[index] + (distances[index] === NO_DISTANCE ? 0 : distances[index] * epsilon);
  };
  const sectorSteps = STEPS / 8;
  const sector = Math.floor(encoded / sectorSteps) & 7;
  const fraction = (encoded - sector * sectorSteps) / sectorSteps;
  const x = cell % size, y = Math.floor(cell / size), hx = x + 1, hy = y + 1;
  const current = potential(hx, hy);
  const codeA = CODES[sector], codeB = CODES[(sector + 1) & 7];
  const ax = DX[codeA], ay = DY[codeA], bx = DX[codeB], by = DY[codeB];
  const za = potential(hx + ax, hy + ay), zb = potential(hx + bx, hy + by);
  if (fraction === 0) return (current - za) / Math.hypot(ax, ay);
  const da = za - current, db = zb - current;
  const downX = -(da * by - db * ay);
  const downY = -(ax * db - bx * da);
  return Math.hypot(downX, downY);
}

it('matches the previous D-infinity facet solver', () => {
  const size = 64;
  const stride = size + 2;
  let state = 0x12345678;
  const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 0x100000000);
  let differenceCount = 0;
  const examples: string[] = [];
  let maximumSlopeDifference = 0;
  for (let pass = 0; pass < 24; pass += 1) {
    const surface = new Uint16Array(stride * stride);
    const distances = new Uint32Array(stride * stride);
    const base = 1000 + pass * 100;
    for (let y = 0; y < stride; y += 1) for (let x = 0; x < stride; x += 1) {
      const noise = pass % 3 === 0 ? Math.round(random() * 40) : pass % 3 === 1 ? Math.round(random() * 3) : 0;
      surface[y * stride + x] = base + x * (pass % 5) + y * ((pass + 2) % 7) + noise;
      distances[y * stride + x] = pass % 3 === 2 ? Math.floor(random() * 10000) : NO_DISTANCE;
    }
    const expected = legacy(size, 3, 1, 1, surface, distances);
    const actual = materializeGlobalReceivers(size, 3, 1, 1, surface, distances);
    for (let different = 0; different < actual.length; different += 1) if (actual[different] !== expected[different]) {
      differenceCount += 1;
      const actualSlope = selectedSlope(actual[different], different, size, 3, surface, distances);
      const expectedSlope = selectedSlope(expected[different], different, size, 3, surface, distances);
      maximumSlopeDifference = Math.max(maximumSlopeDifference, Math.abs(actualSlope - expectedSlope));
      expect(actualSlope).toBeCloseTo(expectedSlope, 10);
      if (examples.length < 10) examples.push(`pass=${pass} cell=${different} actual=${actual[different]} expected=${expected[different]}`);
    }
  }
  expect(differenceCount, examples.join('\n')).toBeLessThan(100);
  expect(maximumSlopeDifference).toBeLessThan(1e-10);
});
