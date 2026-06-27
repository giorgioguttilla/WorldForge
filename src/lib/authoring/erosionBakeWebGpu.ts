import { elevationToR16 } from './geometry';
import type { ErosionBakeSummaryV1, ErosionSettingsV1 } from './authoringDocument';
import { normalizeErosionSettings } from './authoringDocument';
import type { TileKey } from '../heightmap/tileKey';
import type { WorldConfig } from '../heightmap/worldConfig';
import { r16ToElevation } from '../heightmap/worldConfig';

export interface ErosionTileIO {
  readTile(key: TileKey): Promise<Uint16Array>;
  writeTile(key: TileKey, samples: Uint16Array): Promise<void>;
  readWaterMaskTile?(key: TileKey): Promise<Uint16Array | null>;
  writeWaterMaskTile?(key: TileKey, samples: Uint16Array): Promise<void>;
}

export interface ErosionProgress {
  phase: 'eroding';
  current: number;
  total: number;
  label: string;
}

export interface ErosionBakeResult {
  dirtyTiles: TileKey[];
  summary: ErosionBakeSummaryV1;
}

interface ChunkJob {
  x: number;
  y: number;
  width: number;
  height: number;
  readMinX: number;
  readMinY: number;
  readWidth: number;
  readHeight: number;
}

interface GpuErosionBake {
  erodeChunk(input: Float32Array, width: number, height: number, writeOffsetX: number, writeOffsetY: number, writeWidth: number, writeHeight: number): Promise<{ heights: Float32Array; waterMask: Uint16Array }>;
  destroy(): void;
}

interface ErosionDiagnostics {
  maxHeightDelta: number;
  totalAbsHeightDelta: number;
  sampleCount: number;
  maxWaterMask: number;
}

interface ErosionUniforms {
  width: number;
  height: number;
  pixelWorldSize: number;
  worldHeight: number;
  rainfall: number;
  evaporation: number;
  erosionStrength: number;
  depositionStrength: number;
  sedimentCapacity: number;
  hardness: number;
  thermalStrength: number;
  talus: number;
  waterMaskScale: number;
}

const WORKGROUP_SIZE = 8;

export function canUseWebGpuErosionBake(): boolean {
  return typeof navigator !== 'undefined' && Boolean(navigator.gpu);
}

export async function runWebGpuErosionBake(
  config: WorldConfig,
  settingsInput: ErosionSettingsV1,
  io: ErosionTileIO,
  onProgress?: (progress: ErosionProgress) => void
): Promise<ErosionBakeResult> {
  const settings = normalizeErosionSettings(settingsInput);
  if (!settings.enabled) {
    return {
      dirtyTiles: [],
      summary: createErosionSummary(settings, [])
    };
  }
  if (!canUseWebGpuErosionBake()) {
    throw new Error('Erosion bake requires WebGPU. Enable a WebGPU-capable browser/GPU to run the V1 erosion stage.');
  }

  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('No WebGPU adapter is available for erosion bake.');
  const device = await adapter.requestDevice();
  let gpuBake: GpuErosionBake;
  try {
    gpuBake = await createGpuErosionBake(device, config, settings);
  } catch (error) {
    device.destroy();
    throw error;
  }
  const warnings: string[] = [];
  const jobs = createChunkJobs(config, settings);
  const sourceTiles = new Map<string, Uint16Array>();
  const outputTiles = new Map<string, Uint16Array>();
  const outputMaskTiles = new Map<string, Uint16Array>();
  const diagnostics: ErosionDiagnostics = {
    maxHeightDelta: 0,
    totalAbsHeightDelta: 0,
    sampleCount: 0,
    maxWaterMask: 0
  };
  const dirtyTiles: TileKey[] = [];
  const total = jobs.length;
  let completed = 0;
  try {
    for (const job of jobs) {
      const source = await readChunkHeights(config, job, io, sourceTiles);
      const eroded = await gpuBake.erodeChunk(
        source,
        job.readWidth,
        job.readHeight,
        job.x - job.readMinX,
        job.y - job.readMinY,
        job.width,
        job.height
      );
      accumulateDiagnostics(source, eroded.heights, eroded.waterMask, job, diagnostics);
      const encoded = encodeChunkHeights(config, eroded.heights, warnings);
      await writeChunkTiles(config, job, encoded, outputTiles, io.readTile, io.writeTile);
      if (settings.outputWaterMask && io.writeWaterMaskTile) {
        await writeChunkTiles(config, job, eroded.waterMask, outputMaskTiles, io.readWaterMaskTile ?? (async () => null), io.writeWaterMaskTile);
      }
      for (const key of chunkTileKeys(config, job)) dirtyTiles.push(key);
      pruneSourceTiles(sourceTiles, config, job, settings.overlap);
      pruneOutputTiles(outputTiles, config, job);
      pruneOutputTiles(outputMaskTiles, config, job);
      completed += 1;
      onProgress?.({ phase: 'eroding', current: completed, total, label: `Eroding ${settings.chunkSize}px chunks on WebGPU ${completed} / ${total}` });
    }
  } finally {
    gpuBake.destroy();
  }

  const meanAbsHeightDelta = diagnostics.sampleCount === 0 ? 0 : diagnostics.totalAbsHeightDelta / diagnostics.sampleCount;
  if (settings.hydraulicIterations + (settings.thermalEnabled ? settings.thermalIterations : 0) > 0 && diagnostics.maxHeightDelta < 0.01) {
    warnings.push('Erosion changed height by less than 0.01 world units; terrain may be too flat, too hard, or erosion settings may be too weak for this scale.');
  }

  return {
    dirtyTiles: dedupeTiles(dirtyTiles),
    summary: createErosionSummary(settings, [...new Set(warnings)], {
      maxHeightDelta: diagnostics.maxHeightDelta,
      meanAbsHeightDelta,
      maxWaterMask: diagnostics.maxWaterMask
    })
  };
}

