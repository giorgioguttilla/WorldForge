import { NOISE_GRAPH_NODE_DEFINITIONS, getNodeDefinition } from './definitions';
import type { NoiseFieldGraphV1, NoiseGraphEdgeV1, NoiseGraphNodeTypeV1, NoiseGraphNodeV1, NoiseGraphPortDefinition, NoiseGraphPortRefV1, NoiseGraphValidationIssue } from './types';

export function createNoiseGraph(id: string, name: string): NoiseFieldGraphV1 {
  return {
    version: 1,
    id,
    name,
    nodes: [
      createNoiseGraphNode('cartesianPosition', { x: 60, y: 120 }),
      createNoiseGraphNode('output', { x: 620, y: 140 })
    ],
    edges: []
  };
}

export function createNoiseGraphNode(type: NoiseGraphNodeTypeV1, position = { x: 120, y: 120 }): NoiseGraphNodeV1 {
  const definition = NOISE_GRAPH_NODE_DEFINITIONS[type];
  return {
    id: crypto.randomUUID(),
    type,
    label: definition.label,
    position,
    params: { ...definition.defaultParams }
  };
}

export function normalizeNoiseGraph(value: unknown, fallbackId = crypto.randomUUID(), fallbackName = 'Field'): NoiseFieldGraphV1 {
  if (!isRecord(value)) return createNoiseGraph(fallbackId, fallbackName);
  const nodes = Array.isArray(value.nodes) ? value.nodes.map(normalizeNode).filter((node): node is NoiseGraphNodeV1 => Boolean(node)) : [];
  const edges = Array.isArray(value.edges) ? value.edges.map(normalizeEdge).filter((edge): edge is NoiseGraphEdgeV1 => Boolean(edge)) : [];
  const graph: NoiseFieldGraphV1 = {
    version: 1,
    id: typeof value.id === 'string' && value.id ? value.id : fallbackId,
    name: typeof value.name === 'string' && value.name.trim() ? value.name : fallbackName,
    description: typeof value.description === 'string' ? value.description : undefined,
    nodes,
    edges: []
  };
  if (!graph.nodes.some((node) => node.type === 'output')) {
    graph.nodes.push(createNoiseGraphNode('output', { x: 620, y: 140 }));
  }
  graph.edges = normalizeEdgeDirections({ ...graph, edges });
  return graph;
}

export function validateNoiseGraph(graph: NoiseFieldGraphV1): NoiseGraphValidationIssue[] {
  const issues: NoiseGraphValidationIssue[] = [];
  const outputNodes = graph.nodes.filter((node) => node.type === 'output');
  if (outputNodes.length !== 1) issues.push({ severity: 'error', message: 'A noise graph must have exactly one output node.' });

  const edgeInputTargets = new Set<string>();
  for (const edge of graph.edges) {
    const from = resolvePort(graph, edge.from);
    const to = resolvePort(graph, edge.to);
    if (!from || !to) {
      issues.push({ severity: 'error', message: 'Edge references a missing node or port.', edgeId: edge.id });
      continue;
    }
    if (from.direction !== 'output' || to.direction !== 'input') {
      issues.push({ severity: 'error', message: 'Edges must connect output ports to input ports.', edgeId: edge.id });
    }
    if (from.valueType !== to.valueType) {
      issues.push({ severity: 'error', message: `Cannot connect ${from.valueType} to ${to.valueType}.`, edgeId: edge.id });
    }
    const inputKey = `${edge.to.nodeId}:${edge.to.portId}`;
    if (edgeInputTargets.has(inputKey)) {
      issues.push({ severity: 'error', message: 'An input port can only have one incoming edge.', edgeId: edge.id });
    }
    edgeInputTargets.add(inputKey);
  }
  return issues;
}

