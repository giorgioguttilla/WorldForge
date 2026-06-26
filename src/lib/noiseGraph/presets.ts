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
  const position = node('canyon-position', 'cartesianPosition', 60, 140);
  const mainIncision = node('canyon-main-incision', 'ridged2d', 285, 110, { frequency: 0.0005, octaves: 5, lacunarity: 1.88, gain: 0.46, seed: 341, skewX: 1, skewY: 1, rangeMin: 0, rangeMax: 1 });
  const mainThreshold = node('canyon-main-threshold', 'smoothstep', 505, 120, { edge0: 0.62, edge1: 0.96 });
  const mainTerraces = node('canyon-main-terraces', 'terrace', 725, 130, { steps: 11, softness: 0.44 });
  const mainWeight = node('canyon-main-weight', 'constFloat', 725, 235, { value: 0.88 });
  const mainCarve = node('canyon-main-carve', 'multiply', 925, 145);
  const tributaries = node('canyon-tributary-incision', 'ridged2d', 285, 360, { frequency: 0.00115, octaves: 4, lacunarity: 2.08, gain: 0.38, seed: 547, skewX: 1, skewY: 1, rangeMin: 0, rangeMax: 1 });
  const tributaryThreshold = node('canyon-tributary-threshold', 'smoothstep', 505, 370, { edge0: 0.7, edge1: 0.98 });
  const tributaryPower = node('canyon-tributary-power', 'power', 725, 380, { exponent: 1.35 });
  const tributaryWeight = node('canyon-tributary-weight', 'constFloat', 725, 485, { value: 0.22 });
  const tributaryCarve = node('canyon-tributary-carve', 'multiply', 925, 395);
  const sediment = node('canyon-sediment-roughness', 'fbm2d', 285, 610, { frequency: 0.0044, octaves: 4, lacunarity: 2.05, gain: 0.42, seed: 811, skewX: 1, skewY: 1, rangeMin: 0, rangeMax: 1 });
  const sedimentWeight = node('canyon-sediment-weight', 'constFloat', 505, 715, { value: 0.055 });
  const sedimentDetail = node('canyon-sediment-detail', 'multiply', 725, 625);
  const weathering = node('canyon-weathering-noise', 'fbm2d', 285, 850, { frequency: 0.018, octaves: 3, lacunarity: 2.25, gain: 0.36, seed: 1217, skewX: 1, skewY: 1, rangeMin: -1, rangeMax: 1 });
  const weatheringWeight = node('canyon-weathering-weight', 'constFloat', 505, 955, { value: 0.025 });
  const weatheringDetail = node('canyon-weathering-detail', 'multiply', 725, 865);
  const sumMainTributary = node('canyon-sum-main-tributary', 'add', 1135, 220);
  const incisionMask = node('canyon-incision-mask', 'smoothstep', 1335, 230, { edge0: 0.06, edge1: 0.42 });
  const maskedSediment = node('canyon-masked-sediment', 'multiply', 925, 610);
  const sumSediment = node('canyon-sum-sediment', 'add', 1535, 345);
  const sumAll = node('canyon-sum-all', 'add', 1735, 470);
  const clampNode = node('canyon-clamp', 'clamp', 1935, 480, { min: 0, max: 0.96 });
  const scale = node('canyon-scale', 'constFloat', 1935, 585, { value: -1 });
  const carve = node('canyon-carve', 'multiply', 2135, 490);
  const output = node('canyon-output', 'output', 2335, 500);
  return graph('preset-canyon', 'Canyon', 'Thresholded canyon incision with clear plateau, softened strata, tributary cuts, and subtle sediment detail.', [
    position,
    mainIncision,
    mainThreshold,
    mainTerraces,
    mainWeight,
    mainCarve,
    tributaries,
    tributaryThreshold,
    tributaryPower,
    tributaryWeight,
    tributaryCarve,
    sediment,
    sedimentWeight,
    sedimentDetail,
    weathering,
    weatheringWeight,
    weatheringDetail,
    sumMainTributary,
    incisionMask,
    maskedSediment,
    sumSediment,
    sumAll,
    clampNode,
    scale,
    carve,
    output
  ], [
    edge(position, 'xy', mainIncision, 'xy'),
    edge(position, 'xy', tributaries, 'xy'),
    edge(position, 'xy', sediment, 'xy'),
    edge(position, 'xy', weathering, 'xy'),
    edge(mainIncision, 'value', mainThreshold, 'in'),
    edge(mainThreshold, 'value', mainTerraces, 'in'),
    edge(mainTerraces, 'value', mainCarve, 'a'),
    edge(mainWeight, 'value', mainCarve, 'b'),
    edge(tributaries, 'value', tributaryThreshold, 'in'),
    edge(tributaryThreshold, 'value', tributaryPower, 'in'),
    edge(tributaryPower, 'value', tributaryCarve, 'a'),
    edge(tributaryWeight, 'value', tributaryCarve, 'b'),
    edge(sediment, 'value', sedimentDetail, 'a'),
    edge(sedimentWeight, 'value', sedimentDetail, 'b'),
    edge(weathering, 'value', weatheringDetail, 'a'),
    edge(weatheringWeight, 'value', weatheringDetail, 'b'),
    edge(mainCarve, 'value', sumMainTributary, 'a'),
    edge(tributaryCarve, 'value', sumMainTributary, 'b'),
    edge(sumMainTributary, 'value', incisionMask, 'in'),
    edge(sedimentDetail, 'value', maskedSediment, 'a'),
    edge(incisionMask, 'value', maskedSediment, 'b'),
    edge(sumMainTributary, 'value', sumSediment, 'a'),
    edge(maskedSediment, 'value', sumSediment, 'b'),
    edge(sumSediment, 'value', sumAll, 'a'),
    edge(weatheringDetail, 'value', sumAll, 'b'),
    edge(sumAll, 'value', clampNode, 'in'),
    edge(clampNode, 'value', carve, 'a'),
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
