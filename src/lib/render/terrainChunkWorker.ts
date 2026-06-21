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

const tileCacheByNumber = new Map<number, Uint16Array>();

const TOPO_LOW = { r: 0x17 / 255, g: 0x38 / 255, b: 0x24 / 255 };
const TOPO_MID = { r: 0x5a / 255, g: 0xa3 / 255, b: 0x6e / 255 };
const TOPO_HIGH = { r: 0xe4 / 255, g: 0xf6 / 255, b: 0xbc / 255 };
const R16_TO_UNIT = 1 / 65535;

interface SampleContext {
  tileSize: number;
  tilesPerSideAtDepthZero: number;
  tileDepth: number;
  sampleScale: number;
  lodSamplesPerSide: number;
  maxLodSample: number;
  tilesPerSideAtDepth: number;
}

self.onmessage = (event: MessageEvent<BuildChunkRequest>): void => {
  const message = event.data;
  if (message.type !== 'build') return;

  try {
    for (const tile of message.tiles) {
      const samples = new Uint16Array(tile.samples);
      tileCacheByNumber.set(tileIdToNumber(tile.id), samples);
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
  const fullSampleStep = 2 ** key.lod;
  const sampleOriginX = key.x * chunkSegments * fullSampleStep;
  const sampleOriginY = key.y * chunkSegments * fullSampleStep;
  const heightScale = config.worldHeight * R16_TO_UNIT;
  const sampleContext = makeSampleContext(config.tileSize, config.tilesPerSide, tileDepth, sampleScale, lodSamplesPerSide);
  let maxRadiusSq = 0;

  for (let y = 0; y < verticesPerSide; y += 1) {
    const localZ = y * config.unitSize - halfChunk;
    const fullSampleY = sampleOriginY + y * fullSampleStep;
    const rowOffset = y * verticesPerSide;
    for (let x = 0; x < verticesPerSide; x += 1) {
      const localX = x * config.unitSize - halfChunk;
      const index = rowOffset + x;
      const fullSampleX = sampleOriginX + x * fullSampleStep;
      const rawHeight = sampleRawHeight(fullSampleX, fullSampleY, sampleContext);
      const height = rawHeight * heightScale;
      heights[index] = height;
      setTopoColor(colors, index, rawHeight * R16_TO_UNIT);
      const radiusSq = localX * localX + height * height + localZ * localZ;
      if (radiusSq > maxRadiusSq) maxRadiusSq = radiusSq;
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

function makeSampleContext(tileSize: number, tilesPerSideAtDepthZero: number, tileDepth: number, sampleScale: number, lodSamplesPerSide: number): SampleContext {
  return {
    tileSize,
    tilesPerSideAtDepthZero,
    tileDepth,
    sampleScale,
    lodSamplesPerSide,
    maxLodSample: lodSamplesPerSide - 1,
    tilesPerSideAtDepth: tilesPerSideAtDepthZero / 2 ** tileDepth
  };
}

function sampleRawHeight(fullSampleX: number, fullSampleY: number, context: SampleContext): number {
  const x = clamp(fullSampleX / context.sampleScale, 0, context.maxLodSample);
  const y = clamp(fullSampleY / context.sampleScale, 0, context.maxLodSample);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = x0 < context.maxLodSample ? x0 + 1 : x0;
  const y1 = y0 < context.maxLodSample ? y0 + 1 : y0;
  const tx = x - x0;
  const ty = y - y0;
  const h00 = sampleRawHeightAtLod(context, x0, y0);
  const h10 = sampleRawHeightAtLod(context, x1, y0);
  const h01 = sampleRawHeightAtLod(context, x0, y1);
  const h11 = sampleRawHeightAtLod(context, x1, y1);
  const top = h00 + (h10 - h00) * tx;
  const bottom = h01 + (h11 - h01) * tx;
  return top + (bottom - top) * ty;
}

function sampleRawHeightAtLod(context: SampleContext, sampleX: number, sampleY: number): number {
  const tileX = Math.min(context.tilesPerSideAtDepth - 1, Math.floor(sampleX / context.tileSize));
  const tileY = Math.min(context.tilesPerSideAtDepth - 1, Math.floor(sampleY / context.tileSize));
  const localX = Math.min(context.tileSize - 1, sampleX - tileX * context.tileSize);
  const localY = Math.min(context.tileSize - 1, sampleY - tileY * context.tileSize);
  const samples = tileCacheByNumber.get(tileKeyToNumber(context.tileDepth, tileX, tileY));
  if (!samples) throw new Error(`Missing worker tile ${context.tileDepth}:${tileX}:${tileY}.`);
  return samples[localY * context.tileSize + localX];
}

function tileIdToNumber(id: string): number {
  const [depth, x, y] = id.split(':').map(Number);
  return tileKeyToNumber(depth, x, y);
}

function tileKeyToNumber(depth: number, x: number, y: number): number {
  return depth * 1073741824 + y * 32768 + x;
}

function writeNormals(request: BuildChunkRequest, normals: Float32Array, verticesPerSide: number): void {
  const { chunkSegments, config, key, lodSamplesPerSide, sampleScale, tileDepth } = request;
  const halfChunk = (chunkSegments * config.unitSize) / 2;
  const fullSampleStep = 2 ** key.lod;
  const sampleOriginX = key.x * chunkSegments * fullSampleStep;
  const sampleOriginY = key.y * chunkSegments * fullSampleStep;
  const heightScale = config.worldHeight * R16_TO_UNIT;
  const sampleContext = makeSampleContext(config.tileSize, config.tilesPerSide, tileDepth, sampleScale, lodSamplesPerSide);
  const ny = config.unitSize * 2;

  for (let y = 0; y < verticesPerSide; y += 1) {
    const fullSampleY = sampleOriginY + y * fullSampleStep;
    const rowOffset = y * verticesPerSide;
    for (let x = 0; x < verticesPerSide; x += 1) {
      const index = rowOffset + x;
      const fullSampleX = sampleOriginX + x * fullSampleStep;
      const left = sampleRawHeight(fullSampleX - fullSampleStep, fullSampleY, sampleContext) * heightScale;
      const right = sampleRawHeight(fullSampleX + fullSampleStep, fullSampleY, sampleContext) * heightScale;
      const up = sampleRawHeight(fullSampleX, fullSampleY - fullSampleStep, sampleContext) * heightScale;
      const down = sampleRawHeight(fullSampleX, fullSampleY + fullSampleStep, sampleContext) * heightScale;
      const nx = left - right;
      const nz = up - down;
      const inverseLength = 1 / (Math.sqrt(nx * nx + ny * ny + nz * nz) || 1);
      const normalOffset = index * 3;
      normals[normalOffset] = nx * inverseLength;
      normals[normalOffset + 1] = ny * inverseLength;
      normals[normalOffset + 2] = nz * inverseLength;
    }
  }
}

function setTopoColor(colors: Float32Array, index: number, height01: number): void {
  const t = clamp(height01, 0, 1);
  const colorOffset = index * 3;
  if (t < 0.62) {
    const u = t / 0.62;
    colors[colorOffset] = TOPO_LOW.r + (TOPO_MID.r - TOPO_LOW.r) * u;
    colors[colorOffset + 1] = TOPO_LOW.g + (TOPO_MID.g - TOPO_LOW.g) * u;
    colors[colorOffset + 2] = TOPO_LOW.b + (TOPO_MID.b - TOPO_LOW.b) * u;
  } else {
    const u = (t - 0.62) / 0.38;
    colors[colorOffset] = TOPO_MID.r + (TOPO_HIGH.r - TOPO_MID.r) * u;
    colors[colorOffset + 1] = TOPO_MID.g + (TOPO_HIGH.g - TOPO_MID.g) * u;
    colors[colorOffset + 2] = TOPO_MID.b + (TOPO_HIGH.b - TOPO_MID.b) * u;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
