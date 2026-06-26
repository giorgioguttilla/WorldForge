import type { NoiseFieldGraphV1, NoiseGraphNodeTypeV1 } from './types';

export function createDefaultNoiseFieldLibrary(): NoiseFieldGraphV1[] {
  return [
    rollingHillsPreset(),
    mountainsPreset(),
    canyonPreset()
  ];
}

function rollingHillsPreset(): NoiseFieldGraphV1 {
  const position = node('rolling-position', 'cartesianPosition', 60, 140);
  const fbm = node('rolling-fbm', 'fbm2d', 300, 105, { frequency: 0.0009, octaves: 5, gain: 0.52, seed: 71, rangeMin: -1, rangeMax: 1 });
  const output = node('rolling-output', 'output', 540, 130);
  return graph('preset-rolling-hills', 'Rolling Hills', 'Low rounded terrain undulations.', [position, fbm, output], [
    edge(position, 'xy', fbm, 'xy'),
    edge(fbm, 'value', output, 'value')
  ]);
}

function mountainsPreset(): NoiseFieldGraphV1 {
  const position = node('mountains-position', 'cartesianPosition', 60, 140);
  const ridge = node('mountains-ridge', 'ridged2d', 295, 70, { frequency: 0.0022, octaves: 6, gain: 0.55, seed: 219, rangeMin: 0, rangeMax: 1 });
  const mask = node('mountains-mask', 'fbm2d', 295, 245, { frequency: 0.00075, octaves: 4, gain: 0.5, seed: 220, rangeMin: 0.25, rangeMax: 1 });
  const multiply = node('mountains-multiply', 'multiply', 530, 135);
  const power = node('mountains-power', 'power', 720, 135, { exponent: 1.35 });
  const output = node('mountains-output', 'output', 910, 135);
  return graph('preset-mountains', 'Mountains', 'Ridged peaks with broad elevation breakup.', [position, ridge, mask, multiply, power, output], [
    edge(position, 'xy', ridge, 'xy'),
    edge(position, 'xy', mask, 'xy'),
    edge(ridge, 'value', multiply, 'a'),
    edge(mask, 'value', multiply, 'b'),
    edge(multiply, 'value', power, 'in'),
    edge(power, 'value', output, 'value')
  ]);
}

function canyonPreset(): NoiseFieldGraphV1 {
  const spline = node('canyon-spline', 'splinePosition', 60, 140);
  const ridge = node('canyon-ridge', 'ridged2d', 285, 115, { frequency: 0.003, octaves: 5, gain: 0.46, seed: 341, skewX: 0.35, skewY: 2.4, rangeMin: 0, rangeMax: 1 });
  const shape = node('canyon-shape', 'smoothstep', 505, 125, { edge0: 0.42, edge1: 0.92 });
  const scale = node('canyon-scale', 'constFloat', 505, 245, { value: -1 });
  const carve = node('canyon-carve', 'multiply', 725, 135);
  const output = node('canyon-output', 'output', 925, 135);
  return graph('preset-canyon', 'Canyon', 'Stretched contour-following ridges for carved bands.', [spline, ridge, shape, scale, carve, output], [
    edge(spline, 'xy', ridge, 'xy'),
    edge(ridge, 'value', shape, 'in'),
    edge(shape, 'value', carve, 'a'),
    edge(scale, 'value', carve, 'b'),
    edge(carve, 'value', output, 'value')
  ]);
}

function graph(id: string, name: string, description: string, nodes: ReturnType<typeof node>[], edges: ReturnType<typeof edge>[]): NoiseFieldGraphV1 {
  return { version: 1, id, name, description, nodes, edges };
}

function node(id: string, type: NoiseGraphNodeTypeV1, x: number, y: number, params: Record<string, number | string | boolean> = {}) {
  return {
    id,
    type,
    label: undefined,
    position: { x, y },
    params
  };
}

function edge(fromNode: ReturnType<typeof node>, fromPort: string, toNode: ReturnType<typeof node>, toPort: string) {
  return {
    id: `edge-${fromNode.id}-${fromPort}-${toNode.id}-${toPort}`,
    from: { nodeId: fromNode.id, portId: fromPort },
    to: { nodeId: toNode.id, portId: toPort }
  };
}