export function estimateErosionBakeMemoryMb(settingsInput: ErosionSettingsV1): number {
  const settings = normalizeErosionSettings(settingsInput);
  const side = settings.chunkSize + settings.overlap * 2;
  const floatBuffers = 6;
  const readbackBuffers = 1;
  const tileCacheBudget = 96;
  return ((side * side * Float32Array.BYTES_PER_ELEMENT * (floatBuffers + readbackBuffers)) / 1024 / 1024) + tileCacheBudget;
}

async function createGpuErosionBake(device: GPUDevice, config: WorldConfig, settings: ErosionSettingsV1): Promise<GpuErosionBake> {
  const module = device.createShaderModule({ label: 'WorldForge erosion bake', code: createErosionShader() });
  const pipeline = await device.createComputePipelineAsync({
    label: 'WorldForge erosion bake pipeline',
    layout: 'auto',
    compute: { module, entryPoint: 'main' }
  });

  return {
    async erodeChunk(input, width, height, writeOffsetX, writeOffsetY, writeWidth, writeHeight) {
      const sampleCount = width * height;
      const outputCount = writeWidth * writeHeight;
      const uniforms: ErosionUniforms = {
        width,
        height,
        pixelWorldSize: config.unitSize,
        worldHeight: config.worldHeight,
        rainfall: settings.rainfall,
        evaporation: settings.evaporation,
        erosionStrength: settings.erosionStrength,
        depositionStrength: settings.depositionStrength,
        sedimentCapacity: settings.sedimentCapacity,
        hardness: settings.hardness,
        thermalStrength: settings.thermalStrength,
        talus: Math.tan((settings.talusAngleDegrees * Math.PI) / 180) * config.unitSize,
        waterMaskScale: settings.waterMaskScale
      };
      const buffers = createSimulationBuffers(device, input, sampleCount, outputCount);
      let heightReadbackMapped = false;
      let maskReadbackMapped = false;
      try {
        await runSimulationPasses(device, pipeline, buffers, width, height, settings, writeOffsetX, writeOffsetY, writeWidth, writeHeight, uniforms);
        await dispatchExportPass(device, pipeline, buffers, uniforms, 2, finalParity(settings), writeWidth, writeHeight, writeOffsetX, writeOffsetY, writeWidth, writeHeight);
        const encoder = device.createCommandEncoder();
        encoder.copyBufferToBuffer(buffers.outputValues, 0, buffers.valueReadback, 0, outputCount * Float32Array.BYTES_PER_ELEMENT);
        device.queue.submit([encoder.finish()]);

        await buffers.valueReadback.mapAsync(GPUMapMode.READ);
        heightReadbackMapped = true;
        const heights = new Float32Array(new Float32Array(buffers.valueReadback.getMappedRange()).slice());
        buffers.valueReadback.unmap();
        heightReadbackMapped = false;

        await dispatchExportPass(device, pipeline, buffers, uniforms, 3, finalParity(settings), writeWidth, writeHeight, writeOffsetX, writeOffsetY, writeWidth, writeHeight);
        const maskEncoder = device.createCommandEncoder();
        maskEncoder.copyBufferToBuffer(buffers.outputValues, 0, buffers.valueReadback, 0, outputCount * Float32Array.BYTES_PER_ELEMENT);
        device.queue.submit([maskEncoder.finish()]);

        await buffers.valueReadback.mapAsync(GPUMapMode.READ);
        maskReadbackMapped = true;
        const maskFloats = new Float32Array(buffers.valueReadback.getMappedRange());
        const waterMask = new Uint16Array(outputCount);
        for (let i = 0; i < outputCount; i += 1) waterMask[i] = Math.max(0, Math.min(65535, Math.round(maskFloats[i])));

        return { heights, waterMask };
      } finally {
        if (heightReadbackMapped || maskReadbackMapped) buffers.valueReadback.unmap();
        for (const buffer of Object.values(buffers)) buffer.destroy();
      }
    },
    destroy() {
      device.destroy();
    }
  };
}

