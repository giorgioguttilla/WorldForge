import { createNoise2D } from 'simplex-noise';
import { getNodeDefinition } from './definitions';
import { validateNoiseGraph } from './graph';
import type { GraphVec2, NoiseFieldEvaluationContext, NoiseFieldGraphV1, NoiseGraphNodeV1 } from './types';

type GraphValue = number | GraphVec2;

interface CompiledInput {
  nodeIndex: number;
  portId: string;
}

interface CompiledNode {
  id: string;
  type: NoiseGraphNodeV1['type'];
  inputs: Record<string, CompiledInput | undefined>;
  params: Record<string, number>;
}

export interface CompiledNoiseFieldGraph {
  readonly id: string;
  readonly usesSpline: boolean;
  evaluate(context: NoiseFieldEvaluationContext): number;
}

export function evaluateNoiseFieldGraph(graph: NoiseFieldGraphV1 | null | undefined, context: NoiseFieldEvaluationContext): number {
  return compileNoiseFieldGraph(graph)?.evaluate(context) ?? 0;
}

export function compileNoiseFieldGraph(graph: NoiseFieldGraphV1 | null | undefined): CompiledNoiseFieldGraph | null {
  if (!graph) return null;
  if (validateNoiseGraph(graph).some((issue) => issue.severity === 'error')) return null;
  const outputIndex = graph.nodes.findIndex((node) => node.type === 'output');
  if (outputIndex < 0) return null;
  return new CompiledNoiseGraphEvaluator(graph, outputIndex);
}

class CompiledNoiseGraphEvaluator implements CompiledNoiseFieldGraph {
  private readonly simplex = new Map<number, (x: number, y: number) => number>();
  private readonly nodes: CompiledNode[];
  private readonly valueCache: Array<Record<string, GraphValue | undefined>>;
  private readonly stampCache: Array<Record<string, number | undefined>>;
  private generation = 0;
  readonly id: string;
  readonly usesSpline: boolean;

  constructor(
    graph: NoiseFieldGraphV1,
    private readonly outputIndex: number
  ) {
    this.id = graph.id;
    this.usesSpline = graph.nodes.some((node) => node.type === 'splinePosition');
    const nodeIndex = new Map(graph.nodes.map((node, index) => [node.id, index]));
    this.nodes = graph.nodes.map((node) => ({ id: node.id, type: node.type, inputs: {}, params: numberParams(node.params) }));
    this.valueCache = graph.nodes.map(() => ({}));
    this.stampCache = graph.nodes.map(() => ({}));
    for (const edge of graph.edges) {
      const toIndex = nodeIndex.get(edge.to.nodeId);
      const fromIndex = nodeIndex.get(edge.from.nodeId);
      if (toIndex === undefined || fromIndex === undefined) continue;
      this.nodes[toIndex].inputs[edge.to.portId] = { nodeIndex: fromIndex, portId: edge.from.portId };
    }
  }

  evaluate(context: NoiseFieldEvaluationContext): number {
    this.generation = (this.generation + 1) || 1;
    return this.inputFloat(this.outputIndex, 'value', context, 1);
  }

  private inputFloat(
    nodeIndex: number,
    inputId: string,
    context: NoiseFieldEvaluationContext,
    fallback = this.param(nodeIndex, inputId, 0)
  ): number {
    const value = this.inputValue(nodeIndex, inputId, context);
    return typeof value === 'number' ? value : fallback;
  }

  private inputVec2(
    nodeIndex: number,
    inputId: string,
    context: NoiseFieldEvaluationContext,
    fallback: GraphVec2
  ): GraphVec2 {
    const value = this.inputValue(nodeIndex, inputId, context);
    return isVec2(value) ? value : fallback;
  }

  private inputValue(
    nodeIndex: number,
    inputId: string,
    context: NoiseFieldEvaluationContext
  ): GraphValue | undefined {
    const source = this.nodes[nodeIndex].inputs[inputId];
    if (!source) return undefined;
    return this.outputValue(source.nodeIndex, source.portId, context);
  }

  private outputValue(
    nodeIndex: number,
    outputId: string,
    context: NoiseFieldEvaluationContext
  ): GraphValue {
    if (this.stampCache[nodeIndex][outputId] === this.generation) return this.valueCache[nodeIndex][outputId] as GraphValue;
    const value = this.computeOutput(nodeIndex, outputId, context);
    this.valueCache[nodeIndex][outputId] = value;
    this.stampCache[nodeIndex][outputId] = this.generation;
    return value;
  }

  private computeOutput(
    nodeIndex: number,
    outputId: string,
    context: NoiseFieldEvaluationContext
  ): GraphValue {
    const node = this.nodes[nodeIndex];
    if (!getNodeDefinition(node.type)) return 0;
    if (node.type === 'constFloat') return this.param(nodeIndex, 'value', 1);
    if (node.type === 'cartesianPosition') return positionOutput(context.cartesian, outputId);
    if (node.type === 'splinePosition') return positionOutput(context.spline, outputId);
    if (node.type === 'simplex2d') return this.simplex2d(nodeIndex, context);
    if (node.type === 'fbm2d') return this.fbm2d(nodeIndex, context, false);
    if (node.type === 'ridged2d') return this.fbm2d(nodeIndex, context, true);
    if (node.type === 'add') return this.inputFloat(nodeIndex, 'a', context) + this.inputFloat(nodeIndex, 'b', context);
    if (node.type === 'subtract') return this.inputFloat(nodeIndex, 'a', context) - this.inputFloat(nodeIndex, 'b', context);
    if (node.type === 'multiply') return this.inputFloat(nodeIndex, 'a', context, 1) * this.inputFloat(nodeIndex, 'b', context, 1);
    if (node.type === 'divide') {
      const divisor = this.inputFloat(nodeIndex, 'b', context, 1);
      return Math.abs(divisor) <= Number.EPSILON ? 0 : this.inputFloat(nodeIndex, 'a', context, 1) / divisor;
    }
    if (node.type === 'clamp') return clamp(this.inputFloat(nodeIndex, 'in', context), this.param(nodeIndex, 'min', 0), this.param(nodeIndex, 'max', 1));
    if (node.type === 'power') return Math.pow(Math.max(0, this.inputFloat(nodeIndex, 'in', context)), this.param(nodeIndex, 'exponent', 1));
    if (node.type === 'smoothstep') return smoothstep(this.param(nodeIndex, 'edge0', 0), this.param(nodeIndex, 'edge1', 1), this.inputFloat(nodeIndex, 'in', context));
    return 0;
  }

