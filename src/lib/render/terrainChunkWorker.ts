interface TilePayload {
  id: string;
  samples: ArrayBuffer;
}

interface BuildChunkRequest {
  type: 'build';
  requestId: number;
  config: {
    tileSize: number;
    tilesPerSide: number;
    unitSize: number;
    worldHeight: number;
  };
  key: {
    x: number;
    y: number;
    lod: number;
  };
  chunkSegments: number;
  tileDepth: number;
  sampleScale: number;
  lodSamplesPerSide: number;
  tiles: TilePayload[];
}

interface BuildChunkResponse {
  type: 'built';
  requestId: number;
  heights: ArrayBuffer;
  colors: ArrayBuffer;
  normals: ArrayBuffer;
  boundingRadius: number;
}

interface BuildChunkError {
  type: 'error';
  requestId: number;
  message: string;
}

const tileCache = new Map<string, Uint16Array>();

const TOPO_LOW = { r: 0x17 / 255, g: 0x38 / 255, b: 0x24 / 255 };
const TOPO_MID = { r: 0x5a / 255, g: 0xa3 / 255, b: 0x6e / 255 };
const TOPO_HIGH = { r: 0xe4 / 255, g: 0xf6 / 255, b: 0xbc / 255 };

self.onmessage = (event: MessageEvent<BuildChunkRequest>): void => {
  const message = event.data;
  if (message.type !== 'build') return;

  try {
    for (const tile of message.tiles) {
      tileCache.set(tile.id, new Uint16Array(tile.samples));
    }

    const response = buildChunk(message);
    self.postMessage(response, [response.heights, response.colors, response.normals]);
  } catch (error) {
    const response: BuildChunkError = {
      type: 'error',
      requestId: message.requestId,
      message: error instanceof Error ? error.message : String(error)
    };
    self.postMessage(response);
  }
};

function buildChunk(request: BuildChunkRequest): BuildChunkResponse {
  const { chunkSegments, config, key, lodSamplesPerSide, sampleScale, tileDepth } = request;
  const verticesPerSide = chunkSegments + 1;
  const vertexCount = verticesPerSide * verticesPerSide;
  const heights = new Float32Array(vertexCount);
  const colors = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const halfChunk = (chunkSegments * config.unitSize) / 2;
  let maxRadiusSq = 0;

  for (let y = 0; y < verticesPerSide; y += 1) {
    const localZ = y * config.unitSize - halfChunk;
    for (let x = 0; x < verticesPerSide; x += 1) {
      const localX = x * config.unitSize - halfChunk;
      const index = y * verticesPerSide + x;
      const chunkSampleX = localX / config.unitSize + chunkSegments / 2;
      const chunkSampleY = localZ / config.unitSize + chunkSegments / 2;
      const fullSampleX = (key.x * chunkSegments + chunkSampleX) * 2 ** key.lod;
      const fullSampleY = (key.y * chunkSegments + chunkSampleY) * 2 ** key.lod;
      const rawHeight = sampleRawHeight(config.tileSize, config.tilesPerSide, fullSampleX, fullSampleY, {
        lodSamplesPerSide,
        sampleScale,
        tileDepth
      });
      const height = (rawHeight / 65535) * config.worldHeight;
      heights[index] = height;
      setTopoColor(colors, index, rawHeight / 65535);
      maxRadiusSq = Math.max(maxRadiusSq, localX * localX + height * height + localZ * localZ);
    }
  }

  writeNormals(request, normals, verticesPerSide);

  return {
    type: 'built',
    requestId: request.requestId,
    heights: heights.buffer,
    colors: colors.buffer,
    normals: normals.buffer,
    boundingRadius: Math.sqrt(maxRadiusSq)
  };
}

