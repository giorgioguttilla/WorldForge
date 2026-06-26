import { createNoise2D } from 'simplex-noise';
import { validateNoiseGraph } from './graph';
import type { GraphVec2, NoiseFieldEvaluationContext, NoiseFieldGraphV1, NoiseGraphEdgeV1, NoiseGraphNodeV1 } from './types';

type EvaluateFn = (context: NoiseFieldEvaluationContext) => number;

export interface CompiledNoiseFieldGraph {
  readonly id: string;
  readonly usesSpline: boolean;
  evaluate(context: NoiseFieldEvaluationContext): number;
}

interface CompileState {
  graph: NoiseFieldGraphV1;
  nodes: Map<string, NoiseGraphNodeV1>;
  incoming: Map<string, NoiseGraphEdgeV1>;
  memo: Map<string, string>;
}

export function evaluateNoiseFieldGraph(graph: NoiseFieldGraphV1 | null | undefined, context: NoiseFieldEvaluationContext): number {
  return compileNoiseFieldGraph(graph)?.evaluate(context) ?? 0;
}

export function compileNoiseFieldGraph(graph: NoiseFieldGraphV1 | null | undefined): CompiledNoiseFieldGraph | null {
  if (!graph) return null;
  if (validateNoiseGraph(graph).some((issue) => issue.severity === 'error')) return null;
  const output = graph.nodes.find((node) => node.type === 'output');
  if (!output) return null;
  try {
    return new GeneratedNoiseFieldGraph(graph, output);
  } catch {
    return null;
  }
}

class GeneratedNoiseFieldGraph implements CompiledNoiseFieldGraph {
  private readonly simplex = new Map<number, (x: number, y: number) => number>();
  private readonly fn: EvaluateFn;
  readonly id: string;
  readonly usesSpline: boolean;

  constructor(graph: NoiseFieldGraphV1, output: NoiseGraphNodeV1) {
    this.id = graph.id;
    this.usesSpline = graph.nodes.some((node) => node.type === 'splinePosition');
    const state: CompileState = {
      graph,
      nodes: new Map(graph.nodes.map((node) => [node.id, node])),
      incoming: new Map(graph.edges.map((edge) => [`${edge.to.nodeId}:${edge.to.portId}`, edge])),
      memo: new Map()
    };
    const expression = emitInputFloat(state, output, 'value', '1');
    const source = `"use strict"; return function evaluate(c) { return ${expression}; };`;
    const factory = new Function('noise', 'clamp', 'smoothstep', source) as (noise: (seed: number, x: number, y: number) => number, clampFn: typeof clamp, smoothstepFn: typeof smoothstep) => EvaluateFn;
    this.fn = factory((seed, x, y) => this.noise(seed, x, y), clamp, smoothstep);
  }

  evaluate(context: NoiseFieldEvaluationContext): number {
    return this.fn(context);
  }

  private noise(seed: number, x: number, y: number): number {
    let fn = this.simplex.get(seed);
    if (!fn) {
      fn = createNoise2D(seededRandom(seed));
      this.simplex.set(seed, fn);
    }
    return fn(x, y);
  }
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

