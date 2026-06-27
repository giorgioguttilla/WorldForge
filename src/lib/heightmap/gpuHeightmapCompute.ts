import { generateNoiseTile } from './noise';

export interface HeightmapComputeBackend {
  readonly label: string;
  generateNoiseTile(tileSize: number, tileX: number, tileY: number, seed: number): Promise<Uint16Array>;
  dispose?(): void;
}

export class CpuHeightmapCompute implements HeightmapComputeBackend {
  readonly label = 'cpu';

  async generateNoiseTile(tileSize: number, tileX: number, tileY: number, seed: number): Promise<Uint16Array> {
    return generateNoiseTile(tileSize, tileX, tileY, seed);
  }
}

export class WebGpuHeightmapCompute implements HeightmapComputeBackend {
  readonly label = 'webgpu-compute';
  private pipeline: GPUComputePipeline | null = null;
  private readonly cpuFallback = new CpuHeightmapCompute();

  private constructor(private readonly device: GPUDevice) {}

  static async create(): Promise<WebGpuHeightmapCompute | null> {
    if (!navigator.gpu) return null;
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return null;
    const device = await adapter.requestDevice();
    return new WebGpuHeightmapCompute(device);
  }

  async generateNoiseTile(tileSize: number, tileX: number, tileY: number, seed: number): Promise<Uint16Array> {
    const pipeline = this.getPipeline();
    const sampleCount = tileSize * tileSize;
    const outputBytes = sampleCount * Uint32Array.BYTES_PER_ELEMENT;
    const output = this.device.createBuffer({
      size: outputBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
    });
    const readback = this.device.createBuffer({
      size: outputBytes,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
    });
    const uniforms = this.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });

    this.device.queue.writeBuffer(uniforms, 0, new Uint32Array([tileSize, tileX, tileY, seed]));
    const bindGroup = this.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: output } },
        { binding: 1, resource: { buffer: uniforms } }
      ]
    });

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(tileSize / 8), Math.ceil(tileSize / 8));
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, outputBytes);
    this.device.queue.submit([encoder.finish()]);

    await readback.mapAsync(GPUMapMode.READ);
    const mapped = new Uint32Array(readback.getMappedRange());
    const samples = new Uint16Array(sampleCount);
    for (let i = 0; i < sampleCount; i += 1) {
      samples[i] = mapped[i] & 0xffff;
    }
    readback.unmap();
    output.destroy();
    readback.destroy();
    uniforms.destroy();

    return hasUsableHeightRange(samples) ? samples : this.cpuFallback.generateNoiseTile(tileSize, tileX, tileY, seed);
  }

  dispose(): void {
    this.pipeline = null;
    this.device.destroy();
  }

  private getPipeline(): GPUComputePipeline {
    if (this.pipeline) return this.pipeline;
    const module = this.device.createShaderModule({
      code: `
        struct Config {
          tileSize: u32,
          tileX: u32,
          tileY: u32,
          seed: u32,
        };

        @group(0) @binding(0) var<storage, read_write> outHeights: array<u32>;
        @group(0) @binding(1) var<uniform> config: Config;

        fn hash2(x: u32, y: u32, seed: u32) -> f32 {
          var h = x * 374761393u ^ y * 668265263u ^ seed * 1442695041u;
          h = h ^ (h >> 13u);
          h = h * 1274126177u;
          h = h ^ (h >> 16u);
          return f32(h) / 4294967295.0;
        }

        fn smoothstep01(v: f32) -> f32 {
          return v * v * (3.0 - 2.0 * v);
        }

        fn valueNoise(x: f32, y: f32, seed: u32) -> f32 {
          let xi = u32(floor(x));
          let yi = u32(floor(y));
          let tx = smoothstep01(fract(x));
          let ty = smoothstep01(fract(y));
          let a = hash2(xi, yi, seed);
          let b = hash2(xi + 1u, yi, seed);
          let c = hash2(xi, yi + 1u, seed);
          let d = hash2(xi + 1u, yi + 1u, seed);
          return mix(mix(a, b, tx), mix(c, d, tx), ty);
        }

        fn heightAt(worldX: f32, worldY: f32, seed: u32) -> f32 {
          var amplitude = 0.62;
          var frequency = 0.0032;
          var value = 0.0;
          var weight = 0.0;
          for (var octave = 0u; octave < 5u; octave = octave + 1u) {
            value = value + valueNoise(worldX * frequency, worldY * frequency, seed + octave * 101u) * amplitude;
            weight = weight + amplitude;
            amplitude = amplitude * 0.5;
            frequency = frequency * 2.0;
          }
          return clamp((value / weight) * 0.86 + 0.07, 0.0, 1.0);
        }

        @compute @workgroup_size(8, 8)
        fn main(@builtin(global_invocation_id) id: vec3<u32>) {
          if (id.x >= config.tileSize || id.y >= config.tileSize) {
            return;
          }
          let index = id.y * config.tileSize + id.x;
          let worldX = f32(config.tileX * config.tileSize + id.x);
          let worldY = f32(config.tileY * config.tileSize + id.y);
          outHeights[index] = u32(round(heightAt(worldX, worldY, config.seed) * 65535.0));
        }
      `
    });

    this.pipeline = this.device.createComputePipeline({
      layout: 'auto',
      compute: {
        module,
        entryPoint: 'main'
      }
    });
    return this.pipeline;
  }
}

export function hasUsableHeightRange(samples: Uint16Array): boolean {
  if (samples.length === 0) return false;
  let min = 65535;
  let max = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const value = samples[i];
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return max - min > 64;
}

export async function createHeightmapComputeBackend(): Promise<HeightmapComputeBackend> {
  try {
    return (await WebGpuHeightmapCompute.create()) ?? new CpuHeightmapCompute();
  } catch (error) {
    console.warn('WebGPU heightmap compute unavailable; using CPU generation.', error);
    return new CpuHeightmapCompute();
  }
}