function sampleRawHeight(
  tileSize: number,
  tilesPerSideAtDepthZero: number,
  fullSampleX: number,
  fullSampleY: number,
  context: { tileDepth: number; sampleScale: number; lodSamplesPerSide: number }
): number {
  const x = clamp(fullSampleX / context.sampleScale, 0, context.lodSamplesPerSide - 1);
  const y = clamp(fullSampleY / context.sampleScale, 0, context.lodSamplesPerSide - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(context.lodSamplesPerSide - 1, x0 + 1);
  const y1 = Math.min(context.lodSamplesPerSide - 1, y0 + 1);
  const tx = x - x0;
  const ty = y - y0;
  const h00 = sampleRawHeightAtLod(tileSize, tilesPerSideAtDepthZero, context.tileDepth, x0, y0);
  const h10 = sampleRawHeightAtLod(tileSize, tilesPerSideAtDepthZero, context.tileDepth, x1, y0);
  const h01 = sampleRawHeightAtLod(tileSize, tilesPerSideAtDepthZero, context.tileDepth, x0, y1);
  const h11 = sampleRawHeightAtLod(tileSize, tilesPerSideAtDepthZero, context.tileDepth, x1, y1);
  const top = h00 + (h10 - h00) * tx;
  const bottom = h01 + (h11 - h01) * tx;
  return top + (bottom - top) * ty;
}

function sampleRawHeightAtLod(tileSize: number, tilesPerSideAtDepthZero: number, tileDepth: number, sampleX: number, sampleY: number): number {
  const tilesPerSide = tilesPerSideAtDepthZero / 2 ** tileDepth;
  const tileX = Math.min(tilesPerSide - 1, Math.floor(sampleX / tileSize));
  const tileY = Math.min(tilesPerSide - 1, Math.floor(sampleY / tileSize));
  const localX = Math.min(tileSize - 1, sampleX - tileX * tileSize);
  const localY = Math.min(tileSize - 1, sampleY - tileY * tileSize);
  const samples = tileCache.get(`${tileDepth}:${tileX}:${tileY}`);
  if (!samples) throw new Error(`Missing worker tile ${tileDepth}:${tileX}:${tileY}.`);
  return samples[localY * tileSize + localX];
}

function writeNormals(request: BuildChunkRequest, normals: Float32Array, verticesPerSide: number): void {
  const { chunkSegments, config, key, lodSamplesPerSide, sampleScale, tileDepth } = request;
  const halfChunk = (chunkSegments * config.unitSize) / 2;
  const fullSampleStep = 2 ** key.lod;
  const sampleContext = { lodSamplesPerSide, sampleScale, tileDepth };

  for (let y = 0; y < verticesPerSide; y += 1) {
    const localZ = y * config.unitSize - halfChunk;
    for (let x = 0; x < verticesPerSide; x += 1) {
      const localX = x * config.unitSize - halfChunk;
      const index = y * verticesPerSide + x;
      const chunkSampleX = localX / config.unitSize + chunkSegments / 2;
      const chunkSampleY = localZ / config.unitSize + chunkSegments / 2;
      const fullSampleX = (key.x * chunkSegments + chunkSampleX) * fullSampleStep;
      const fullSampleY = (key.y * chunkSegments + chunkSampleY) * fullSampleStep;
      const left = rawToElevation(sampleRawHeight(config.tileSize, config.tilesPerSide, fullSampleX - fullSampleStep, fullSampleY, sampleContext), config.worldHeight);
      const right = rawToElevation(sampleRawHeight(config.tileSize, config.tilesPerSide, fullSampleX + fullSampleStep, fullSampleY, sampleContext), config.worldHeight);
      const up = rawToElevation(sampleRawHeight(config.tileSize, config.tilesPerSide, fullSampleX, fullSampleY - fullSampleStep, sampleContext), config.worldHeight);
      const down = rawToElevation(sampleRawHeight(config.tileSize, config.tilesPerSide, fullSampleX, fullSampleY + fullSampleStep, sampleContext), config.worldHeight);
      const nx = left - right;
      const ny = config.unitSize * 2;
      const nz = up - down;
      const length = Math.hypot(nx, ny, nz) || 1;
      normals[index * 3] = nx / length;
      normals[index * 3 + 1] = ny / length;
      normals[index * 3 + 2] = nz / length;
    }
  }
}

function rawToElevation(rawHeight: number, worldHeight: number): number {
  return (rawHeight / 65535) * worldHeight;
}

function setTopoColor(colors: Float32Array, index: number, height01: number): void {
  const t = clamp(height01, 0, 1);
  const color = t < 0.62 ? lerpColor(TOPO_LOW, TOPO_MID, t / 0.62) : lerpColor(TOPO_MID, TOPO_HIGH, (t - 0.62) / 0.38);
  colors[index * 3] = color.r;
  colors[index * 3 + 1] = color.g;
  colors[index * 3 + 2] = color.b;
}

function lerpColor(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }, t: number): { r: number; g: number; b: number } {
  return {
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