export function canConnectPorts(graph: NoiseFieldGraphV1, a: NoiseGraphPortRefV1, b: NoiseGraphPortRefV1): boolean {
  if (a.nodeId === b.nodeId) return false;
  const first = resolvePort(graph, a);
  const second = resolvePort(graph, b);
  if (!first || !second) return false;
  if (first.direction === second.direction) return false;
  return first.valueType === second.valueType;
}

export function connectPorts(graph: NoiseFieldGraphV1, a: NoiseGraphPortRefV1, b: NoiseGraphPortRefV1): NoiseFieldGraphV1 | null {
  if (!canConnectPorts(graph, a, b)) return null;
  const from = resolvePort(graph, a)?.direction === 'output' ? a : b;
  const to = from === a ? b : a;
  return {
    ...graph,
    edges: [
      ...graph.edges.filter((edge) => !(edge.to.nodeId === to.nodeId && edge.to.portId === to.portId)),
      { id: crypto.randomUUID(), from, to }
    ]
  };
}

export function deleteGraphSelection(graph: NoiseFieldGraphV1, selection: { nodeId?: string; edgeId?: string }): NoiseFieldGraphV1 {
  if (selection.edgeId) {
    return { ...graph, edges: graph.edges.filter((edge) => edge.id !== selection.edgeId) };
  }
  if (selection.nodeId) {
    const node = graph.nodes.find((item) => item.id === selection.nodeId);
    if (!node || node.type === 'output') return graph;
    return {
      ...graph,
      nodes: graph.nodes.filter((item) => item.id !== selection.nodeId),
      edges: graph.edges.filter((edge) => edge.from.nodeId !== selection.nodeId && edge.to.nodeId !== selection.nodeId)
    };
  }
  return graph;
}

export function resolvePort(graph: NoiseFieldGraphV1, ref: NoiseGraphPortRefV1): NoiseGraphPortDefinition | null {
  const node = graph.nodes.find((item) => item.id === ref.nodeId);
  if (!node) return null;
  const definition = getNodeDefinition(node.type);
  if (!definition) return null;
  return [...definition.inputs, ...definition.outputs].find((port) => port.id === ref.portId) ?? null;
}

function normalizeNode(value: unknown): NoiseGraphNodeV1 | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null;
  const definition = getNodeDefinition(value.type);
  if (!definition) return null;
  const params = isRecord(value.params) ? value.params : {};
  return {
    id: typeof value.id === 'string' && value.id ? value.id : crypto.randomUUID(),
    type: definition.type,
    label: typeof value.label === 'string' ? value.label : definition.label,
    position: normalizePosition(value.position),
    params: { ...definition.defaultParams, ...params }
  };
}

function normalizeEdge(value: unknown): NoiseGraphEdgeV1 | null {
  if (!isRecord(value) || !isRecord(value.from) || !isRecord(value.to)) return null;
  if (typeof value.from.nodeId !== 'string' || typeof value.from.portId !== 'string') return null;
  if (typeof value.to.nodeId !== 'string' || typeof value.to.portId !== 'string') return null;
  return {
    id: typeof value.id === 'string' && value.id ? value.id : crypto.randomUUID(),
    from: { nodeId: value.from.nodeId, portId: value.from.portId },
    to: { nodeId: value.to.nodeId, portId: value.to.portId }
  };
}

function normalizeEdgeDirections(graph: NoiseFieldGraphV1): NoiseGraphEdgeV1[] {
  return graph.edges
    .map((edge) => {
      const from = resolvePort(graph, edge.from);
      const to = resolvePort(graph, edge.to);
      if (!from || !to) return null;
      if (from.direction === 'input' && to.direction === 'output') return { ...edge, from: edge.to, to: edge.from };
      return edge;
    })
    .filter((edge): edge is NoiseGraphEdgeV1 => Boolean(edge));
}

function normalizePosition(value: unknown): { x: number; y: number } {
  if (!isRecord(value)) return { x: 120, y: 120 };
  return { x: finiteNumber(value.x, 120), y: finiteNumber(value.y, 120) };
}

function finiteNumber(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