  if (node.type === 'cartesianPosition') return emitPosition('c.cartesian', portId);
  if (node.type === 'splinePosition') return emitPosition('c.spline', portId);
  if (node.type === 'constFloat') return floatMemo(state, key, numberLiteral(param(node, 'value', 1)));
  if (node.type === 'simplex2d') return floatMemo(state, key, emitSimplex2d(state, node));
  if (node.type === 'fbm2d') return floatMemo(state, key, emitFbm2d(state, node, false));
  if (node.type === 'ridged2d') return floatMemo(state, key, emitFbm2d(state, node, true));
  if (node.type === 'add') return floatMemo(state, key, `(${emitInputFloat(state, node, 'a', '0')} + ${emitInputFloat(state, node, 'b', '0')})`);
  if (node.type === 'subtract') return floatMemo(state, key, `(${emitInputFloat(state, node, 'a', '0')} - ${emitInputFloat(state, node, 'b', '0')})`);
  if (node.type === 'multiply') return floatMemo(state, key, `(${emitInputFloat(state, node, 'a', '1')} * ${emitInputFloat(state, node, 'b', '1')})`);
  if (node.type === 'divide') {
    const divisor = emitInputFloat(state, node, 'b', '1');
    return floatMemo(state, key, `(Math.abs(${divisor}) <= Number.EPSILON ? 0 : (${emitInputFloat(state, node, 'a', '1')} / ${divisor}))`);
  }
  if (node.type === 'clamp') {
    return floatMemo(state, key, `clamp(${emitInputFloat(state, node, 'in', '0')}, ${numberLiteral(param(node, 'min', 0))}, ${numberLiteral(param(node, 'max', 1))})`);
  }
  if (node.type === 'power') {
    return floatMemo(state, key, `Math.pow(Math.max(0, ${emitInputFloat(state, node, 'in', '0')}), ${numberLiteral(param(node, 'exponent', 1))})`);
  }
  if (node.type === 'smoothstep') {
    return floatMemo(state, key, `smoothstep(${numberLiteral(param(node, 'edge0', 0))}, ${numberLiteral(param(node, 'edge1', 1))}, ${emitInputFloat(state, node, 'in', '0')})`);
  }
  return { type: 'float', value: '0' };
}

function emitPosition(path: string, portId: string): { type: 'float'; value: string } | { type: 'vec2'; x: string; y: string } {
  if (portId === 'x') return { type: 'float', value: `${path}.x` };
  if (portId === 'y') return { type: 'float', value: `${path}.y` };
  return { type: 'vec2', x: `${path}.x`, y: `${path}.y` };
}

function emitSimplex2d(state: CompileState, node: NoiseGraphNodeV1): string {
  const input = noiseInput(state, node);
  const frequency = param(node, 'frequency', 0.002);
  const x = `(((${input.x}) + ${numberLiteral(param(node, 'offsetX', 0))}) * ${numberLiteral(frequency)} / ${numberLiteral(safeScale(param(node, 'skewX', 1)))})`;
  const y = `(((${input.y}) + ${numberLiteral(param(node, 'offsetY', 0))}) * ${numberLiteral(frequency)} / ${numberLiteral(safeScale(param(node, 'skewY', 1)))})`;
  const normalized = `((noise(${Math.trunc(param(node, 'seed', 1))}, ${x}, ${y}) * 0.5 + 0.5) * ${numberLiteral(param(node, 'amplitude', 1))})`;
  return remap01(`clamp(${normalized}, 0, 1)`, node);
}

function emitFbm2d(state: CompileState, node: NoiseGraphNodeV1, ridged: boolean): string {
  const input = noiseInput(state, node);
  const octaves = clamp(Math.trunc(param(node, 'octaves', 5)), 1, 12);
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
    const raw = `noise(${seed + octave * 1013}, ${x}, ${y})`;
    const normalized = ridged ? `(1 - Math.abs(${raw}))` : `(${raw} * 0.5 + 0.5)`;
    terms.push(`(${normalized} * ${numberLiteral(amplitude)})`);
    amplitudeSum += amplitude;
    amplitude *= gain;
    frequency *= lacunarity;
  }
  const value = terms.length > 0 ? `((${terms.join(' + ')}) / ${numberLiteral(amplitudeSum || 1)})` : '0';
  return remap01(`clamp((${value} * ${numberLiteral(param(node, 'amplitude', 1))}), 0, 1)`, node);
}

function noiseInput(state: CompileState, node: NoiseGraphNodeV1): { x: string; y: string } {
  const xy = emitInputVec2(state, node, 'xy', { x: '', y: '' });
  if (xy.x && xy.y) return xy;
  return {
    x: emitInputFloat(state, node, 'x', 'c.cartesian.x'),
    y: emitInputFloat(state, node, 'y', 'c.cartesian.y')
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

function param(node: NoiseGraphNodeV1, key: string, fallback: number): number {
  const value = Number(node.params[key]);
  return Number.isFinite(value) ? value : fallback;
}

function numberLiteral(value: number): string {
  return Number.isFinite(value) ? JSON.stringify(value) : '0';
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

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
