import { compileNoiseFieldGraph } from '../noiseGraph';
import { validateNoiseGraph } from '../noiseGraph/graph';
import type { NoiseFieldGraphV1, NoiseGraphEdgeV1, NoiseGraphNodeV1 } from '../noiseGraph/types';
import type { WorldConfig } from '../heightmap/worldConfig';
import type { AuthoringDocumentV1 } from './authoringDocument';
import {
  prepareStructuralDocument,
  type PreparedStructuralDocument
} from './geometry';

interface PackedGpuDocument {
  landformCount: number;
  mountainCount: number;
  landform0: Float32Array;
  landform1: Float32Array;
  landform2: Float32Array;
  mountain0: Float32Array;
  mountain1: Float32Array;
  mountain2: Float32Array;
  points: Float32Array;
  segments: Float32Array;
  segmentBounds: Float32Array;
  fieldIds: string[];
}

interface GpuDepthZeroBake {
  bakeTile(tileX: number, tileY: number): Promise<Uint16Array>;
  destroy(): void;
}

interface GpuDocumentBuffers {
  landformCount: number;
  mountainCount: number;
  landform0: GPUBuffer;
  landform1: GPUBuffer;
  landform2: GPUBuffer;
  mountain0: GPUBuffer;
  mountain1: GPUBuffer;
  mountain2: GPUBuffer;
  points: GPUBuffer;
  segments: GPUBuffer;
  segmentBounds: GPUBuffer;
}

interface CompileState {
  graph: NoiseFieldGraphV1;
  nodes: Map<string, NoiseGraphNodeV1>;
  incoming: Map<string, NoiseGraphEdgeV1>;
  memo: Map<string, string>;
}

const WORKGROUP_SIZE = 8;

export function canUseWebGpuStructuralBake(): boolean {
  return typeof navigator !== 'undefined' && Boolean(navigator.gpu);
}

export async function tryCreateWebGpuDepthZeroBake(
  config: WorldConfig,
  document: AuthoringDocumentV1,
  waterLevel: number
): Promise<GpuDepthZeroBake | null> {
  if (!canUseWebGpuStructuralBake()) return null;
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) return null;
  if (adapter.limits.maxStorageBuffersPerShaderStage < 10) return null;
  const device = await adapter.requestDevice({
    requiredLimits: {
      maxStorageBuffersPerShaderStage: 10
    }
  });
  const prepared = prepareStructuralDocument(document);
  const packed = packPreparedDocument(prepared, waterLevel, config.worldHeight);
  const shader = createBakeShader(config, prepared.fieldLibrary);
  const module = device.createShaderModule({ label: 'WorldForge structural bake', code: shader });
  const pipeline = device.createComputePipeline({
    label: 'WorldForge structural bake pipeline',
    layout: 'auto',
    compute: { module, entryPoint: 'main' }
  });
  const buffers = createDocumentBuffers(device, packed);

  return {
    async bakeTile(tileX, tileY) {
      return bakeTileWithDevice(device, pipeline, buffers, config, tileX, tileY);
    },
    destroy() {
      for (const buffer of Object.values(buffers)) {
        if (typeof buffer === 'object') buffer.destroy();
      }
      device.destroy();
    }
  };
}