  private noiseInput(
    nodeIndex: number,
    context: NoiseFieldEvaluationContext
  ): GraphVec2 {
    const xy = this.inputVec2(nodeIndex, 'xy', context, { x: Number.NaN, y: Number.NaN });
    if (Number.isFinite(xy.x) && Number.isFinite(xy.y)) return xy;
    return {
      x: this.inputFloat(nodeIndex, 'x', context, context.cartesian.x),
      y: this.inputFloat(nodeIndex, 'y', context, context.cartesian.y)
    };
  }

  private simplex2d(
    nodeIndex: number,
    context: NoiseFieldEvaluationContext
  ): number {
    const input = this.noiseInput(nodeIndex, context);
    const frequency = this.param(nodeIndex, 'frequency', 0.002);
    const x = ((input.x + this.param(nodeIndex, 'offsetX', 0)) * frequency) / safeScale(this.param(nodeIndex, 'skewX', 1));
    const y = ((input.y + this.param(nodeIndex, 'offsetY', 0)) * frequency) / safeScale(this.param(nodeIndex, 'skewY', 1));
    const seed = Math.trunc(this.param(nodeIndex, 'seed', 1));
    const normalized = this.noise(seed, x, y) * 0.5 + 0.5;
    return this.remap01(clamp(normalized * this.param(nodeIndex, 'amplitude', 1), 0, 1), nodeIndex);
  }

  private fbm2d(
    nodeIndex: number,
    context: NoiseFieldEvaluationContext,
    ridged: boolean
  ): number {
    const input = this.noiseInput(nodeIndex, context);
    const octaves = clamp(Math.trunc(this.param(nodeIndex, 'octaves', 5)), 1, 12);
    const baseFrequency = this.param(nodeIndex, 'frequency', 0.002);
    const lacunarity = Math.max(0.01, this.param(nodeIndex, 'lacunarity', 2));
    const gain = Math.max(0, this.param(nodeIndex, 'gain', 0.5));
    const seed = Math.trunc(this.param(nodeIndex, 'seed', 1));
    const offsetX = this.param(nodeIndex, 'offsetX', 0);
    const offsetY = this.param(nodeIndex, 'offsetY', 0);
    const skewX = safeScale(this.param(nodeIndex, 'skewX', 1));
    const skewY = safeScale(this.param(nodeIndex, 'skewY', 1));
    let frequency = baseFrequency;
    let amplitude = 1;
    let value = 0;
    let amplitudeSum = 0;
    for (let octave = 0; octave < octaves; octave += 1) {
      const x = ((input.x + offsetX) * frequency) / skewX;
      const y = ((input.y + offsetY) * frequency) / skewY;
      const n = this.noise(seed + octave * 1013, x, y);
      const normalized = ridged ? 1 - Math.abs(n) : n * 0.5 + 0.5;
      value += normalized * amplitude;
      amplitudeSum += amplitude;
      amplitude *= gain;
      frequency *= lacunarity;
    }
    const normalized = amplitudeSum > 0 ? value / amplitudeSum : 0;
    return this.remap01(clamp(normalized * this.param(nodeIndex, 'amplitude', 1), 0, 1), nodeIndex);
  }

  private noise(seed: number, x: number, y: number): number {
    let fn = this.simplex.get(seed);
    if (!fn) {
      fn = createNoise2D(seededRandom(seed));
      this.simplex.set(seed, fn);
    }
    return fn(x, y);
  }

  private param(nodeIndex: number, key: string, fallback: number): number {
    return this.nodes[nodeIndex].params[key] ?? fallback;
  }

  private remap01(value: number, nodeIndex: number): number {
    const min = this.param(nodeIndex, 'rangeMin', 0);
    const max = this.param(nodeIndex, 'rangeMax', 1);
    return min + value * (max - min);
  }
}

function positionOutput(position: GraphVec2, outputId: string): GraphValue {
  if (outputId === 'x') return position.x;
  if (outputId === 'y') return position.y;
  return position;
}

function numberParams(params: NoiseGraphNodeV1['params']): Record<string, number> {
  const values: Record<string, number> = {};
  for (const [key, value] of Object.entries(params)) {
    const number = Number(value);
    if (Number.isFinite(number)) values[key] = number;
  }
  return values;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  if (edge0 === edge1) return value >= edge1 ? 1 : 0;
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function safeScale(value: number): number {
  return Math.abs(value) <= Number.EPSILON ? 1 : value;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function isVec2(value: GraphValue | undefined): value is GraphVec2 {
  return typeof value === 'object' && value !== null && Number.isFinite(value.x) && Number.isFinite(value.y);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
