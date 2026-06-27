<script lang="ts">
  import { onMount } from 'svelte';
  import { Redo2, Save, Search, Trash2, Undo2, X } from '@lucide/svelte';
  import { NOISE_GRAPH_NODE_DEFINITIONS, canConnectPorts, connectPorts, createNoiseGraphNode, deleteGraphSelection, validateNoiseGraph, type NoiseFieldGraphV1, type NoiseGraphNodeTypeV1, type NoiseGraphNodeV1, type NoiseGraphPortRefV1 } from '.';
  import NumericInput from '../ui/NumericInput.svelte';

  export let graph: NoiseFieldGraphV1;
  export let onSave: (graph: NoiseFieldGraphV1) => void = () => {};
  export let onCancel: () => void = () => {};

  const nodeWidth = 178;
  const nodeHeader = 32;
  const portStep = 24;
  const portRadius = 6;
  const maxHistoryEntries = 80;

  let canvas: HTMLCanvasElement;
  let wrapper: HTMLDivElement;
  let modal: HTMLDivElement;
  let working: NoiseFieldGraphV1 = structuredClone(graph);
  let query = '';
  let selectedNodeId: string | null = null;
  let selectedEdgeId: string | null = null;
  let dragNode: { nodeId: string; dx: number; dy: number } | null = null;
  let dragStartGraph: NoiseFieldGraphV1 | null = null;
  let dragMoved = false;
  let dragPort: { ref: NoiseGraphPortRefV1; x: number; y: number; validTarget: NoiseGraphPortRefV1 | null } | null = null;
  let panDrag: { pointerId: number; x: number; y: number } | null = null;
  let pointer = { x: 0, y: 0 };
  let viewport = { x: 0, y: 0, zoom: 1 };
  let undoStack: NoiseFieldGraphV1[] = [];
  let redoStack: NoiseFieldGraphV1[] = [];

  $: selectedNode = working.nodes.find((node) => node.id === selectedNodeId) ?? null;
  $: issues = validateNoiseGraph(working);
  $: filteredDefinitions = Object.values(NOISE_GRAPH_NODE_DEFINITIONS)
    .filter((definition) => definition.type !== 'output')
    .filter((definition) => `${definition.label} ${definition.category} ${definition.type}`.toLowerCase().includes(query.toLowerCase()));

  onMount(() => {
    modal?.focus();
    draw();
  });

  $: if (canvas && working) draw();

  function draw() {
    const context = canvas?.getContext('2d');
    if (!context || !wrapper) return;
    const rect = wrapper.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, rect.width, rect.height);
    drawGrid(context, rect.width, rect.height);
    context.save();
    context.translate(viewport.x, viewport.y);
    context.scale(viewport.zoom, viewport.zoom);
    for (const edge of working.edges) {
      const from = portPosition(edge.from);
      const to = portPosition(edge.to);
      if (!from || !to) continue;
      drawSpline(context, from.x, from.y, to.x, to.y, edge.id === selectedEdgeId ? '#8bd59c' : '#6c8990', 3);
    }
    if (dragPort) {
      const start = portPosition(dragPort.ref);
      if (start) drawSpline(context, start.x, start.y, pointer.x, pointer.y, dragPort.validTarget ? '#8bd59c' : '#d4b26f', 2);
    }
    for (const node of working.nodes) drawNode(context, node);
    context.restore();
  }

  function drawGrid(context: CanvasRenderingContext2D, width: number, height: number) {
    context.strokeStyle = 'rgba(196, 215, 221, 0.08)';
    context.lineWidth = 1;
    const spacing = 32 * viewport.zoom;
    const offsetX = modulo(viewport.x, spacing);
    const offsetY = modulo(viewport.y, spacing);
    for (let x = offsetX; x < width; x += spacing) {
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x, height);
      context.stroke();
    }
    for (let y = offsetY; y < height; y += spacing) {
      context.beginPath();
      context.moveTo(0, y);
      context.lineTo(width, y);
      context.stroke();
    }
  }

  function drawNode(context: CanvasRenderingContext2D, node: NoiseGraphNodeV1) {
    const definition = NOISE_GRAPH_NODE_DEFINITIONS[node.type];
    const height = nodeHeight(node);
    context.fillStyle = node.id === selectedNodeId ? 'rgba(32, 65, 50, 0.96)' : 'rgba(14, 22, 28, 0.94)';
    context.strokeStyle = node.id === selectedNodeId ? 'rgba(139, 213, 156, 0.9)' : 'rgba(196, 215, 221, 0.24)';
    roundRect(context, node.position.x, node.position.y, nodeWidth, height, 8);
    context.fill();
    context.stroke();
    context.fillStyle = 'rgba(255, 255, 255, 0.06)';
    roundRect(context, node.position.x, node.position.y, nodeWidth, nodeHeader, 8);
    context.fill();
    context.fillStyle = '#f2f7f9';
    context.font = '700 13px Inter, system-ui, sans-serif';
    context.fillText(node.label || definition.label, node.position.x + 12, node.position.y + 21);
    context.font = '12px Inter, system-ui, sans-serif';
    for (const [index, port] of definition.inputs.entries()) {
      const y = node.position.y + nodeHeader + 16 + index * portStep;
      context.fillStyle = '#9fc4de';
      circle(context, node.position.x, y, portRadius);
      context.fill();
      context.fillStyle = '#bdcbd0';
      context.fillText(port.label, node.position.x + 12, y + 4);
    }
    for (const [index, port] of definition.outputs.entries()) {
      const y = node.position.y + nodeHeader + 16 + index * portStep;
      context.fillStyle = '#d5b56d';
      circle(context, node.position.x + nodeWidth, y, portRadius);
      context.fill();
      const textWidth = context.measureText(port.label).width;
      context.fillStyle = '#bdcbd0';
      context.fillText(port.label, node.position.x + nodeWidth - textWidth - 12, y + 4);
    }
  }

  function handlePointerDown(event: PointerEvent) {
    if (event.button === 2) {
      event.preventDefault();
      panDrag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
      canvas.setPointerCapture(event.pointerId);
      return;
    }
    if (event.button !== 0) return;
    const point = localPoint(event);
    const port = hitPort(point.x, point.y);
    if (port) {
      dragPort = { ref: port, x: point.x, y: point.y, validTarget: null };
      selectedNodeId = port.nodeId;
      selectedEdgeId = null;
      canvas.setPointerCapture(event.pointerId);
      draw();
      return;
    }
    const edge = hitEdge(point.x, point.y);
    if (edge) {
      selectedEdgeId = edge.id;
      selectedNodeId = null;
      draw();
      return;
    }
    const node = hitNode(point.x, point.y);
    if (node) {
      selectedNodeId = node.id;
      selectedEdgeId = null;
      dragNode = { nodeId: node.id, dx: point.x - node.position.x, dy: point.y - node.position.y };
      dragStartGraph = cloneGraph(working);
      dragMoved = false;
      canvas.setPointerCapture(event.pointerId);
      draw();
      return;
    }
    selectedNodeId = null;
    selectedEdgeId = null;
    draw();
  }

  function handlePointerMove(event: PointerEvent) {
    if (panDrag) {
      viewport = {
        ...viewport,
        x: viewport.x + event.clientX - panDrag.x,
        y: viewport.y + event.clientY - panDrag.y
      };
      panDrag = { ...panDrag, x: event.clientX, y: event.clientY };
      draw();
      return;
    }
    const point = localPoint(event);
    pointer = point;
    if (dragNode) {
      const nextX = point.x - dragNode.dx;
      const nextY = point.y - dragNode.dy;
      const draggedNode = working.nodes.find((node) => node.id === dragNode?.nodeId);
      if (draggedNode && (draggedNode.position.x !== nextX || draggedNode.position.y !== nextY)) dragMoved = true;
      working = {
        ...working,
        nodes: working.nodes.map((node) => node.id === dragNode?.nodeId ? { ...node, position: { x: nextX, y: nextY } } : node)
      };
      draw();
      return;
    }
    if (dragPort) {
      const target = hitPort(point.x, point.y);
      dragPort.validTarget = target && canConnectPorts(working, dragPort.ref, target) ? target : null;
      draw();
    }
  }

  function handlePointerUp(event: PointerEvent) {
    if (panDrag?.pointerId === event.pointerId) {
      panDrag = null;
      canvas.releasePointerCapture(event.pointerId);
      return;
    }
    const completedNodeDrag = dragNode && dragMoved && dragStartGraph;
    if (dragPort?.validTarget) {
      const next = connectPorts(working, dragPort.ref, dragPort.validTarget);
      if (next) commitGraph(next);
    }
    dragNode = null;
    if (completedNodeDrag && dragStartGraph) pushUndo(dragStartGraph);
    dragStartGraph = null;
    dragMoved = false;
    dragPort = null;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    draw();
  }

  function handleWheel(event: WheelEvent) {
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const screen = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const before = screenToGraph(screen.x, screen.y);
    const zoom = Math.max(0.35, Math.min(2.75, viewport.zoom * Math.exp(-event.deltaY * 0.001)));
    viewport = {
      x: screen.x - before.x * zoom,
      y: screen.y - before.y * zoom,
      zoom
    };
    draw();
  }

  function addNode(type: NoiseGraphNodeTypeV1) {
    const count = working.nodes.length;
    const rect = wrapper?.getBoundingClientRect();
    const center = rect ? screenToGraph(rect.width / 2, rect.height / 2) : { x: 220, y: 120 };
    const node = createNoiseGraphNode(type, { x: center.x - nodeWidth / 2 + (count % 3) * 24, y: center.y - 40 + (count % 3) * 18 });
    commitGraph({ ...working, nodes: [...working.nodes, node] });
    selectedNodeId = node.id;
    selectedEdgeId = null;
    draw();
  }

  function updateNodeParam(key: string, value: string) {
    if (!selectedNode) return;
    const original = selectedNode.params[key];
    const nextValue = typeof original === 'number' ? Number(value) : value;
    setNodeParam(key, nextValue);
  }

  function setNodeParam(key: string, value: number | string | boolean) {
    if (!selectedNode) return;
    commitGraph({
      ...working,
      nodes: working.nodes.map((node) => node.id === selectedNode.id ? { ...node, params: { ...node.params, [key]: value } } : node)
    });
  }

  function updateGraphName(value: string) {
    working = { ...working, name: value };
  }

  function cloneGraph(graphToClone: NoiseFieldGraphV1) {
    return structuredClone(graphToClone);
  }

  function pushUndo(snapshot: NoiseFieldGraphV1) {
    undoStack = [...undoStack, cloneGraph(snapshot)].slice(-maxHistoryEntries);
    redoStack = [];
  }

  function commitGraph(next: NoiseFieldGraphV1, snapshot: NoiseFieldGraphV1 = working) {
    pushUndo(snapshot);
    working = next;
    reconcileSelection();
    draw();
  }

  function undoGraph() {
    const previous = undoStack.at(-1);
    if (!previous) return;
    undoStack = undoStack.slice(0, -1);
    redoStack = [...redoStack, cloneGraph(working)].slice(-maxHistoryEntries);
    working = cloneGraph(previous);
    reconcileSelection();
    draw();
  }

  function redoGraph() {
    const next = redoStack.at(-1);
    if (!next) return;
    redoStack = redoStack.slice(0, -1);
    undoStack = [...undoStack, cloneGraph(working)].slice(-maxHistoryEntries);
    working = cloneGraph(next);
    reconcileSelection();
    draw();
  }

  function deleteSelection() {
    const next = deleteGraphSelection(working, { nodeId: selectedNodeId ?? undefined, edgeId: selectedEdgeId ?? undefined });
    if (next === working) return;
    commitGraph(next);
    selectedNodeId = null;
    selectedEdgeId = null;
    draw();
  }

  function deleteNode(nodeId: string) {
    const next = deleteGraphSelection(working, { nodeId });
    if (next === working) return;
    commitGraph(next);
    selectedNodeId = null;
    selectedEdgeId = null;
    draw();
  }

  function deleteEdge(edgeId: string) {
    const next = deleteGraphSelection(working, { edgeId });
    if (next === working) return;
    commitGraph(next);
    selectedEdgeId = null;
    draw();
  }

  function reconcileSelection() {
    if (selectedNodeId && !working.nodes.some((node) => node.id === selectedNodeId)) selectedNodeId = null;
    if (selectedEdgeId && !working.edges.some((edge) => edge.id === selectedEdgeId)) selectedEdgeId = null;
  }

  function hitNode(x: number, y: number): NoiseGraphNodeV1 | null {
    for (let i = working.nodes.length - 1; i >= 0; i -= 1) {
      const node = working.nodes[i];
      if (x >= node.position.x && x <= node.position.x + nodeWidth && y >= node.position.y && y <= node.position.y + nodeHeight(node)) return node;
    }
    return null;
  }

  function hitPort(x: number, y: number): NoiseGraphPortRefV1 | null {
    for (const node of working.nodes) {
      const definition = NOISE_GRAPH_NODE_DEFINITIONS[node.type];
      for (const [index, port] of definition.inputs.entries()) {
        const px = node.position.x;
        const py = node.position.y + nodeHeader + 16 + index * portStep;
        if (Math.hypot(x - px, y - py) <= 10) return { nodeId: node.id, portId: port.id };
      }
      for (const [index, port] of definition.outputs.entries()) {
        const px = node.position.x + nodeWidth;
        const py = node.position.y + nodeHeader + 16 + index * portStep;
        if (Math.hypot(x - px, y - py) <= 10) return { nodeId: node.id, portId: port.id };
      }
    }
    return null;
  }

  function hitEdge(x: number, y: number) {
    return working.edges.find((edge) => {
      const from = portPosition(edge.from);
      const to = portPosition(edge.to);
      if (!from || !to) return false;
      return distanceToSegment(x, y, from.x, from.y, to.x, to.y) < 8;
    }) ?? null;
  }

  function portPosition(ref: NoiseGraphPortRefV1): { x: number; y: number } | null {
    const node = working.nodes.find((item) => item.id === ref.nodeId);
    if (!node) return null;
    const definition = NOISE_GRAPH_NODE_DEFINITIONS[node.type];
    const inputIndex = definition.inputs.findIndex((port) => port.id === ref.portId);
    if (inputIndex >= 0) return { x: node.position.x, y: node.position.y + nodeHeader + 16 + inputIndex * portStep };
    const outputIndex = definition.outputs.findIndex((port) => port.id === ref.portId);
    if (outputIndex >= 0) return { x: node.position.x + nodeWidth, y: node.position.y + nodeHeader + 16 + outputIndex * portStep };
    return null;
  }

  function nodeHeight(node: NoiseGraphNodeV1) {
    const definition = NOISE_GRAPH_NODE_DEFINITIONS[node.type];
    return Math.max(82, nodeHeader + 32 + Math.max(definition.inputs.length, definition.outputs.length) * portStep);
  }

  function localPoint(event: PointerEvent) {
    const rect = canvas.getBoundingClientRect();
    return screenToGraph(event.clientX - rect.left, event.clientY - rect.top);
  }

  function screenToGraph(x: number, y: number) {
    return {
      x: (x - viewport.x) / viewport.zoom,
      y: (y - viewport.y) / viewport.zoom
    };
  }

  function modulo(value: number, divisor: number) {
    return ((value % divisor) + divisor) % divisor;
  }

  function isTextInput(target: EventTarget | null) {
    const element = target as HTMLElement | null;
    return element?.tagName === 'INPUT' || element?.tagName === 'SELECT' || element?.tagName === 'TEXTAREA';
  }

  function drawSpline(context: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, color: string, width: number) {
    const tension = Math.max(70, Math.abs(x2 - x1) * 0.45);
    context.beginPath();
    context.moveTo(x1, y1);
    context.bezierCurveTo(x1 + tension, y1, x2 - tension, y2, x2, y2);
    context.strokeStyle = color;
    context.lineWidth = width / viewport.zoom;
    context.stroke();
  }

  function roundRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
    context.beginPath();
    context.roundRect(x, y, width, height, radius);
  }

  function circle(context: CanvasRenderingContext2D, x: number, y: number, radius: number) {
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
  }

  function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSq = dx * dx + dy * dy;
    if (lengthSq === 0) return Math.hypot(px - ax, py - ay);
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
    return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
  }

  function stopModalEvent(event: Event) {
    event.stopPropagation();
  }

  function handleModalPointerDown(event: PointerEvent) {
    if (!isTextInput(event.target)) modal?.focus();
    event.stopPropagation();
  }

  function handleModalKeydown(event: KeyboardEvent) {
    event.stopPropagation();
    const isUndo = (event.metaKey || event.ctrlKey) && !event.shiftKey && event.code === 'KeyZ';
    const isRedo = (event.metaKey || event.ctrlKey) && (event.code === 'KeyY' || (event.shiftKey && event.code === 'KeyZ'));
    if (!isTextInput(event.target) && isUndo) {
      event.preventDefault();
      undoGraph();
      return;
    }
    if (!isTextInput(event.target) && isRedo) {
      event.preventDefault();
      redoGraph();
      return;
    }
    if ((event.code === 'Delete' || event.code === 'Backspace') && !isTextInput(event.target)) {
      event.preventDefault();
      deleteSelection();
      return;
    }
    if (event.code === 'Escape') {
      event.preventDefault();
      onCancel();
    }
  }
