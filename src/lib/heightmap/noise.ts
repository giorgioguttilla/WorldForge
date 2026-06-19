function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed, 1442695041);
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function smoothstep(value: number): number {
  return value * value * (3 - 2 * value);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function valueNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const tx = smoothstep(x - xi);
  const ty = smoothstep(y - yi);

  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  return lerp(lerp(a, b, tx), lerp(c, d, tx), ty);
}

export function lowFrequencyHeight(x: number, y: number, seed = 42): number {
  let amplitude = 0.62;
  let frequency = 0.0032;
  let value = 0;
  let weight = 0;

  for (let octave = 0; octave < 5; octave += 1) {
    value += valueNoise(x * frequency, y * frequency, seed + octave * 101) * amplitude;
    weight += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }

  const normalized = value / weight;
  return Math.max(0, Math.min(1, normalized * 0.86 + 0.07));
}

export function generateNoiseTile(tileSize: number, tileX: number, tileY: number, seed = 42): Uint16Array {
  const samples = new Uint16Array(tileSize * tileSize);
  const originX = tileX * tileSize;
  const originY = tileY * tileSize;

  for (let y = 0; y < tileSize; y += 1) {
    for (let x = 0; x < tileSize; x += 1) {
      const height = lowFrequencyHeight(originX + x, originY + y, seed);
      samples[y * tileSize + x] = Math.round(height * 65535);
    }
  }

  return samples;
}