async function bakeTileWithDevice(
  device: GPUDevice,
  pipeline: GPUComputePipeline,
  documentBuffers: GpuDocumentBuffers,
  config: WorldConfig,
  tileX: number,
  tileY: number
): Promise<Uint16Array> {
  const sampleCount = config.tileSize * config.tileSize;
  const outputBytes = sampleCount * Uint32Array.BYTES_PER_ELEMENT;
  const uniform = new Float32Array([
    config.tileSize,
    config.tilesPerSide,
    config.unitSize,
    config.worldHeight,
    tileX,
    tileY,
    documentBuffers.landformCount,
    documentBuffers.mountainCount
  ]);
  const buffers = {
    uniform: createBuffer(device, uniform, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST),
    output: device.createBuffer({ size: outputBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }),
    readback: device.createBuffer({ size: outputBytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
  };
  const bindGroup = device.createBindGroup({
    label: 'WorldForge structural bake bind group',
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: buffers.uniform } },
      { binding: 1, resource: { buffer: documentBuffers.landform0 } },
      { binding: 2, resource: { buffer: documentBuffers.landform1 } },
      { binding: 3, resource: { buffer: documentBuffers.landform2 } },
      { binding: 4, resource: { buffer: documentBuffers.mountain0 } },
      { binding: 5, resource: { buffer: documentBuffers.mountain1 } },
      { binding: 6, resource: { buffer: documentBuffers.mountain2 } },
      { binding: 7, resource: { buffer: documentBuffers.points } },
      { binding: 8, resource: { buffer: documentBuffers.segments } },
      { binding: 9, resource: { buffer: documentBuffers.segmentBounds } },
      { binding: 10, resource: { buffer: buffers.output } }
    ]
  });
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(Math.ceil(config.tileSize / WORKGROUP_SIZE), Math.ceil(config.tileSize / WORKGROUP_SIZE));
  pass.end();
  encoder.copyBufferToBuffer(buffers.output, 0, buffers.readback, 0, outputBytes);
  device.queue.submit([encoder.finish()]);
  await buffers.readback.mapAsync(GPUMapMode.READ);
  const mapped = new Uint32Array(buffers.readback.getMappedRange());
  const result = new Uint16Array(sampleCount);
  for (let i = 0; i < sampleCount; i += 1) {
    result[i] = mapped[i];
  }
  buffers.readback.unmap();
  for (const buffer of Object.values(buffers)) {
    buffer.destroy();
  }
  return result;
}

function createDocumentBuffers(device: GPUDevice, packed: PackedGpuDocument): GpuDocumentBuffers {
  return {
    landformCount: packed.landformCount,
    mountainCount: packed.mountainCount,
    landform0: createStorageBuffer(device, packed.landform0),
    landform1: createStorageBuffer(device, packed.landform1),
    landform2: createStorageBuffer(device, packed.landform2),
    mountain0: createStorageBuffer(device, packed.mountain0),
    mountain1: createStorageBuffer(device, packed.mountain1),
    mountain2: createStorageBuffer(device, packed.mountain2),
    points: createStorageBuffer(device, packed.points),
    segments: createStorageBuffer(device, packed.segments),
    segmentBounds: createStorageBuffer(device, packed.segmentBounds)
  };
}

function packPreparedDocument(document: PreparedStructuralDocument, waterLevel: number, worldHeight: number): PackedGpuDocument {
  const landform0: number[] = [];
  const landform1: number[] = [];
  const landform2: number[] = [];
  const mountain0: number[] = [];
  const mountain1: number[] = [];
  const mountain2: number[] = [];
  const points: number[] = [];
  const segments: number[] = [];
  const segmentBounds: number[] = [];
  const fieldIds = document.fieldLibrary
    .filter((field) => compileNoiseFieldGraph(field))
    .map((field) => field.id);

  for (const landform of document.landforms) {
    const pointOffset = points.length / 2;
    for (let i = 0; i < landform.xs.length; i += 1) {
      points.push(landform.xs[i], landform.zs[i]);
    }
    const segmentOffset = segments.length / 4;
    for (const segment of landform.segments) {
      segments.push(segment.ax, segment.az, segment.bx, segment.bz);
      segmentBounds.push(segment.minX, segment.maxX, segment.minZ, segment.maxZ);
    }
    landform0.push(landform.bounds.minX, landform.bounds.maxX, landform.bounds.minZ, landform.bounds.maxZ);
    landform1.push(getLandformTargetElevation(landform.primitive.mode, landform.primitive.elevation, waterLevel, worldHeight), landform.primitive.noiseScale, landform.primitive.edgeSmoothness, fieldIndex(fieldIds, landform.primitive.fieldId));
    landform2.push(pointOffset, landform.xs.length, segmentOffset, landform.segments.length);
  }

  for (const mountain of document.mountains) {
    const pointOffset = points.length / 2;
    for (let i = 0; i < mountain.xs.length; i += 1) {
      points.push(mountain.xs[i], mountain.zs[i]);
    }
    const segmentOffset = segments.length / 4;
    for (const segment of mountain.segments) {
      segments.push(segment.ax, segment.az, segment.bx, segment.bz);
      segmentBounds.push(segment.minX, segment.maxX, segment.minZ, segment.maxZ);
    }
    mountain0.push(mountain.bounds.minX, mountain.bounds.maxX, mountain.bounds.minZ, mountain.bounds.maxZ);
    mountain1.push(Math.max(0, mountain.primitive.height), mountain.primitive.width, mountain.primitive.edgeSmoothness, fieldIndex(fieldIds, mountain.primitive.fieldId));
    mountain2.push(pointOffset, mountain.xs.length, segmentOffset, mountain.segments.length);
  }

  return {
    landformCount: landform0.length / 4,
    mountainCount: mountain0.length / 4,
    landform0: vec4Array(landform0),
    landform1: vec4Array(landform1),
    landform2: vec4Array(landform2),
    mountain0: vec4Array(mountain0),
    mountain1: vec4Array(mountain1),
    mountain2: vec4Array(mountain2),
    points: vec2Array(points),
    segments: vec4Array(segments),
    segmentBounds: vec4Array(segmentBounds),
    fieldIds
  };
}

