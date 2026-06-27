import type { NoiseFieldGraphV1, NoiseGraphNodeTypeV1 } from './types';

export function createDefaultNoiseFieldLibrary(): NoiseFieldGraphV1[] {
  return [
    plainsPreset(),
    rollingHillsPreset(),
    dunesPreset(),
    mediumMountainsPreset(),
    himalayasPreset(),
    canyonPreset()
  ];
}

function plainsPreset(): NoiseFieldGraphV1 {
  const position = node('plains-position', 'cartesianPosition', 60, 140);
  const broad = node('plains-broad', 'fbm2d', 295, 80, { frequency: 0.00008, octaves: 3, lacunarity: 2, gain: 0.45, seed: 31, skewX: 1, skewY: 1, rangeMin: -1, rangeMax: 1 });
  const broadWeight = node('plains-broad-weight', 'constFloat', 295, 205, { value: 0.55 });
  const broadScaled = node('plains-broad-scaled', 'multiply', 515, 105);
  const texture = node('plains-texture', 'fbm2d', 295, 355, { frequency: 0.00065, octaves: 3, lacunarity: 2.1, gain: 0.35, seed: 37, skewX: 1, skewY: 1, rangeMin: -1, rangeMax: 1 });
  const textureWeight = node('plains-texture-weight', 'constFloat', 295, 480, { value: 0.1 });
  const textureScaled = node('plains-texture-scaled', 'multiply', 515, 380);
  const sum = node('plains-sum', 'add', 735, 225);
  const output = node('plains-output', 'output', 940, 225);
  return graph('preset-plains', 'Plains', 'Very low relief with broad 10k-foot swells and faint thousand-foot surface texture.', [
    position,
    broad,
    broadWeight,
    broadScaled,
    texture,
    textureWeight,
    textureScaled,
    sum,
    output
  ], [
    edge(position, 'xy', broad, 'xy'),
    edge(position, 'xy', texture, 'xy'),
    edge(broad, 'value', broadScaled, 'a'),
    edge(broadWeight, 'value', broadScaled, 'b'),
    edge(texture, 'value', textureScaled, 'a'),
    edge(textureWeight, 'value', textureScaled, 'b'),
    edge(broadScaled, 'value', sum, 'a'),
    edge(textureScaled, 'value', sum, 'b'),
    edge(sum, 'value', output, 'value')
  ]);
}

function rollingHillsPreset(): NoiseFieldGraphV1 {
  const position = node('rolling-position', 'cartesianPosition', 60, 140);
  const fbm = node('rolling-fbm', 'fbm2d', 300, 105, { frequency: 0.00038, octaves: 5, lacunarity: 2, gain: 0.5, seed: 71, rangeMin: -1, rangeMax: 1 });
  const output = node('rolling-output', 'output', 540, 130);
  return graph('preset-rolling-hills', 'Rolling Hills', 'Low rounded terrain undulations.', [position, fbm, output], [
    edge(position, 'xy', fbm, 'xy'),
    edge(fbm, 'value', output, 'value')
  ]);
}

function dunesPreset(): NoiseFieldGraphV1 {
  const position = node('dunes-position', 'cartesianPosition', 60, 140);
  const duneBands = node('dunes-bands', 'ridged2d', 295, 95, { frequency: 0.0033, octaves: 4, lacunarity: 1.75, gain: 0.42, seed: 143, skewX: 2.6, skewY: 0.55, rangeMin: -1, rangeMax: 1 });
  const bandWeight = node('dunes-band-weight', 'constFloat', 295, 220, { value: 0.72 });
  const bandsScaled = node('dunes-bands-scaled', 'multiply', 515, 120);
  const drift = node('dunes-drift', 'fbm2d', 295, 370, { frequency: 0.00035, octaves: 4, lacunarity: 2, gain: 0.48, seed: 149, skewX: 1.8, skewY: 0.8, rangeMin: -1, rangeMax: 1 });
  const driftWeight = node('dunes-drift-weight', 'constFloat', 295, 495, { value: 0.28 });
  const driftScaled = node('dunes-drift-scaled', 'multiply', 515, 395);
  const sum = node('dunes-sum', 'add', 735, 245);
  const output = node('dunes-output', 'output', 940, 245);
  return graph('preset-dunes', 'Dunes', 'Wind-stretched dune bands with 150-800 foot wavelengths and gentle drift variation.', [
    position,
    duneBands,
    bandWeight,
    bandsScaled,
    drift,
    driftWeight,
    driftScaled,
    sum,
    output
  ], [
    edge(position, 'xy', duneBands, 'xy'),
    edge(position, 'xy', drift, 'xy'),
    edge(duneBands, 'value', bandsScaled, 'a'),
    edge(bandWeight, 'value', bandsScaled, 'b'),
    edge(drift, 'value', driftScaled, 'a'),
    edge(driftWeight, 'value', driftScaled, 'b'),
    edge(bandsScaled, 'value', sum, 'a'),
    edge(driftScaled, 'value', sum, 'b'),
    edge(sum, 'value', output, 'value')
  ]);
}