function createSimulationBuffers(device: GPUDevice, input: Float32Array, sampleCount: number, outputCount: number) {
  const zeroFloats = new Float32Array(sampleCount);
  const outBytes = outputCount * Float32Array.BYTES_PER_ELEMENT;
  return {
    heightA: createBuffer(device, input, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
    heightB: createBuffer(device, input, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
    waterA: createBuffer(device, zeroFloats, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
    waterB: createBuffer(device, zeroFloats, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
    sedimentA: createBuffer(device, zeroFloats, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
    sedimentB: createBuffer(device, zeroFloats, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
    flowAccum: createBuffer(device, zeroFloats, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
    outputValues: device.createBuffer({ size: outBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }),
    valueReadback: device.createBuffer({ size: outBytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
  };
}

async function runSimulationPasses(
  device: GPUDevice,
  pipeline: GPUComputePipeline,
  buffers: ReturnType<typeof createSimulationBuffers>,
  width: number,
  height: number,
  settings: ErosionSettingsV1,
  writeOffsetX: number,
  writeOffsetY: number,
  writeWidth: number,
  writeHeight: number,
  uniforms: ErosionUniforms
): Promise<void> {
  const encoder = device.createCommandEncoder();
  const passBuffers: GPUBuffer[] = [];
  for (let iteration = 0; iteration < settings.hydraulicIterations; iteration += 1) {
    encodePass(device, encoder, pipeline, buffers, passBuffers, uniforms, 0, iteration % 2, width, height, writeOffsetX, writeOffsetY, writeWidth, writeHeight);
  }
  const hydraulicParity = settings.hydraulicIterations % 2;
  if (settings.thermalEnabled) {
    for (let iteration = 0; iteration < settings.thermalIterations; iteration += 1) {
      encodePass(device, encoder, pipeline, buffers, passBuffers, uniforms, 1, (hydraulicParity + iteration) % 2, width, height, writeOffsetX, writeOffsetY, writeWidth, writeHeight);
    }
  }
  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();
  for (const buffer of passBuffers) buffer.destroy();
}

function encodePass(
  device: GPUDevice,
  encoder: GPUCommandEncoder,
  pipeline: GPUComputePipeline,
  buffers: ReturnType<typeof createSimulationBuffers>,
  passBuffers: GPUBuffer[],
  uniforms: ErosionUniforms,
  passType: number,
  parity: number,
  dispatchWidth: number,
  dispatchHeight: number,
  writeOffsetX: number,
  writeOffsetY: number,
  writeWidth: number,
  writeHeight: number
): void {
  const params = createBuffer(device, packUniforms(uniforms, passType, parity, writeOffsetX, writeOffsetY, writeWidth, writeHeight), GPUBufferUsage.UNIFORM);
  passBuffers.push(params);
  const bindGroup = device.createBindGroup({
    label: 'WorldForge erosion bake pass bind group',
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: params } },
      { binding: 1, resource: { buffer: buffers.heightA } },
      { binding: 2, resource: { buffer: buffers.heightB } },
      { binding: 3, resource: { buffer: buffers.waterA } },
      { binding: 4, resource: { buffer: buffers.waterB } },
      { binding: 5, resource: { buffer: buffers.sedimentA } },
      { binding: 6, resource: { buffer: buffers.sedimentB } },
      { binding: 7, resource: { buffer: buffers.flowAccum } },
      { binding: 8, resource: { buffer: buffers.outputValues } }
    ]
  });
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(Math.ceil(dispatchWidth / WORKGROUP_SIZE), Math.ceil(dispatchHeight / WORKGROUP_SIZE));
  pass.end();
}

function finalParity(settings: ErosionSettingsV1): number {
  const hydraulicParity = settings.hydraulicIterations % 2;
  return settings.thermalEnabled ? (hydraulicParity + settings.thermalIterations) % 2 : hydraulicParity;
}

async function dispatchExportPass(
  device: GPUDevice,
  pipeline: GPUComputePipeline,
  buffers: ReturnType<typeof createSimulationBuffers>,
  uniforms: ErosionUniforms,
  passType: number,
  parity: number,
  dispatchWidth: number,
  dispatchHeight: number,
  writeOffsetX: number,
  writeOffsetY: number,
  writeWidth: number,
  writeHeight: number
): Promise<void> {
  const encoder = device.createCommandEncoder();
  const passBuffers: GPUBuffer[] = [];
  encodePass(device, encoder, pipeline, buffers, passBuffers, uniforms, passType, parity, dispatchWidth, dispatchHeight, writeOffsetX, writeOffsetY, writeWidth, writeHeight);
  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();
  for (const buffer of passBuffers) buffer.destroy();
}

function createChunkJobs(config: WorldConfig, settingsInput: ErosionSettingsV1): ChunkJob[] {
  const settings = normalizeErosionSettings(settingsInput);
  const fullSize = config.tileSize * config.tilesPerSide;
  const chunkSize = Math.max(1, settings.chunkSize);
  const jobs: ChunkJob[] = [];
  for (let y = 0; y < fullSize; y += chunkSize) {
    for (let x = 0; x < fullSize; x += chunkSize) {
      const width = Math.min(chunkSize, fullSize - x);
      const height = Math.min(chunkSize, fullSize - y);
      const readMinX = Math.max(0, x - settings.overlap);
      const readMinY = Math.max(0, y - settings.overlap);
      const readMaxX = Math.min(fullSize, x + width + settings.overlap);
      const readMaxY = Math.min(fullSize, y + height + settings.overlap);
      jobs.push({
        x,
        y,
        width,
        height,
        readMinX,
        readMinY,
        readWidth: readMaxX - readMinX,
        readHeight: readMaxY - readMinY
      });
    }
  }
  return jobs;
}

async function readChunkHeights(config: WorldConfig, job: ChunkJob, io: ErosionTileIO, sourceTiles: Map<string, Uint16Array>): Promise<Float32Array> {
  const samples = new Float32Array(job.readWidth * job.readHeight);
  const tiles = await readSourceTiles(config, job, io, sourceTiles);
  for (let localY = 0; localY < job.readHeight; localY += 1) {
    const globalY = job.readMinY + localY;
    const tileY = Math.floor(globalY / config.tileSize);
    const sampleY = globalY - tileY * config.tileSize;
    for (let localX = 0; localX < job.readWidth; localX += 1) {
      const globalX = job.readMinX + localX;
      const tileX = Math.floor(globalX / config.tileSize);
      const sampleX = globalX - tileX * config.tileSize;
      const tile = tiles.get(`${tileX},${tileY}`);
      if (!tile) throw new Error(`Missing source tile ${tileX},${tileY} for erosion.`);
      samples[localY * job.readWidth + localX] = r16ToElevation(tile[sampleY * config.tileSize + sampleX], config.worldHeight);
    }
  }
  return samples;
}

async function readSourceTiles(config: WorldConfig, job: ChunkJob, io: ErosionTileIO, sourceTiles: Map<string, Uint16Array>): Promise<Map<string, Uint16Array>> {
  const minTileX = Math.floor(job.readMinX / config.tileSize);
  const minTileY = Math.floor(job.readMinY / config.tileSize);
  const maxTileX = Math.floor((job.readMinX + job.readWidth - 1) / config.tileSize);
  const maxTileY = Math.floor((job.readMinY + job.readHeight - 1) / config.tileSize);
  const tiles = new Map<string, Uint16Array>();
  for (let y = minTileY; y <= maxTileY; y += 1) {
    for (let x = minTileX; x <= maxTileX; x += 1) {
      const id = `${x},${y}`;
      let tile = sourceTiles.get(id);
      if (!tile) {
        tile = new Uint16Array(await io.readTile({ x, y, d: 0 }));
        sourceTiles.set(id, tile);
      }
      tiles.set(id, tile);
    }
  }
  return tiles;
}

function encodeChunkHeights(config: WorldConfig, heights: Float32Array, warnings: string[]): Uint16Array {
  const encoded = new Uint16Array(heights.length);
  let underflow = false;
  let overflow = false;
  let invalid = false;
  for (let i = 0; i < heights.length; i += 1) {
    const height = heights[i];
    if (!Number.isFinite(height)) {
      invalid = true;
      encoded[i] = 0;
      continue;
    }
    if (height < 0) underflow = true;
    if (height > config.worldHeight) overflow = true;
    encoded[i] = elevationToR16(height, config.worldHeight);
  }
  if (invalid) warnings.push('Erosion produced non-finite heights; invalid samples were clamped to 0.');
  if (underflow) warnings.push('Erosion produced heights below 0; output was clamped to the current height range.');
  if (overflow) warnings.push('Erosion produced heights above worldHeight; output was clamped to the current height range.');
  return encoded;
}

async function writeChunkTiles(
  config: WorldConfig,
  job: ChunkJob,
  chunkSamples: Uint16Array,
  outputTiles: Map<string, Uint16Array>,
  readTile: (key: TileKey) => Promise<Uint16Array | null>,
  writeTile: (key: TileKey, samples: Uint16Array) => Promise<void>
): Promise<void> {
  for (const key of chunkTileKeys(config, job)) {
    const id = `${key.x},${key.y}`;
    let tile = outputTiles.get(id);
    if (!tile) {
      tile = (await readTile(key)) ?? new Uint16Array(config.tileSize * config.tileSize);
      tile = new Uint16Array(tile);
      outputTiles.set(id, tile);
    }
    for (let sampleY = 0; sampleY < config.tileSize; sampleY += 1) {
      const globalY = key.y * config.tileSize + sampleY;
      if (globalY < job.y || globalY >= job.y + job.height) continue;
      for (let sampleX = 0; sampleX < config.tileSize; sampleX += 1) {
        const globalX = key.x * config.tileSize + sampleX;
        if (globalX < job.x || globalX >= job.x + job.width) continue;
        const chunkX = globalX - job.x;
        const chunkY = globalY - job.y;
        tile[sampleY * config.tileSize + sampleX] = chunkSamples[chunkY * job.width + chunkX];
      }
    }
    await writeTile(key, tile);
  }
}

function chunkTileKeys(config: WorldConfig, job: ChunkJob): TileKey[] {
  const minTileX = Math.floor(job.x / config.tileSize);
  const minTileY = Math.floor(job.y / config.tileSize);
  const maxTileX = Math.floor((job.x + job.width - 1) / config.tileSize);
  const maxTileY = Math.floor((job.y + job.height - 1) / config.tileSize);
  const keys: TileKey[] = [];
  for (let y = minTileY; y <= maxTileY; y += 1) {
    for (let x = minTileX; x <= maxTileX; x += 1) keys.push({ x, y, d: 0 });
  }
  return keys;
}

function dedupeTiles(tiles: TileKey[]): TileKey[] {
  const unique = new Map<string, TileKey>();
  for (const tile of tiles) unique.set(`${tile.d}/${tile.y}/${tile.x}`, tile);
  return [...unique.values()].sort((a, b) => a.d - b.d || a.y - b.y || a.x - b.x);
}

function createErosionSummary(settings: ErosionSettingsV1, warnings: string[], diagnostics?: { maxHeightDelta: number; meanAbsHeightDelta: number; maxWaterMask: number }): ErosionBakeSummaryV1 {
  return {
    enabled: settings.enabled,
    preset: settings.preset,
    hydraulicIterations: settings.hydraulicIterations,
    thermalIterations: settings.thermalEnabled ? settings.thermalIterations : 0,
    chunkSize: settings.chunkSize,
    overlap: settings.overlap,
    waterMask: 'accumulated-water-influence',
    ...(diagnostics ? {
      maxHeightDelta: diagnostics.maxHeightDelta,
      meanAbsHeightDelta: diagnostics.meanAbsHeightDelta,
      maxWaterMask: diagnostics.maxWaterMask
    } : {}),
    warnings
  };
}

function accumulateDiagnostics(source: Float32Array, heights: Float32Array, waterMask: Uint16Array, job: ChunkJob, diagnostics: ErosionDiagnostics): void {
  const sourceOffsetX = job.x - job.readMinX;
  const sourceOffsetY = job.y - job.readMinY;
  for (let y = 0; y < job.height; y += 1) {
    for (let x = 0; x < job.width; x += 1) {
      const outIndex = y * job.width + x;
      const sourceIndex = (sourceOffsetY + y) * job.readWidth + sourceOffsetX + x;
      const delta = Math.abs(heights[outIndex] - source[sourceIndex]);
      diagnostics.maxHeightDelta = Math.max(diagnostics.maxHeightDelta, delta);
      diagnostics.totalAbsHeightDelta += delta;
      diagnostics.sampleCount += 1;
      diagnostics.maxWaterMask = Math.max(diagnostics.maxWaterMask, waterMask[outIndex]);
    }
  }
}

function pruneSourceTiles(sourceTiles: Map<string, Uint16Array>, config: WorldConfig, job: ChunkJob, overlap: number): void {
  const safeBeforeY = job.y - overlap;
  for (const id of sourceTiles.keys()) {
    const tileY = Number(id.split(',')[1]);
    const tileMaxY = (tileY + 1) * config.tileSize - 1;
    if (tileMaxY < safeBeforeY) sourceTiles.delete(id);
  }
}

function pruneOutputTiles(outputTiles: Map<string, Uint16Array>, config: WorldConfig, job: ChunkJob): void {
  for (const id of outputTiles.keys()) {
    const tileY = Number(id.split(',')[1]);
    const tileMaxY = (tileY + 1) * config.tileSize - 1;
    if (tileMaxY < job.y) outputTiles.delete(id);
  }
}

function createBuffer(device: GPUDevice, values: Float32Array | Uint32Array, usage: GPUBufferUsageFlags): GPUBuffer {
  const buffer = device.createBuffer({
    size: alignTo(values.byteLength, 4),
    usage,
    mappedAtCreation: true
  });
  if (values instanceof Float32Array) {
    new Float32Array(buffer.getMappedRange()).set(values);
  } else {
    new Uint32Array(buffer.getMappedRange()).set(values);
  }
  buffer.unmap();
  return buffer;
}

function packUniforms(uniforms: ErosionUniforms, passType: number, parity: number, writeOffsetX: number, writeOffsetY: number, writeWidth: number, writeHeight: number): Float32Array {
  return new Float32Array([
    uniforms.width, uniforms.height, uniforms.pixelWorldSize, uniforms.worldHeight,
    uniforms.rainfall, uniforms.evaporation, uniforms.erosionStrength, uniforms.depositionStrength,
    uniforms.sedimentCapacity, uniforms.hardness, uniforms.thermalStrength, uniforms.talus,
    uniforms.waterMaskScale, passType, parity, writeOffsetX,
    writeOffsetY, writeWidth, writeHeight, 0
  ]);
}

function alignTo(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

function createErosionShader(): string {
  return /* wgsl */`
struct Params {
  width: f32,
  height: f32,
  pixelWorldSize: f32,
  worldHeight: f32,
  rainfall: f32,
  evaporation: f32,
  erosionStrength: f32,
  depositionStrength: f32,
  sedimentCapacity: f32,
  hardness: f32,
  thermalStrength: f32,
  talus: f32,
  waterMaskScale: f32,
  passType: f32,
  parity: f32,
  writeOffsetX: f32,
  writeOffsetY: f32,
  writeWidth: f32,
  writeHeight: f32,
  _pad: f32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> heightA: array<f32>;
@group(0) @binding(2) var<storage, read_write> heightB: array<f32>;
@group(0) @binding(3) var<storage, read_write> waterA: array<f32>;
@group(0) @binding(4) var<storage, read_write> waterB: array<f32>;
@group(0) @binding(5) var<storage, read_write> sedimentA: array<f32>;
@group(0) @binding(6) var<storage, read_write> sedimentB: array<f32>;
@group(0) @binding(7) var<storage, read_write> flowAccum: array<f32>;
@group(0) @binding(8) var<storage, read_write> outputValues: array<f32>;

fn p(i: u32) -> f32 {
  switch (i) {
    case 0u: { return params.width; }
    case 1u: { return params.height; }
    case 2u: { return params.pixelWorldSize; }
    case 3u: { return params.worldHeight; }
    case 4u: { return params.rainfall; }
    case 5u: { return params.evaporation; }
    case 6u: { return params.erosionStrength; }
    case 7u: { return params.depositionStrength; }
    case 8u: { return params.sedimentCapacity; }
    case 9u: { return params.hardness; }
    case 10u: { return params.thermalStrength; }
    case 11u: { return params.talus; }
    case 12u: { return params.waterMaskScale; }
    case 13u: { return params.passType; }
    case 14u: { return params.parity; }
    case 15u: { return params.writeOffsetX; }
    case 16u: { return params.writeOffsetY; }
    case 17u: { return params.writeWidth; }
    case 18u: { return params.writeHeight; }
    default: { return 0.0; }
  }
}
fn widthI() -> i32 { return i32(p(0)); }
fn heightI() -> i32 { return i32(p(1)); }
fn idx(x: i32, y: i32) -> u32 { return u32(y * widthI() + x); }
fn inside(x: i32, y: i32) -> bool { return x >= 0 && y >= 0 && x < widthI() && y < heightI(); }
fn surfaceAt(x: i32, y: i32, fallback: f32) -> f32 {
  if (!inside(x, y)) { return fallback; }
  let i = idx(x, y);
  return hRead(i) + wRead(i);
}

fn hRead(i: u32) -> f32 {
  if (i32(p(14)) == 0) { return heightA[i]; }
  return heightB[i];
}

fn wRead(i: u32) -> f32 {
  if (i32(p(14)) == 0) { return waterA[i]; }
  return waterB[i];
}

fn sRead(i: u32) -> f32 {
  if (i32(p(14)) == 0) { return sedimentA[i]; }
  return sedimentB[i];
}

fn hWrite(i: u32, v: f32) {
  if (i32(p(14)) == 0) { heightB[i] = v; } else { heightA[i] = v; }
}

fn wWrite(i: u32, v: f32) {
  if (i32(p(14)) == 0) { waterB[i] = v; } else { waterA[i] = v; }
}

fn sWrite(i: u32, v: f32) {
  if (i32(p(14)) == 0) { sedimentB[i] = v; } else { sedimentA[i] = v; }
}

fn outAmount(fromX: i32, fromY: i32, toX: i32, toY: i32) -> f32 {
  if (!inside(fromX, fromY) || !inside(toX, toY)) { return 0.0; }
  let source = idx(fromX, fromY);
  let to = idx(toX, toY);
  let surface = hRead(source) + wRead(source);
  let d0 = max(0.0, surface - surfaceAt(fromX - 1, fromY, surface));
  let d1 = max(0.0, surface - surfaceAt(fromX + 1, fromY, surface));
  let d2 = max(0.0, surface - surfaceAt(fromX, fromY - 1, surface));
  let d3 = max(0.0, surface - surfaceAt(fromX, fromY + 1, surface));
  let total = d0 + d1 + d2 + d3;
  if (total <= 0.000001) { return 0.0; }
  let descent = max(0.0, surface - (hRead(to) + wRead(to)));
  let movable = min(wRead(source), total * 0.48);
  return movable * descent / total;
}

fn sedimentOutAmount(fromX: i32, fromY: i32, toX: i32, toY: i32) -> f32 {
  if (!inside(fromX, fromY) || !inside(toX, toY)) { return 0.0; }
  let water = max(0.000001, wRead(idx(fromX, fromY)));
  let sediment = sRead(idx(fromX, fromY));
  return sediment * min(1.0, outAmount(fromX, fromY, toX, toY) / water);
}

fn thermalGive(fromX: i32, fromY: i32, toX: i32, toY: i32) -> f32 {
  if (!inside(fromX, fromY) || !inside(toX, toY)) { return 0.0; }
  let source = idx(fromX, fromY);
  let to = idx(toX, toY);
  let slope = hRead(source) - hRead(to);
  if (slope <= p(11)) { return 0.0; }
  return (slope - p(11)) * p(10) * 0.125;
}

@compute @workgroup_size(${WORKGROUP_SIZE}, ${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let x = i32(gid.x);
  let y = i32(gid.y);
  let passType = i32(p(13));

  if (passType == 2 || passType == 3) {
    if (x >= i32(p(17)) || y >= i32(p(18))) { return; }
    let srcX = x + i32(p(15));
    let srcY = y + i32(p(16));
    let source = idx(srcX, srcY);
    let out = u32(y * i32(p(17)) + x);
    if (passType == 2) {
      outputValues[out] = clamp(hRead(source), 0.0, p(3));
      return;
    }
    let influence = max(0.0, flowAccum[source]);
    let normalized = 1.0 - exp(-influence / max(0.0001, p(12)));
    outputValues[out] = round(clamp(normalized, 0.0, 1.0) * 65535.0);
    return;
  }

  if (!inside(x, y)) { return; }
  let i = idx(x, y);

  if (passType == 1) {
    let outgoing = thermalGive(x, y, x - 1, y) + thermalGive(x, y, x + 1, y) + thermalGive(x, y, x, y - 1) + thermalGive(x, y, x, y + 1);
    let incoming = thermalGive(x - 1, y, x, y) + thermalGive(x + 1, y, x, y) + thermalGive(x, y - 1, x, y) + thermalGive(x, y + 1, x, y);
    hWrite(i, clamp(hRead(i) + incoming - outgoing, 0.0, p(3)));
    wWrite(i, wRead(i));
    sWrite(i, sRead(i));
    return;
  }

  let rain = p(4) * p(2) * 0.05;
  let currentWater = wRead(i) + rain;
  let out0 = outAmount(x, y, x - 1, y);
  let out1 = outAmount(x, y, x + 1, y);
  let out2 = outAmount(x, y, x, y - 1);
  let out3 = outAmount(x, y, x, y + 1);
  let incomingWater = outAmount(x - 1, y, x, y) + outAmount(x + 1, y, x, y) + outAmount(x, y - 1, x, y) + outAmount(x, y + 1, x, y);
  let outgoingWater = out0 + out1 + out2 + out3;
  var nextWater = max(0.0, currentWater + incomingWater - outgoingWater);

  let incomingSediment = sedimentOutAmount(x - 1, y, x, y) + sedimentOutAmount(x + 1, y, x, y) + sedimentOutAmount(x, y - 1, x, y) + sedimentOutAmount(x, y + 1, x, y);
  let outgoingSediment = sedimentOutAmount(x, y, x - 1, y) + sedimentOutAmount(x, y, x + 1, y) + sedimentOutAmount(x, y, x, y - 1) + sedimentOutAmount(x, y, x, y + 1);
  var nextSediment = max(0.0, sRead(i) + incomingSediment - outgoingSediment);

  let centerHeight = hRead(i);
  let downhill0 = max(0.0, centerHeight - hRead(idx(max(0, x - 1), y)));
  let downhill1 = max(0.0, centerHeight - hRead(idx(min(widthI() - 1, x + 1), y)));
  let downhill2 = max(0.0, centerHeight - hRead(idx(x, max(0, y - 1))));
  let downhill3 = max(0.0, centerHeight - hRead(idx(x, min(heightI() - 1, y + 1))));
  let weightedDownhill = out0 * downhill0 + out1 * downhill1 + out2 * downhill2 + out3 * downhill3;
  let transportSlope = weightedDownhill / max(0.000001, outgoingWater);
  let transportEnergy = outgoingWater * max(0.0, transportSlope);
  let capacity = transportEnergy * nextWater * p(8) * (1.0 + transportSlope / max(0.001, p(2)));
  var nextHeight = hRead(i);
  if (outgoingWater > 0.00001 && transportSlope > 0.00001 && nextSediment < capacity) {
    let incision = transportSlope * outgoingWater * p(6) * (1.0 - p(9)) * 0.012;
    let erode = min(nextHeight, (capacity - nextSediment) * p(6) * (1.0 - p(9)) * 0.18 + incision);
    nextHeight -= erode;
    nextSediment += erode;
  } else {
    let lowEnergyDeposit = nextSediment * select(0.0, 0.12, outgoingWater <= 0.00001 || transportSlope <= 0.00001);
    let deposit = max(0.0, nextSediment - capacity) * p(7) * 0.22 + lowEnergyDeposit;
    nextHeight += deposit;
    nextSediment = max(0.0, nextSediment - deposit);
  }

  nextWater = max(0.0, nextWater * (1.0 - p(5) * 0.08));
  hWrite(i, clamp(nextHeight, 0.0, p(3)));
  wWrite(i, nextWater);
  sWrite(i, max(0.0, nextSediment));
  flowAccum[i] = flowAccum[i] + nextWater + outgoingWater + incomingWater;
}
`;
}