function createBakeShader(config: WorldConfig, fields: NoiseFieldGraphV1[]): string {
  const supportedFields = fields.filter((field) => compileNoiseFieldGraph(field));
  const fieldFunctions = supportedFields.map((field, index) => emitFieldFunction(field, index)).join('\n\n');
  const fieldSwitch = supportedFields.length === 0
    ? 'return 0.0;'
    : `switch (fieldIndex) {\n${supportedFields.map((_, index) => `    case ${index}: { return field_${index}(position); }`).join('\n')}\n    default: { return 0.0; }\n  }`;

  return `
struct BakeUniforms {
  tileSize: f32,
  tilesPerSide: f32,
  unitSize: f32,
  worldHeight: f32,
  tileX: f32,
  tileY: f32,
  landformCount: f32,
  mountainCount: f32,
}
struct Vec4Buffer { values: array<vec4<f32>> };
struct OutputBuffer { values: array<u32> };

@group(0) @binding(0) var<uniform> u: BakeUniforms;
@group(0) @binding(1) var<storage, read> landform0: Vec4Buffer;
@group(0) @binding(2) var<storage, read> landform1: Vec4Buffer;
@group(0) @binding(3) var<storage, read> landform2: Vec4Buffer;
@group(0) @binding(4) var<storage, read> mountain0: Vec4Buffer;
@group(0) @binding(5) var<storage, read> mountain1: Vec4Buffer;
@group(0) @binding(6) var<storage, read> mountain2: Vec4Buffer;
@group(0) @binding(7) var<storage, read> points: Vec4Buffer;
@group(0) @binding(8) var<storage, read> segments: Vec4Buffer;
@group(0) @binding(9) var<storage, read> segmentBounds: Vec4Buffer;
@group(0) @binding(10) var<storage, read_write> output: OutputBuffer;

const TILE_SIZE: u32 = ${Math.trunc(config.tileSize)}u;
const WORKGROUP_SIZE: u32 = ${WORKGROUP_SIZE}u;

fn saturate(v: f32) -> f32 { return clamp(v, 0.0, 1.0); }
fn lerp(a: f32, b: f32, t: f32) -> f32 { return a + (b - a) * t; }
fn smoothstep_wf(edge0: f32, edge1: f32, value: f32) -> f32 {
  if (edge0 == edge1) { return select(0.0, 1.0, value >= edge1); }
  let t = saturate((value - edge0) / (edge1 - edge0));
  return t * t * (3.0 - 2.0 * t);
}
fn terrace_wf(value: f32, steps: f32, softness: f32) -> f32 {
  let count = max(1.0, floor(steps));
  let t = saturate(softness);
  let v = saturate(value);
  if (t >= 1.0) { return v; }
  let scaled = v * count;
  let cell = min(count - 1.0, floor(scaled));
  let lower = cell / count;
  let upper = (cell + 1.0) / count;
  let local = saturate(scaled - cell);
  let rampStart = 1.0 - max(t, 0.000001);
  return lower + (upper - lower) * smoothstep_wf(rampStart, 1.0, local);
}
fn hash2(p: vec2<f32>, seed: f32) -> f32 {
  let h = dot(p + vec2<f32>(seed * 17.17, seed * 0.131), vec2<f32>(127.1, 311.7));
  return fract(sin(h) * 43758.5453123);
}
fn noise2(seed: f32, x: f32, y: f32) -> f32 {
  let p = vec2<f32>(x, y);
  let i = floor(p);
  let f = fract(p);
  let u2 = f * f * (3.0 - 2.0 * f);
  let a = hash2(i, seed);
  let b = hash2(i + vec2<f32>(1.0, 0.0), seed);
  let c = hash2(i + vec2<f32>(0.0, 1.0), seed);
  let d = hash2(i + vec2<f32>(1.0, 1.0), seed);
  return (mix(mix(a, b, u2.x), mix(c, d, u2.x), u2.y) * 2.0) - 1.0;
}
fn distanceToSegmentSq(p: vec2<f32>, a: vec2<f32>, b: vec2<f32>) -> f32 {
  let ab = b - a;
  let lenSq = dot(ab, ab);
  if (lenSq == 0.0) { return dot(p - a, p - a); }
  let t = saturate(dot(p - a, ab) / lenSq);
  let closest = a + ab * t;
  return dot(p - closest, p - closest);
}
fn pointAt(index: u32) -> vec2<f32> {
  let item = points.values[index / 2u];
  return select(item.zw, item.xy, (index % 2u) == 0u);
}
fn pointInPolygon(position: vec2<f32>, pointOffset: u32, pointCount: u32) -> bool {
  var inside = false;
  var j = pointCount - 1u;
  for (var i = 0u; i < pointCount; i = i + 1u) {
    let pi = pointAt(pointOffset + i);
    let pj = pointAt(pointOffset + j);
    let denominator = pj.y - pi.y;
    let safeDenominator = select(denominator, 0.000001, abs(denominator) <= 0.000001);
    if (((pi.y > position.y) != (pj.y > position.y)) && (position.x < ((pj.x - pi.x) * (position.y - pi.y)) / safeDenominator + pi.x)) {
      inside = !inside;
    }
    j = i;
  }
  return inside;
}
fn distanceToSegments(position: vec2<f32>, segmentOffset: u32, segmentCount: u32, maxDistance: f32) -> f32 {
  var bestSq = 3.402823e38;
  let maxDistanceSq = maxDistance * maxDistance;
  for (var i = 0u; i < segmentCount; i = i + 1u) {
    let bounds = segmentBounds.values[segmentOffset + i];
    if (position.x < bounds.x - maxDistance || position.x > bounds.y + maxDistance || position.y < bounds.z - maxDistance || position.y > bounds.w + maxDistance) {
      continue;
    }
    let segment = segments.values[segmentOffset + i];
    bestSq = min(bestSq, distanceToSegmentSq(position, segment.xy, segment.zw));
    if (bestSq == 0.0) { return 0.0; }
  }
  if (bestSq > maxDistanceSq) { return maxDistance + 1.0; }
  return sqrt(bestSq);
}
${fieldFunctions}
fn evaluateField(fieldIndexF: f32, position: vec2<f32>) -> f32 {
  let fieldIndex = i32(fieldIndexF);
  ${fieldSwitch}
}
fn landformWeight(position: vec2<f32>, meta2: vec4<f32>, edgeSmoothness: f32) -> f32 {
  let pointOffset = u32(meta2.x);
  let pointCount = u32(meta2.y);
  if (!pointInPolygon(position, pointOffset, pointCount)) { return 0.0; }
  if (edgeSmoothness <= 0.0) { return 1.0; }
  let distance = distanceToSegments(position, u32(meta2.z), u32(meta2.w), edgeSmoothness);
  return smoothstep_wf(0.0, edgeSmoothness, distance);
}
fn mountainWeight(position: vec2<f32>, meta1: vec4<f32>, meta2: vec4<f32>) -> f32 {
  let width = meta1.y;
  if (width <= 0.0) { return 0.0; }
  let halfWidth = width * 0.5;
  let distance = distanceToSegments(position, u32(meta2.z), u32(meta2.w), halfWidth);
  if (distance >= halfWidth) { return 0.0; }
  let edgeSmoothness = clamp(meta1.z, 0.0, halfWidth);
  if (edgeSmoothness == 0.0) { return 1.0 - distance / halfWidth; }
  let fadeStart = max(0.0, halfWidth - edgeSmoothness);
  if (distance <= fadeStart) { return 1.0; }
  return 1.0 - smoothstep_wf(fadeStart, halfWidth, distance);
}
@compute @workgroup_size(${WORKGROUP_SIZE}, ${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= TILE_SIZE || id.y >= TILE_SIZE) { return; }
  let tileSize = u.tileSize;
  let tilesPerSide = u.tilesPerSide;
  let unitSize = u.unitSize;
  let worldHeight = u.worldHeight;
  let worldSize = tileSize * tilesPerSide * unitSize;
  let position = vec2<f32>(
    (u.tileX * tileSize + f32(id.x)) * unitSize - worldSize * 0.5,
    (u.tileY * tileSize + f32(id.y)) * unitSize - worldSize * 0.5
  );
  var elevation = 0.0;

  for (var i = 0u; i < u32(u.landformCount); i = i + 1u) {
    let bounds = landform0.values[i];
    if (position.x < bounds.x || position.x > bounds.y || position.y < bounds.z || position.y > bounds.w) {
      continue;
    }
    let meta1 = landform1.values[i];
    let meta2 = landform2.values[i];
    let weight = landformWeight(position, meta2, meta1.z);
    if (weight <= 0.0) {
      continue;
    }
    var targetElevation = meta1.x;
    if (meta1.w >= 0.0) {
      targetElevation = targetElevation + evaluateField(meta1.w, position) * meta1.y;
    }
    elevation = lerp(elevation, clamp(targetElevation, 0.0, worldHeight), weight);
  }

  for (var i = 0u; i < u32(u.mountainCount); i = i + 1u) {
    let bounds = mountain0.values[i];
    if (position.x < bounds.x || position.x > bounds.y || position.y < bounds.z || position.y > bounds.w) {
      continue;
    }
    let meta1 = mountain1.values[i];
    let meta2 = mountain2.values[i];
    let weight = mountainWeight(position, meta1, meta2);
    if (weight <= 0.0) {
      continue;
    }
    var mountainValue = 1.0;
    if (meta1.w >= 0.0) {
      mountainValue = evaluateField(meta1.w, position);
    }
    elevation = clamp(elevation + mountainValue * meta1.x * weight, 0.0, worldHeight);
  }

  let normalized = clamp(elevation, 0.0, worldHeight) / worldHeight;
  output.values[id.y * TILE_SIZE + id.x] = u32(round(normalized * 65535.0));
}
`;
}

