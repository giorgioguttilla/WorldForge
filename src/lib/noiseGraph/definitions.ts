import type { NoiseGraphNodeDefinition, NoiseGraphNodeTypeV1 } from './types';

export const NOISE_GRAPH_NODE_DEFINITIONS: Record<NoiseGraphNodeTypeV1, NoiseGraphNodeDefinition> = {
  output: {
    type: 'output',
    label: 'Output',
    category: 'Output',
    inputs: [{ id: 'value', label: 'Value', direction: 'input', valueType: 'float' }],
    outputs: [],
    defaultParams: {}
  },
  constFloat: {
    type: 'constFloat',
    label: 'Float',
    category: 'Inputs',
    inputs: [],
    outputs: [{ id: 'value', label: 'Value', direction: 'output', valueType: 'float' }],
    defaultParams: { value: 1 }
  },
  cartesianPosition: {
    type: 'cartesianPosition',
    label: 'Cartesian Position',
    category: 'Inputs',
    inputs: [],
    outputs: [
      { id: 'x', label: 'X', direction: 'output', valueType: 'float' },
      { id: 'y', label: 'Y', direction: 'output', valueType: 'float' },
      { id: 'xy', label: 'XY', direction: 'output', valueType: 'vec2' }
    ],
    defaultParams: {}
  },
  splinePosition: {
    type: 'splinePosition',
    label: 'Spline Position',
    category: 'Inputs',
    inputs: [],
    outputs: [
      { id: 'x', label: 'X', direction: 'output', valueType: 'float' },
      { id: 'y', label: 'Y', direction: 'output', valueType: 'float' },
      { id: 'xy', label: 'XY', direction: 'output', valueType: 'vec2' }
    ],
    defaultParams: {}
  },
  simplex2d: {
    type: 'simplex2d',
    label: 'Simplex 2D',
    category: 'Noise',
    inputs: [
      { id: 'x', label: 'X', direction: 'input', valueType: 'float' },
      { id: 'y', label: 'Y', direction: 'input', valueType: 'float' },
      { id: 'xy', label: 'XY', direction: 'input', valueType: 'vec2' }
    ],
    outputs: [{ id: 'value', label: 'Value', direction: 'output', valueType: 'float' }],
    defaultParams: { frequency: 0.002, amplitude: 1, seed: 1, skewX: 1, skewY: 1, offsetX: 0, offsetY: 0, rangeMin: 0, rangeMax: 1 }
  },
  fbm2d: {
    type: 'fbm2d',
    label: 'fBM 2D',
    category: 'Noise',
    inputs: [
      { id: 'x', label: 'X', direction: 'input', valueType: 'float' },
      { id: 'y', label: 'Y', direction: 'input', valueType: 'float' },
      { id: 'xy', label: 'XY', direction: 'input', valueType: 'vec2' }
    ],
    outputs: [{ id: 'value', label: 'Value', direction: 'output', valueType: 'float' }],
    defaultParams: { frequency: 0.0015, amplitude: 1, seed: 2, octaves: 5, lacunarity: 2, gain: 0.5, skewX: 1, skewY: 1, offsetX: 0, offsetY: 0, rangeMin: 0, rangeMax: 1 }
  },
  ridged2d: {
    type: 'ridged2d',
    label: 'Ridged 2D',
    category: 'Noise',
    inputs: [
      { id: 'x', label: 'X', direction: 'input', valueType: 'float' },
      { id: 'y', label: 'Y', direction: 'input', valueType: 'float' },
      { id: 'xy', label: 'XY', direction: 'input', valueType: 'vec2' }
    ],
    outputs: [{ id: 'value', label: 'Value', direction: 'output', valueType: 'float' }],
    defaultParams: { frequency: 0.0025, amplitude: 1, seed: 3, octaves: 5, lacunarity: 2, gain: 0.48, skewX: 1, skewY: 1, offsetX: 0, offsetY: 0, rangeMin: 0, rangeMax: 1 }
  },
  add: binaryMath('add', 'Add'),
  subtract: binaryMath('subtract', 'Subtract'),
  multiply: binaryMath('multiply', 'Multiply'),
  divide: binaryMath('divide', 'Divide'),
  clamp: {
    type: 'clamp',
    label: 'Clamp',
    category: 'Math',
    inputs: [{ id: 'in', label: 'Value', direction: 'input', valueType: 'float' }],
    outputs: [{ id: 'value', label: 'Value', direction: 'output', valueType: 'float' }],
    defaultParams: { min: 0, max: 1 }
  },
  power: {
    type: 'power',
    label: 'Power',
    category: 'Math',
    inputs: [{ id: 'in', label: 'Value', direction: 'input', valueType: 'float' }],
    outputs: [{ id: 'value', label: 'Value', direction: 'output', valueType: 'float' }],
    defaultParams: { exponent: 1 }
  },
  smoothstep: {
    type: 'smoothstep',
    label: 'Smoothstep',
    category: 'Math',
    inputs: [{ id: 'in', label: 'Value', direction: 'input', valueType: 'float' }],
    outputs: [{ id: 'value', label: 'Value', direction: 'output', valueType: 'float' }],
    defaultParams: { edge0: 0, edge1: 1 }
  }
};

function binaryMath(type: NoiseGraphNodeTypeV1, label: string): NoiseGraphNodeDefinition {
  return {
    type,
    label,
    category: 'Math',
    inputs: [
      { id: 'a', label: 'A', direction: 'input', valueType: 'float' },
      { id: 'b', label: 'B', direction: 'input', valueType: 'float' }
    ],
    outputs: [{ id: 'value', label: 'Value', direction: 'output', valueType: 'float' }],
    defaultParams: { a: type === 'multiply' || type === 'divide' ? 1 : 0, b: type === 'multiply' || type === 'divide' ? 1 : 0 }
  };
}

export function getNodeDefinition(type: string): NoiseGraphNodeDefinition | null {
  return NOISE_GRAPH_NODE_DEFINITIONS[type as NoiseGraphNodeTypeV1] ?? null;
}
