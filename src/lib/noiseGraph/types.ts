export type GraphValueType = 'float' | 'vec2';
export type PortDirection = 'input' | 'output';

export type NoiseGraphNodeTypeV1 =
  | 'output'
  | 'constFloat'
  | 'cartesianPosition'
  | 'splinePosition'
  | 'simplex2d'
  | 'fbm2d'
  | 'ridged2d'
  | 'add'
  | 'subtract'
  | 'multiply'
  | 'divide'
  | 'clamp'
  | 'power'
  | 'smoothstep';

export interface GraphVec2 {
  x: number;
  y: number;
}

export interface NoiseGraphPortDefinition {
  id: string;
  label: string;
  direction: PortDirection;
  valueType: GraphValueType;
}

export interface NoiseGraphNodeDefinition {
  type: NoiseGraphNodeTypeV1;
  label: string;
  category: 'Inputs' | 'Noise' | 'Math' | 'Output';
  inputs: NoiseGraphPortDefinition[];
  outputs: NoiseGraphPortDefinition[];
  defaultParams: Record<string, number | string | boolean>;
}

export interface NoiseGraphPortRefV1 {
  nodeId: string;
  portId: string;
}

export interface NoiseGraphEdgeV1 {
  id: string;
  from: NoiseGraphPortRefV1;
  to: NoiseGraphPortRefV1;
}

export interface NoiseGraphNodeV1 {
  id: string;
  type: NoiseGraphNodeTypeV1;
  label?: string;
  position: GraphVec2;
  params: Record<string, number | string | boolean>;
}

export interface NoiseFieldGraphV1 {
  version: 1;
  id: string;
  name: string;
  description?: string;
  nodes: NoiseGraphNodeV1[];
  edges: NoiseGraphEdgeV1[];
}

export interface NoiseFieldEvaluationContext {
  cartesian: GraphVec2;
  spline: GraphVec2;
}

export interface NoiseGraphValidationIssue {
  severity: 'error' | 'warning';
  message: string;
  nodeId?: string;
  edgeId?: string;
}