function emitFieldFunction(graph: NoiseFieldGraphV1, index: number): string {
  if (validateNoiseGraph(graph).some((issue) => issue.severity === 'error')) {
    return `fn field_${index}(position: vec2<f32>) -> f32 { return 0.0; }`;
  }
  const output = graph.nodes.find((node) => node.type === 'output');
  if (!output) return `fn field_${index}(position: vec2<f32>) -> f32 { return 0.0; }`;
  const state: CompileState = {
    graph,
    nodes: new Map(graph.nodes.map((node) => [node.id, node])),
    incoming: new Map(graph.edges.map((edge) => [`${edge.to.nodeId}:${edge.to.portId}`, edge])),
    memo: new Map()
  };
  const expression = emitInputFloat(state, output, 'value', '1.0');
  return `fn field_${index}(position: vec2<f32>) -> f32 { return ${expression}; }`;
}

function emitInputFloat(state: CompileState, node: NoiseGraphNodeV1, portId: string, fallback: string): string {
  const edge = state.incoming.get(`${node.id}:${portId}`);
  if (!edge) return fallback;
  const source = state.nodes.get(edge.from.nodeId);
  if (!source) return fallback;
  const expression = emitOutput(state, source, edge.from.portId);
  return expression.type === 'float' ? expression.value : fallback;
}