function mediumMountainsPreset(): NoiseFieldGraphV1 {
  const position = node('mountains-position', 'cartesianPosition', 60, 140);
  const ridge = node('mountains-ridge', 'ridged2d', 295, 70, { frequency: 0.00065, octaves: 5, lacunarity: 1.9, gain: 0.42, seed: 219, rangeMin: 0, rangeMax: 1 });
  const mask = node('mountains-mask', 'fbm2d', 295, 245, { frequency: 0.00018, octaves: 4, lacunarity: 2, gain: 0.48, seed: 220, rangeMin: 0.38, rangeMax: 1 });
  const multiply = node('mountains-multiply', 'multiply', 530, 135);
  const power = node('mountains-power', 'power', 720, 135, { exponent: 1.08 });
  const output = node('mountains-output', 'output', 910, 135);
  return graph('preset-mountains', 'Medium Mountains', 'Broad mountain ranges with multi-thousand-foot massing and roughly 1,500-foot ridge structure.', [position, ridge, mask, multiply, power, output], [
    edge(position, 'xy', ridge, 'xy'),
    edge(position, 'xy', mask, 'xy'),
    edge(ridge, 'value', multiply, 'a'),
    edge(mask, 'value', multiply, 'b'),
    edge(multiply, 'value', power, 'in'),
    edge(power, 'value', output, 'value')
  ]);
}

function himalayasPreset(): NoiseFieldGraphV1 {
  const position = node('himalayas-position', 'cartesianPosition', 60, 140);
  const massif = node('himalayas-massif', 'fbm2d', 295, 55, { frequency: 0.00014, octaves: 4, lacunarity: 1.95, gain: 0.5, seed: 401, skewX: 1.35, skewY: 0.9, rangeMin: 0.32, rangeMax: 1 });
  const ridges = node('himalayas-ridges', 'ridged2d', 295, 235, { frequency: 0.0009, octaves: 6, lacunarity: 1.9, gain: 0.4, seed: 409, skewX: 1.15, skewY: 0.85, rangeMin: 0, rangeMax: 1 });
  const multiply = node('himalayas-multiply', 'multiply', 535, 150);
  const power = node('himalayas-power', 'power', 735, 150, { exponent: 1.22 });
  const detail = node('himalayas-detail', 'fbm2d', 535, 390, { frequency: 0.0018, octaves: 3, lacunarity: 2.1, gain: 0.34, seed: 419, skewX: 1, skewY: 1, rangeMin: -1, rangeMax: 1 });
  const detailWeight = node('himalayas-detail-weight', 'constFloat', 735, 500, { value: 0.055 });
  const detailScaled = node('himalayas-detail-scaled', 'multiply', 935, 405);
  const sum = node('himalayas-sum', 'add', 1135, 245);
  const clampNode = node('himalayas-clamp', 'clamp', 1335, 245, { min: 0, max: 1 });
  const output = node('himalayas-output', 'output', 1535, 245);
  return graph('preset-himalayas', 'Himalayas', 'Tall ridged ranges with mile-scale massifs, thousand-foot ridge structure, and restrained sharp detail.', [
    position,
    massif,
    ridges,
    multiply,
    power,
    detail,
    detailWeight,
    detailScaled,
    sum,
    clampNode,
    output
  ], [
    edge(position, 'xy', massif, 'xy'),
    edge(position, 'xy', ridges, 'xy'),
    edge(position, 'xy', detail, 'xy'),
    edge(massif, 'value', multiply, 'a'),
    edge(ridges, 'value', multiply, 'b'),
    edge(multiply, 'value', power, 'in'),
    edge(detail, 'value', detailScaled, 'a'),
    edge(detailWeight, 'value', detailScaled, 'b'),
    edge(power, 'value', sum, 'a'),
    edge(detailScaled, 'value', sum, 'b'),
    edge(sum, 'value', clampNode, 'in'),
    edge(clampNode, 'value', output, 'value')
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