</script>

<div
  bind:this={modal}
  class="noise-modal"
  role="dialog"
  aria-modal="true"
  tabindex="-1"
  onkeydown={handleModalKeydown}
  onkeyup={stopModalEvent}
  onpointerdown={handleModalPointerDown}
  onpointermove={stopModalEvent}
  onpointerup={stopModalEvent}
  onwheel={stopModalEvent}
  onclick={stopModalEvent}
>
  <div class="noise-editor">
    <aside class="noise-palette">
      <header>
        <strong>Modules</strong>
        <button type="button" title="Close" onclick={onCancel}><X size={16} /></button>
      </header>
      <label class="search-row">
        <Search size={15} />
        <input placeholder="Search nodes" bind:value={query} />
      </label>
      <div class="module-list">
        {#each filteredDefinitions as definition}
          <button type="button" onclick={() => addNode(definition.type)}>
            <span>{definition.label}</span>
            <small>{definition.category}</small>
          </button>
        {/each}
      </div>
    </aside>

    <main class="graph-wrap" bind:this={wrapper}>
      <canvas
        bind:this={canvas}
        aria-label="Noise graph editor"
        onpointerdown={handlePointerDown}
        onpointermove={handlePointerMove}
        onpointerup={handlePointerUp}
        onpointercancel={handlePointerUp}
        oncontextmenu={(event) => event.preventDefault()}
        onwheel={handleWheel}
      ></canvas>
    </main>

    <aside class="noise-inspector">
      <header>
        <input value={working.name} oninput={(event) => updateGraphName(event.currentTarget.value)} />
        <div class="node-editor-actions">
          <button type="button" title="Undo" disabled={undoStack.length === 0} onclick={undoGraph}><Undo2 size={16} /></button>
          <button type="button" title="Redo" disabled={redoStack.length === 0} onclick={redoGraph}><Redo2 size={16} /></button>
          <button type="button" title="Save field" onclick={() => onSave(working)}><Save size={16} /></button>
        </div>
      </header>
      <div class="inspector-scroll">
        {#if issues.length > 0}
          <div class="graph-issues">
            {#each issues as issue}
              <div>{issue.message}</div>
            {/each}
          </div>
        {/if}
        {#if selectedNode}
          <div class="selected-title">
            <strong>{selectedNode.label || NOISE_GRAPH_NODE_DEFINITIONS[selectedNode.type].label}</strong>
            {#if selectedNode.type !== 'output'}
              <button type="button" title="Delete selected node" onclick={() => selectedNode && deleteNode(selectedNode.id)}><Trash2 size={15} /></button>
            {/if}
          </div>
          {#if Object.keys(selectedNode.params).length === 0}
            <div class="empty-params">No editable parameters</div>
          {:else}
            {#each Object.entries(selectedNode.params) as [key, value]}
              <label>
                <span>{key}</span>
                {#if typeof value === 'number'}
                  <NumericInput step="0.001" value={value} onCommit={(next) => setNodeParam(key, next)} />
                {:else}
                  <input type="text" value={value} oninput={(event) => updateNodeParam(key, event.currentTarget.value)} />
                {/if}
              </label>
            {/each}
          {/if}
        {:else if selectedEdgeId}
          <div class="selected-title">
            <strong>Connector</strong>
            <button type="button" title="Delete selected connector" onclick={() => selectedEdgeId && deleteEdge(selectedEdgeId)}><Trash2 size={15} /></button>
          </div>
        {:else}
          <div class="empty-params">Select a node or connector</div>
        {/if}
      </div>
    </aside>
  </div>
</div>