function emitInputVec2(state: CompileState, node: NoiseGraphNodeV1, portId: string, fallback: { x: string; y: string }): { x: string; y: string } {
  const edge = state.incoming.get(`${node.id}:${portId}`);
  if (!edge) return fallback;
  const source = state.nodes.get(edge.from.nodeId);
  if (!source) return fallback;
  const expression = emitOutput(state, source, edge.from.portId);
  return expression.type === 'vec2' ? { x: expression.x, y: expression.y } : fallback;
}

function emitOutput(
  state: CompileState,
  node: NoiseGraphNodeV1,
  portId: string
): { type: 'float'; value: string } | { type: 'vec2'; x: string; y: string } {
  const key = `${node.id}:${portId}`;
  const memo = state.memo.get(key);
  if (memo) return { type: 'float', value: memo };

  if (node.type === 'cartesianPosition') {
    if (portId === 'x') return { type: 'float', value: 'position.x' };
    if (portId === 'y') return { type: 'float', value: 'position.y' };
    return { type: 'vec2', x: 'position.x', y: 'position.y' };
  }
  if (node.type === 'constFloat') return floatMemo(state, key, numberLiteral(param(node, 'value', 1)));
  if (node.type === 'simplex2d') return floatMemo(state, key, emitSimplex2d(state, node));
  if (node.type === 'fbm2d') return floatMemo(state, key, emitFbm2d(state, node, false));
  if (node.type === 'ridged2d') return floatMemo(state, key, emitFbm2d(state, node, true));
  if (node.type === 'add') return floatMemo(state, key, `(${emitInputFloat(state, node, 'a', '0.0')} + ${emitInputFloat(state, node, 'b', '0.0')})`);
  if (node.type === 'subtract') return floatMemo(state, key, `(${emitInputFloat(state, node, 'a', '0.0')} - ${emitInputFloat(state, node, 'b', '0.0')})`);
  if (node.type === 'multiply') return floatMemo(state, key, `(${emitInputFloat(state, node, 'a', '1.0')} * ${emitInputFloat(state, node, 'b', '1.0')})`);
  if (node.type === 'divide') {
    const divisor = emitInputFloat(state, node, 'b', '1.0');
    return floatMemo(state, key, `(select((${emitInputFloat(state, node, 'a', '1.0')} / ${divisor}), 0.0, abs(${divisor}) <= 0.000001))`);
  }
  if (node.type === 'clamp') return floatMemo(state, key, `clamp(${emitInputFloat(state, node, 'in', '0.0')}, ${numberLiteral(param(node, 'min', 0))}, ${numberLiteral(param(node, 'max', 1))})`);
  if (node.type === 'power') return floatMemo(state, key, `pow(max(0.0, ${emitInputFloat(state, node, 'in', '0.0')}), ${numberLiteral(param(node, 'exponent', 1))})`);
  if (node.type === 'terrace') return floatMemo(state, key, `terrace_wf(${emitInputFloat(state, node, 'in', '0.0')}, ${numberLiteral(param(node, 'steps', 5))}, ${numberLiteral(param(node, 'softness', 0.18))})`);
  if (node.type === 'smoothstep') return floatMemo(state, key, `smoothstep_wf(${numberLiteral(param(node, 'edge0', 0))}, ${numberLiteral(param(node, 'edge1', 1))}, ${emitInputFloat(state, node, 'in', '0.0')})`);
  return { type: 'float', value: '0.0' };
}

function emitSimplex2d(state: CompileState, node: NoiseGraphNodeV1): string {
  const input = noiseInput(state, node);
  const frequency = param(node, 'frequency', 0.002);
  const x = `(((${input.x}) + ${numberLiteral(param(node, 'offsetX', 0))}) * ${numberLiteral(frequency)} / ${numberLiteral(safeScale(param(node, 'skewX', 1)))})`;
  const y = `(((${input.y}) + ${numberLiteral(param(node, 'offsetY', 0))}) * ${numberLiteral(frequency)} / ${numberLiteral(safeScale(param(node, 'skewY', 1)))})`;
  const normalized = `((noise2(${numberLiteral(Math.trunc(param(node, 'seed', 1)))}, ${x}, ${y}) * 0.5 + 0.5) * ${numberLiteral(param(node, 'amplitude', 1))})`;
  return remap01(`clamp(${normalized}, 0.0, 1.0)`, node);
}

function emitFbm2d(state: CompileState, node: NoiseGraphNodeV1, ridged: boolean): string {
  const input = noiseInput(state, node);
  const octaves = Math.max(1, Math.min(12, Math.trunc(param(node, 'octaves', 5))));
  const lacunarity = Math.max(0.01, param(node, 'lacunarity', 2));
  const gain = Math.max(0, param(node, 'gain', 0.5));
  const seed = Math.trunc(param(node, 'seed', 1));
  const skewX = safeScale(param(node, 'skewX', 1));
  const skewY = safeScale(param(node, 'skewY', 1));
  const offsetX = param(node, 'offsetX', 0);
  const offsetY = param(node, 'offsetY', 0);
  let frequency = param(node, 'frequency', 0.002);
  let amplitude = 1;
  let amplitudeSum = 0;
  const terms: string[] = [];
  for (let octave = 0; octave < octaves; octave += 1) {
    const x = `(((${input.x}) + ${numberLiteral(offsetX)}) * ${numberLiteral(frequency)} / ${numberLiteral(skewX)})`;
    const y = `(((${input.y}) + ${numberLiteral(offsetY)}) * ${numberLiteral(frequency)} / ${numberLiteral(skewY)})`;
    const raw = `noise2(${numberLiteral(seed + octave * 1013)}, ${x}, ${y})`;
    const normalized = ridged ? `(1.0 - abs(${raw}))` : `(${raw} * 0.5 + 0.5)`;
    terms.push(`(${normalized} * ${numberLiteral(amplitude)})`);
    amplitudeSum += amplitude;
    amplitude *= gain;
    frequency *= lacunarity;
  }
  const value = terms.length > 0 ? `((${terms.join(' + ')}) / ${numberLiteral(amplitudeSum || 1)})` : '0.0';
  return remap01(`clamp((${value} * ${numberLiteral(param(node, 'amplitude', 1))}), 0.0, 1.0)`, node);
}

function noiseInput(state: CompileState, node: NoiseGraphNodeV1): { x: string; y: string } {
  const xy = emitInputVec2(state, node, 'xy', { x: '', y: '' });
  if (xy.x && xy.y) return xy;
  return {
    x: emitInputFloat(state, node, 'x', 'position.x'),
    y: emitInputFloat(state, node, 'y', 'position.y')
  };
}

function remap01(value: string, node: NoiseGraphNodeV1): string {
  const min = param(node, 'rangeMin', 0);
  const max = param(node, 'rangeMax', 1);
  return `(${numberLiteral(min)} + (${value}) * ${numberLiteral(max - min)})`;
}

function floatMemo(state: CompileState, key: string, value: string): { type: 'float'; value: string } {
  state.memo.set(key, value);
  return { type: 'float', value };
}

function createStorageBuffer(device: GPUDevice, data: Float32Array): GPUBuffer {
  return createBuffer(device, data.length > 0 ? data : new Float32Array(4), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
}

function createBuffer(device: GPUDevice, data: Float32Array, usage: GPUBufferUsageFlags): GPUBuffer {
  const buffer = device.createBuffer({ size: alignedByteLength(data.byteLength), usage, mappedAtCreation: true });
  new Float32Array(buffer.getMappedRange()).set(data);
  buffer.unmap();
  return buffer;
}

function vec4Array(values: number[]): Float32Array {
  return new Float32Array(values.length > 0 ? values : [0, 0, 0, 0]);
}

function vec2Array(values: number[]): Float32Array {
  const padded = [...values];
  while (padded.length % 4 !== 0) padded.push(0);
  if (padded.length === 0) padded.push(0, 0, 0, 0);
  return new Float32Array(padded);
}

function alignedByteLength(byteLength: number): number {
  return Math.max(4, Math.ceil(byteLength / 4) * 4);
}

function fieldIndex(fieldIds: string[], fieldId: string | undefined): number {
  if (!fieldId) return -1;
  return fieldIds.indexOf(fieldId);
}

function getLandformTargetElevation(mode: string, elevation: number, waterLevel: number, worldHeight: number): number {
  if (mode === 'water') return clamp(Math.min(elevation, waterLevel - 1), 0, worldHeight);
  return clamp(Math.max(elevation, waterLevel + 1), 0, worldHeight);
}

function param(node: NoiseGraphNodeV1, key: string, fallback: number): number {
  const value = Number(node.params[key]);
  return Number.isFinite(value) ? value : fallback;
}

function numberLiteral(value: number): string {
  return Number.isFinite(value) ? `${value}` : '0.0';
}

function safeScale(value: number): number {
  return Math.abs(value) <= Number.EPSILON ? 1 : value;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
