<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { CircleDot, CirclePlus, Crosshair, Download, Edit3, Eye, EyeOff, FolderOpen, Grid3X3, Hammer, Map, Mountain, MousePointer2, Navigation, Paintbrush, Palette, Plus, Redo2, Route, Settings, Trash2, Undo2, UserRound } from '@lucide/svelte';
  import { DEFAULT_WORLD_INPUT, getWorldAreaSquareMiles, validateWorldConfig, type WorldConfigInput } from './lib/heightmap/worldConfig';
  import { TileManager, type BulkProgress, type EditorMetrics } from './lib/heightmap/tileManager';
  import { EditorViewport, type AuthoringPointerPoint, type HoverCoordinates } from './lib/render/editorViewport';
  import type { ViewMode } from './lib/render/cameraController';
  import type { VisualizationMode } from './lib/render/terrainRenderer';
  import { createAnchor, createEmptyAuthoringDocument, createLandformArea, createMountainSpline, type AnchorV1, type AuthoringDocumentV1, type LandformModeV1, type PrimitiveV1 } from './lib/authoring/authoringDocument';
  import { distanceToSpline, pointInSplinePolygon } from './lib/authoring/geometry';
  import { sampleSplineAnchorsWithSegments } from './lib/authoring/spline';
  import NoiseGraphEditor from './lib/noiseGraph/NoiseGraphEditor.svelte';
  import { createNoiseGraph, type NoiseFieldGraphV1 } from './lib/noiseGraph';

  type AuthoringTool = 'select' | 'addPoint' | 'landformArea' | 'mountainSpline';

  let container: HTMLDivElement;
  let canvas: HTMLCanvasElement;
  let viewport: EditorViewport | null = null;
  const manager = new TileManager();

  let worldInput: WorldConfigInput = { ...DEFAULT_WORLD_INPUT };
  let showDialog = false;
  let replacingExistingWorld = false;
  let confirmedReplace = false;
  let restoring = true;
  let creating = false;
  let exporting = false;
  let opening = false;
  let status = 'Create a world to begin.';
  let backend = 'initializing';
  let viewMode: ViewMode = 'free';
  let visualizationMode: VisualizationMode = 'topo';
  let showRenderSettings = false;
  let showWater = false;
  let bakeDebugTelemetry = false;
  let waterLevel = 0;
  let hoverCoordinates: HoverCoordinates | null = null;
  let metrics: EditorMetrics = { ...manager.metrics };
  let configErrors: string[] = [];
  let bulkProgress: BulkProgress | null = null;
  let waterSaveTimer: number | null = null;
  let authoringSaveTimer: number | null = null;
  let authoringDocument: AuthoringDocumentV1 | null = null;
  let activeWorldId: string | null = null;
  let activeTool: AuthoringTool = 'select';
  let selectedPrimitiveId: string | null = null;
  let selectedAnchorId: string | null = null;
  let showAuthoring = true;
  let draftAnchors: AnchorV1[] = [];
  let bakeState: 'clean' | 'stale' | 'failed' | 'baking' = 'clean';
  let undoStack: AuthoringDocumentV1[] = [];
  let redoStack: AuthoringDocumentV1[] = [];
  let draggingAnchor: { primitiveId: string; anchorId: string } | null = null;
  let shapeTransform: {
    primitiveId: string;
    mode: 'translate' | 'rotate';
    startPoint: { x: number; z: number };
    pivot: { x: number; z: number };
    startAngle: number;
    startPrimitive: PrimitiveV1;
    startDocument: AuthoringDocumentV1;
    moved: boolean;
  } | null = null;
  let dragStarted = false;
  let authoringSyncFrame: number | null = null;
  let editingField: NoiseFieldGraphV1 | null = null;

  $: worldAreaSquareMiles = getWorldAreaSquareMiles(worldInput);
  $: configErrors = validateWorldConfig(worldInput);
  $: bulkProgressPercent = bulkProgress ? Math.max(0, Math.min(100, (bulkProgress.current / Math.max(1, bulkProgress.total)) * 100)) : 0;
  $: selectedPrimitive = authoringDocument?.primitives.find((primitive) => primitive.id === selectedPrimitiveId) ?? null;
  $: selectedField = selectedPrimitive?.fieldId ? authoringDocument?.fieldLibrary.find((field) => field.id === selectedPrimitive.fieldId) ?? null : null;
  $: selectedAnchor = selectedPrimitive?.anchors.find((anchor) => anchor.id === selectedAnchorId) ?? null;
  $: canFinishMountain = activeTool === 'mountainSpline' && draftAnchors.length >= 2;
  $: hasAuthoringWorld = Boolean(activeWorldId && authoringDocument);

  onMount(async () => {
    viewport = new EditorViewport(canvas, container, manager, (coordinates) => {
      hoverCoordinates = coordinates;
    });
    await viewport.init();
    viewport.setAuthoringInputHandlers({
      pointerDown: handleAuthoringPointerDown,
      pointerMove: handleAuthoringPointerMove,
      pointerUp: handleAuthoringPointerUp
    });
    backend = viewport.backend;
    await manager.initializeComputeBackend();
    metrics = { ...manager.metrics };
    await restoreLastWorld();

    const resizeObserver = new ResizeObserver(() => viewport?.resize());
    resizeObserver.observe(container);

    const metricsTimer = window.setInterval(() => {
      metrics = { ...manager.metrics };
    }, 500);

    const keyHandler = (event: KeyboardEvent) => {
      if (event.code === 'Escape' && showDialog && manager.config) {
        cancelWorldDialog();
        return;
      }
      if (event.code === 'Escape' && draftAnchors.length > 0) {
        cancelDraft();
        event.preventDefault();
        return;
      }
      if (event.code === 'Escape' && (selectedPrimitiveId || selectedAnchorId)) {
        clearSelection();
        event.preventDefault();
        return;
      }
      if (event.code === 'Enter' && canFinishMountain) {
        finishMountainDraft();
        event.preventDefault();
        return;
      }
      if ((event.code === 'Delete' || event.code === 'Backspace') && !isTextInput(event.target)) {
        deleteSelection();
        event.preventDefault();
        return;
      }
      if (event.code === 'KeyX' && selectedAnchorId && !isTextInput(event.target)) {
        deleteSelection();
        event.preventDefault();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.code === 'KeyZ' && !event.shiftKey) {
        undoAuthoring();
        event.preventDefault();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && (event.code === 'KeyY' || (event.code === 'KeyZ' && event.shiftKey))) {
        redoAuthoring();
        event.preventDefault();
      }
    };
    window.addEventListener('keydown', keyHandler);

    return () => {
      window.clearInterval(metricsTimer);
      window.removeEventListener('keydown', keyHandler);
      if (waterSaveTimer !== null) window.clearTimeout(waterSaveTimer);
      if (authoringSaveTimer !== null) window.clearTimeout(authoringSaveTimer);
      if (authoringSyncFrame !== null) window.cancelAnimationFrame(authoringSyncFrame);
      resizeObserver.disconnect();
      viewport?.dispose();
    };
  });

  onDestroy(() => {
    if (waterSaveTimer !== null) window.clearTimeout(waterSaveTimer);
    if (authoringSaveTimer !== null) window.clearTimeout(authoringSaveTimer);
    if (authoringSyncFrame !== null) window.cancelAnimationFrame(authoringSyncFrame);
    viewport?.dispose();
  });

  async function createWorld() {
    if (configErrors.length > 0) return;
    if (replacingExistingWorld && !confirmedReplace) return;
    creating = true;
    bulkProgress = { phase: 'generating', current: 0, total: 1, label: 'Preparing world generation' };
    status = 'Generating raw R16 tiles and LODs...';
    try {
      const replaceProjectId = replacingExistingWorld ? manager.config?.id : undefined;
      viewport?.terrain.clear();
      await manager.createWorld(worldInput, {
        replaceProjectId,
        onProgress: (progress) => {
          bulkProgress = progress;
          status = progress.label;
        }
      });
      showDialog = false;
      replacingExistingWorld = false;
      confirmedReplace = false;
      bulkProgress = null;
      status = `Editing ${manager.config?.name ?? 'world'}.`;
      metrics = { ...manager.metrics };
      loadWaterSettings();
      await loadAuthoringDocument();
      await viewport?.terrain.update(viewport.controller.activeCamera);
    } catch (error) {
      status = error instanceof Error ? error.message : 'World creation failed.';
    } finally {
      creating = false;
      bulkProgress = null;
    }
  }

  async function restoreLastWorld() {
    restoring = true;
    status = 'Restoring last OPFS world...';
    try {
      const restored = await manager.openLastProject();
      if (!restored) {
        showDialog = true;
        status = 'Create a world to begin.';
        return;
      }
      showDialog = false;
      status = `Editing ${restored.name}.`;
      metrics = { ...manager.metrics };
      loadWaterSettings();
      await loadAuthoringDocument();
      await viewport?.terrain.update(viewport.controller.activeCamera);
    } catch (error) {
      showDialog = true;
      status = error instanceof Error ? error.message : 'Create a world to begin.';
    } finally {
      restoring = false;
    }
  }

  function newWorld() {
    worldInput = { ...DEFAULT_WORLD_INPUT, name: `World ${new Date().toLocaleTimeString()}` };
    replacingExistingWorld = Boolean(manager.config);
    confirmedReplace = false;
    showDialog = true;
  }

  function cancelWorldDialog() {
    if (!manager.config) return;
    showDialog = false;
    replacingExistingWorld = false;
    confirmedReplace = false;
    status = `Editing ${manager.config.name}.`;
  }

  async function openLatestWorld() {
    opening = true;
    status = 'Opening latest OPFS world...';
    try {
      const projects = await manager.listProjects();
      if (projects.length === 0) {
        status = 'No OPFS worlds found in this browser.';
        return;
      }
      await manager.openProject(projects[0].id);
      viewport?.terrain.clear();
      showDialog = false;
      status = `Editing ${manager.config?.name ?? 'world'}.`;
      metrics = { ...manager.metrics };
      loadWaterSettings();
      await loadAuthoringDocument();
      await viewport?.terrain.update(viewport.controller.activeCamera);
    } catch (error) {
      status = error instanceof Error ? error.message : 'Open failed.';
    } finally {
      opening = false;
    }
  }

  function setViewMode(mode: ViewMode) {
    viewMode = mode;
    viewport?.setMode(mode);
  }

  function setVisualizationMode(mode: VisualizationMode) {
    visualizationMode = mode;
    viewport?.setVisualizationMode(mode);
  }

  function loadWaterSettings() {
    const water = manager.config?.water ?? { visible: false, level: 0 };
    showWater = water.visible;
    waterLevel = water.level;
    applyWaterSettings(false);
  }

  function applyWaterSettings(persist = true) {
    const maxHeight = manager.config?.worldHeight ?? DEFAULT_WORLD_INPUT.worldHeight;
    waterLevel = Math.max(0, Math.min(maxHeight, waterLevel));
    viewport?.setWater({ visible: showWater, level: waterLevel });
    if (persist) scheduleWaterSettingsSave();
  }

  function scheduleWaterSettingsSave() {
    if (!manager.config) return;
    if (waterSaveTimer !== null) window.clearTimeout(waterSaveTimer);
    waterSaveTimer = window.setTimeout(() => {
      waterSaveTimer = null;
      void saveWaterSettings();
    }, 250);
  }

  async function saveWaterSettings() {
    if (!manager.config) return;
    try {
      await manager.updateWaterConfig({ visible: showWater, level: waterLevel });
    } catch (error) {
      status = error instanceof Error ? error.message : 'Water settings save failed.';
    }
  }

  async function flushWaterSettingsSave() {
    if (waterSaveTimer !== null) {
      window.clearTimeout(waterSaveTimer);
      waterSaveTimer = null;
      await saveWaterSettings();
    }
  }

  async function loadAuthoringDocument() {
    if (!manager.config) {
      authoringDocument = null;
      activeWorldId = null;
      syncAuthoringViewport();
      return;
    }
    activeWorldId = manager.config.id;
    try {
      authoringDocument = await manager.loadAuthoringDocument();
    } catch {
      authoringDocument = createEmptyAuthoringDocument(manager.config.id);
    }
    selectedPrimitiveId = null;
    selectedAnchorId = null;
    draftAnchors = [];
    undoStack = [];
    redoStack = [];
    bakeState = authoringDocument.lastBake?.status === 'failed' ? 'failed' : 'clean';
    syncAuthoringViewport();
  }

  function syncAuthoringViewport() {
    if (authoringSyncFrame !== null) {
      window.cancelAnimationFrame(authoringSyncFrame);
      authoringSyncFrame = null;
    }
    viewport?.setAuthoringDocument(authoringDocument);
    viewport?.setAuthoringSelection({ primitiveId: selectedPrimitiveId, anchorId: selectedAnchorId });
    viewport?.setAuthoringPreview(draftAnchors);
    viewport?.setAuthoringVisible(showAuthoring);
  }

  function scheduleAuthoringViewportSync() {
    if (authoringSyncFrame !== null) return;
    authoringSyncFrame = window.requestAnimationFrame(() => {
      authoringSyncFrame = null;
      syncAuthoringViewport();
    });
  }

  function commitAuthoring(next: AuthoringDocumentV1, options: { stale?: boolean; undo?: boolean } = {}) {
    const stale = options.stale ?? true;
    const pushUndo = options.undo ?? true;
    if (authoringDocument && pushUndo) {
      undoStack = [...undoStack.slice(-24), cloneDocument(authoringDocument)];
      redoStack = [];
    }
    authoringDocument = cloneDocument(next);
    if (stale) bakeState = 'stale';
    syncAuthoringViewport();
    scheduleAuthoringSave();
  }

  function scheduleAuthoringSave() {
    if (!authoringDocument || !manager.config) return;
    if (authoringSaveTimer !== null) window.clearTimeout(authoringSaveTimer);
    authoringSaveTimer = window.setTimeout(() => {
      authoringSaveTimer = null;
      void saveAuthoringDocument();
    }, 250);
  }

  async function saveAuthoringDocument() {
    if (!authoringDocument || !manager.config) return;
    try {
      authoringDocument = await manager.saveAuthoringDocument(authoringDocument);
      syncAuthoringViewport();
    } catch (error) {
      status = error instanceof Error ? error.message : 'Authoring save failed.';
    }
  }

  async function flushAuthoringSave() {
    if (authoringSaveTimer !== null) {
      window.clearTimeout(authoringSaveTimer);
      authoringSaveTimer = null;
      await saveAuthoringDocument();
    }
  }

  function setActiveTool(tool: AuthoringTool) {
    if (tool !== activeTool) cancelDraft();
    activeTool = tool;
  }

  function cancelDraft() {
    draftAnchors = [];
    draggingAnchor = null;
    shapeTransform = null;
    dragStarted = false;
    syncAuthoringViewport();
  }

  function handleAuthoringPointerDown(point: AuthoringPointerPoint): boolean {
    if (!authoringDocument || !manager.config || showDialog) return false;
    if (activeTool === 'landformArea') {
      const threshold = hitThreshold();
      if (draftAnchors.length >= 3 && Math.hypot(point.x - draftAnchors[0].x, point.z - draftAnchors[0].z) <= threshold) {
        const primitive = createLandformArea(draftAnchors, waterLevel, countPrimitiveType('landformArea') + 1);
        draftAnchors = [];
        selectedPrimitiveId = primitive.id;
        selectedAnchorId = null;
        commitAuthoring({ ...authoringDocument, primitives: [...authoringDocument.primitives, primitive] });
        return true;
      }
      draftAnchors = [...draftAnchors, createAnchor(point.x, point.z)];
      syncAuthoringViewport();
      return true;
    }
    if (activeTool === 'mountainSpline') {
      draftAnchors = [...draftAnchors, createAnchor(point.x, point.z)];
      syncAuthoringViewport();
      return true;
    }

    if (activeTool === 'addPoint') {
      const insertion = findControlPointInsertion(point.x, point.z);
      if (insertion) {
        const anchor = createAnchor(point.x, point.z);
        const anchors = [...insertion.primitive.anchors];
        anchors.splice(insertion.insertIndex, 0, anchor);
        const nextPrimitive = {
          ...insertion.primitive,
          anchors,
          updatedAt: new Date().toISOString()
        } as PrimitiveV1;
        selectedPrimitiveId = nextPrimitive.id;
        selectedAnchorId = anchor.id;
        commitAuthoring(replacePrimitive(nextPrimitive));
        return true;
      }
      status = 'Click near a shape edge or mountain spline to add a point.';
      return true;
    }

    const transformHit = findTransformHandleHit(point.x, point.z);
    if (transformHit) {
      selectedPrimitiveId = transformHit.primitive.id;
      selectedAnchorId = null;
      shapeTransform = {
        primitiveId: transformHit.primitive.id,
        mode: transformHit.mode,
        startPoint: { x: point.x, z: point.z },
        pivot: transformHit.controls.pivot,
        startAngle: Math.atan2(point.z - transformHit.controls.pivot.z, point.x - transformHit.controls.pivot.x),
        startPrimitive: clonePrimitive(transformHit.primitive),
        startDocument: cloneDocument(authoringDocument),
        moved: false
      };
      syncAuthoringViewport();
      return true;
    }

    const anchorHit = findAnchorHit(point.x, point.z);
    if (anchorHit) {
      selectedPrimitiveId = anchorHit.primitiveId;
      selectedAnchorId = anchorHit.anchorId;
      draggingAnchor = anchorHit;
      dragStarted = false;
      syncAuthoringViewport();
      return true;
    }
    const primitive = cyclePrimitiveHit(point.x, point.z);
    selectedPrimitiveId = primitive?.id ?? null;
    selectedAnchorId = null;
    syncAuthoringViewport();
    return Boolean(primitive);
  }

  function handleAuthoringPointerMove(point: AuthoringPointerPoint): boolean {
    if (authoringDocument && shapeTransform) {
      const transformed = transformPrimitive(shapeTransform, point);
      if (!transformed) return false;
      authoringDocument = replacePrimitiveInDocument(authoringDocument, transformed);
      bakeState = 'stale';
      shapeTransform.moved = true;
      scheduleAuthoringViewportSync();
      return true;
    }

    if (!authoringDocument || !draggingAnchor) return false;
    const next = cloneDocument(authoringDocument);
    const primitive = next.primitives.find((item) => item.id === draggingAnchor?.primitiveId);
    const anchor = primitive?.anchors.find((item) => item.id === draggingAnchor?.anchorId);
    if (!primitive || !anchor) return false;
    if (!dragStarted && authoringDocument) {
      undoStack = [...undoStack.slice(-24), cloneDocument(authoringDocument)];
      redoStack = [];
      dragStarted = true;
    }
    anchor.x = point.x;
    anchor.z = point.z;
    primitive.updatedAt = new Date().toISOString();
    authoringDocument = next;
    bakeState = 'stale';
    syncAuthoringViewport();
    scheduleAuthoringSave();
    return true;
  }

  function handleAuthoringPointerUp(_point: AuthoringPointerPoint): boolean {
    if (shapeTransform) {
      const handled = shapeTransform.moved;
      if (handled && authoringDocument) {
        const primitive = authoringDocument.primitives.find((item) => item.id === shapeTransform?.primitiveId);
        if (primitive) primitive.updatedAt = new Date().toISOString();
        undoStack = [...undoStack.slice(-24), shapeTransform.startDocument];
        redoStack = [];
        scheduleAuthoringSave();
      }
      shapeTransform = null;
      syncAuthoringViewport();
      return handled;
    }

    const handled = Boolean(draggingAnchor);
    draggingAnchor = null;
    dragStarted = false;
    return handled;
  }

  function finishMountainDraft() {
    if (!authoringDocument || draftAnchors.length < 2) return;
    const primitive = createMountainSpline(draftAnchors, countPrimitiveType('mountainSpline') + 1);
    draftAnchors = [];
    selectedPrimitiveId = primitive.id;
    selectedAnchorId = null;
    commitAuthoring({ ...authoringDocument, primitives: [...authoringDocument.primitives, primitive] });
  }

  function deleteSelection() {
    if (!authoringDocument || !selectedPrimitiveId) return;
    const primitive = authoringDocument.primitives.find((item) => item.id === selectedPrimitiveId);
    if (!primitive) return;
    if (selectedAnchorId && primitive.anchors.length > minimumAnchorCount(primitive)) {
      const nextPrimitive = {
        ...primitive,
        updatedAt: new Date().toISOString(),
        anchors: primitive.anchors.filter((anchor) => anchor.id !== selectedAnchorId)
      } as PrimitiveV1;
      selectedAnchorId = null;
      commitAuthoring(replacePrimitive(nextPrimitive));
      return;
    }
    selectedPrimitiveId = null;
    selectedAnchorId = null;
    commitAuthoring({ ...authoringDocument, primitives: authoringDocument.primitives.filter((item) => item.id !== primitive.id) });
  }

  function findControlPointInsertion(x: number, z: number): { primitive: PrimitiveV1; insertIndex: number; distance: number } | null {
    const threshold = Math.max(18, hitThreshold() * 0.75);
    let best: { primitive: PrimitiveV1; insertIndex: number; distance: number; order: number } | null = null;
    for (const [order, primitive] of (authoringDocument?.primitives ?? []).entries()) {
      if (!primitive.enabled) continue;
      const closed = primitive.type === 'landformArea';
      if (primitive.anchors.length < minimumAnchorCount(primitive)) continue;
      if (primitive.splineSmoothness <= 0 || primitive.anchors.length < 3) {
        const segmentCount = closed ? primitive.anchors.length : primitive.anchors.length - 1;
        for (let i = 0; i < segmentCount; i += 1) {
          const a = primitive.anchors[i];
          const b = primitive.anchors[(i + 1) % primitive.anchors.length];
          const distance = distanceToSegment2D(x, z, a.x, a.z, b.x, b.z);
          if (distance > threshold) continue;
          const insertIndex = i + 1;
          if (!best || distance < best.distance || (distance === best.distance && order > best.order)) {
            best = { primitive, insertIndex, distance, order };
          }
        }
        continue;
      }
      const samples = sampleSplineAnchorsWithSegments(primitive.anchors, closed, primitive.splineSmoothness);
      const segmentCount = closed ? samples.length : samples.length - 1;
      for (let i = 0; i < segmentCount; i += 1) {
        const a = samples[i];
        const b = samples[(i + 1) % samples.length];
        if (a.segmentIndex !== b.segmentIndex && !(closed && i === samples.length - 1)) continue;
        const distance = distanceToSegment2D(x, z, a.x, a.z, b.x, b.z);
        if (distance > threshold) continue;
        const insertIndex = ((a.segmentIndex + 1) % primitive.anchors.length) || primitive.anchors.length;
        if (!best || distance < best.distance || (distance === best.distance && order > best.order)) {
          best = { primitive, insertIndex, distance, order };
        }
      }
    }
    return best ? { primitive: best.primitive, insertIndex: best.insertIndex, distance: best.distance } : null;
  }

  function clearSelection() {
    selectedPrimitiveId = null;
    selectedAnchorId = null;
    syncAuthoringViewport();
  }

  function updateSelectedPrimitive(patch: Partial<PrimitiveV1>) {
    if (!authoringDocument || !selectedPrimitive) return;
    const nextPrimitive = {
      ...selectedPrimitive,
      ...patch,
      updatedAt: new Date().toISOString()
    } as PrimitiveV1;
    commitAuthoring(replacePrimitive(nextPrimitive));
  }

  function setSelectedField(fieldId: string) {
    if (!selectedPrimitive) return;
    updateSelectedPrimitive({ fieldId: fieldId || undefined } as Partial<PrimitiveV1>);
  }

  function createFieldForSelectedPrimitive() {
    if (!authoringDocument || !selectedPrimitive) return;
    const graph = createNoiseGraph(crypto.randomUUID(), `${selectedPrimitive.name} Field`);
    editingField = graph;
  }

  function editSelectedField() {
    if (!selectedField) return;
    editingField = structuredClone(selectedField);
  }

  function deleteSelectedField() {
    if (!authoringDocument || !selectedField) return;
    const deletedId = selectedField.id;
    const next: AuthoringDocumentV1 = {
      ...authoringDocument,
      fieldLibrary: authoringDocument.fieldLibrary.filter((field) => field.id !== deletedId),
      primitives: authoringDocument.primitives.map((primitive) => primitive.fieldId === deletedId ? { ...primitive, fieldId: undefined, updatedAt: new Date().toISOString() } as PrimitiveV1 : primitive)
    };
    selectedAnchorId = null;
    commitAuthoring(next);
  }

  function saveEditingField(graph: NoiseFieldGraphV1) {
    if (!authoringDocument) return;
    const exists = authoringDocument.fieldLibrary.some((field) => field.id === graph.id);
    const nextLibrary = exists
      ? authoringDocument.fieldLibrary.map((field) => field.id === graph.id ? graph : field)
      : [...authoringDocument.fieldLibrary, graph];
    const nextDocument = {
      ...authoringDocument,
      fieldLibrary: nextLibrary
    };
    if (selectedPrimitive && !exists) {
      nextDocument.primitives = nextDocument.primitives.map((primitive) => primitive.id === selectedPrimitive.id ? { ...primitive, fieldId: graph.id, updatedAt: new Date().toISOString() } as PrimitiveV1 : primitive);
    }
    editingField = null;
    commitAuthoring(nextDocument);
  }

  function replacePrimitive(primitive: PrimitiveV1): AuthoringDocumentV1 {
    const document = authoringDocument ?? createEmptyAuthoringDocument(manager.config?.id ?? 'unknown');
    return replacePrimitiveInDocument(document, primitive);
  }

  function replacePrimitiveInDocument(document: AuthoringDocumentV1, primitive: PrimitiveV1): AuthoringDocumentV1 {
    return {
      ...document,
      primitives: document.primitives.map((item) => item.id === primitive.id ? primitive : item)
    };
  }

  function undoAuthoring() {
    if (!authoringDocument || undoStack.length === 0) return;
    const previous = undoStack[undoStack.length - 1];
    const previousSelection = { primitiveId: selectedPrimitiveId, anchorId: selectedAnchorId };
    redoStack = [...redoStack, cloneDocument(authoringDocument)];
    undoStack = undoStack.slice(0, -1);
    authoringDocument = cloneDocument(previous);
    restoreSelection(previousSelection, authoringDocument);
    bakeState = 'stale';
    syncAuthoringViewport();
    scheduleAuthoringSave();
  }

  function redoAuthoring() {
    if (!authoringDocument || redoStack.length === 0) return;
    const next = redoStack[redoStack.length - 1];
    const previousSelection = { primitiveId: selectedPrimitiveId, anchorId: selectedAnchorId };
    undoStack = [...undoStack, cloneDocument(authoringDocument)];
    redoStack = redoStack.slice(0, -1);
    authoringDocument = cloneDocument(next);
    restoreSelection(previousSelection, authoringDocument);
    bakeState = 'stale';
    syncAuthoringViewport();
    scheduleAuthoringSave();
  }

  function restoreSelection(selection: { primitiveId: string | null; anchorId: string | null }, document: AuthoringDocumentV1) {
    const primitive = document.primitives.find((item) => item.id === selection.primitiveId);
    selectedPrimitiveId = primitive?.id ?? null;
    selectedAnchorId = primitive?.anchors.some((anchor) => anchor.id === selection.anchorId) ? selection.anchorId : null;
  }

  async function bakeAuthoring() {
    if (!authoringDocument || !manager.config || bakeState === 'baking') return;
    await flushWaterSettingsSave();
    await flushAuthoringSave();
    bakeState = 'baking';
    bulkProgress = { phase: 'baking', current: 0, total: 1, label: 'Preparing structural bake' };
    status = 'Baking structural terrain...';
    try {
      authoringDocument = await manager.bakeAuthoringDocument(authoringDocument, waterLevel, (progress) => {
        bulkProgress = progress;
        status = progress.label;
      }, {
        debugTelemetry: bakeDebugTelemetry
      });
      bakeState = authoringDocument.lastBake?.status === 'failed' ? 'failed' : 'clean';
      status = bakeState === 'failed' ? authoringDocument.lastBake?.error ?? 'Bake failed.' : 'Bake complete.';
      metrics = { ...manager.metrics };
      viewport?.refreshTerrain();
      syncAuthoringViewport();
    } catch (error) {
      bakeState = 'failed';
      status = error instanceof Error ? error.message : 'Bake failed.';
    } finally {
      bulkProgress = null;
    }
  }

  function findAnchorHit(x: number, z: number): { primitiveId: string; anchorId: string } | null {
    let best: { primitiveId: string; anchorId: string; distance: number } | null = null;
    const threshold = hitThreshold();
    for (const primitive of authoringDocument?.primitives ?? []) {
      for (const anchor of primitive.anchors) {
        const distance = Math.hypot(x - anchor.x, z - anchor.z);
        if (distance <= threshold && (!best || distance < best.distance)) {
          best = { primitiveId: primitive.id, anchorId: anchor.id, distance };
        }
      }
    }
    return best ? { primitiveId: best.primitiveId, anchorId: best.anchorId } : null;
  }

  function findTransformHandleHit(x: number, z: number): { primitive: PrimitiveV1; mode: 'translate' | 'rotate'; controls: TransformControls2D } | null {
    if (!selectedPrimitive || activeTool !== 'select') return null;
    const controls = getTransformControls(selectedPrimitive);
    if (!controls) return null;
    const threshold = hitThreshold();
    const translateDistance = Math.hypot(x - controls.pivot.x, z - controls.pivot.z);
    const arrowXDistance = distanceToSegment2D(x, z, controls.pivot.x, controls.pivot.z, controls.pivot.x + controls.arrowLength, controls.pivot.z);
    const arrowZDistance = distanceToSegment2D(x, z, controls.pivot.x, controls.pivot.z, controls.pivot.x, controls.pivot.z + controls.arrowLength);
    const translateThreshold = Math.max(22, threshold * 0.8);
    if (translateDistance <= translateThreshold || arrowXDistance <= translateThreshold || arrowZDistance <= translateThreshold) {
      return { primitive: selectedPrimitive, mode: 'translate', controls };
    }
    const distanceFromPivot = Math.hypot(x - controls.pivot.x, z - controls.pivot.z);
    const ringThreshold = Math.max(controls.ringWidth * 0.65, threshold * 0.8);
    if (Math.abs(distanceFromPivot - controls.radius) <= ringThreshold) return { primitive: selectedPrimitive, mode: 'rotate', controls };
    return null;
  }

  function findPrimitiveHit(x: number, z: number): PrimitiveV1 | null {
    return findPrimitiveHits(x, z)[0] ?? null;
  }

  function cyclePrimitiveHit(x: number, z: number): PrimitiveV1 | null {
    const hits = findPrimitiveHits(x, z);
    if (hits.length === 0) return null;
    const selectedIndex = hits.findIndex((primitive) => primitive.id === selectedPrimitiveId);
    if (selectedIndex < 0) return hits[0];
    return hits[(selectedIndex + 1) % hits.length];
  }

  function findPrimitiveHits(x: number, z: number): PrimitiveV1[] {
    const threshold = hitThreshold();
    return [...(authoringDocument?.primitives ?? [])]
      .map((primitive, index) => ({ primitive, index }))
      .filter(({ primitive }) => primitiveContainsPoint(primitive, x, z, threshold))
      .sort((a, b) => b.index - a.index)
      .map(({ primitive }) => primitive);
  }

  function primitiveContainsPoint(primitive: PrimitiveV1, x: number, z: number, threshold: number) {
    if (primitive.type === 'landformArea' && primitive.anchors.length >= 3 && pointInSplinePolygon(x, z, primitive.anchors, primitive.splineSmoothness)) return true;
    if (primitive.type === 'mountainSpline' && primitive.anchors.length >= 2) {
      return distanceToSpline(x, z, primitive.anchors, false, primitive.splineSmoothness) <= Math.max(threshold * 1.6, primitive.width / 2);
    }
    return primitive.anchors.length >= 2 && distanceToSpline(x, z, primitive.anchors, primitive.type === 'landformArea', primitive.splineSmoothness) <= threshold;
  }

  function countPrimitiveType(type: PrimitiveV1['type']) {
    return authoringDocument?.primitives.filter((primitive) => primitive.type === type).length ?? 0;
  }

  function hitThreshold() {
    const config = manager.config;
    if (!config) return 30;
    return Math.max(24, config.tileSize * config.tilesPerSide * config.unitSize * 0.006);
  }

  function minimumAnchorCount(primitive: PrimitiveV1) {
    return primitive.type === 'landformArea' ? 3 : 2;
  }

  function cloneDocument(document: AuthoringDocumentV1): AuthoringDocumentV1 {
    return structuredClone(document);
  }

  function clonePrimitive(primitive: PrimitiveV1): PrimitiveV1 {
    return structuredClone(primitive);
  }

  interface TransformControls2D {
    pivot: { x: number; z: number };
    radius: number;
    ringWidth: number;
    arrowLength: number;
  }

  function getTransformControls(primitive: PrimitiveV1): TransformControls2D | null {
    if (primitive.anchors.length === 0) return null;
    let x = 0;
    let z = 0;
    for (const anchor of primitive.anchors) {
      x += anchor.x;
      z += anchor.z;
    }
    const pivot = { x: x / primitive.anchors.length, z: z / primitive.anchors.length };
    const scale = viewport?.getWorldUnitsPerScreenPixelAt(pivot.x, pivot.z) ?? 2;
    const radius = 48 * scale;
    const ringWidth = 17 * scale;
    const arrowLength = 39 * scale;
    return {
      pivot,
      radius,
      ringWidth,
      arrowLength
    };
  }

  function distanceToSegment2D(px: number, pz: number, ax: number, az: number, bx: number, bz: number) {
    const dx = bx - ax;
    const dz = bz - az;
    const lengthSq = dx * dx + dz * dz;
    if (lengthSq === 0) return Math.hypot(px - ax, pz - az);
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / lengthSq));
    return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
  }

  function transformPrimitive(transform: NonNullable<typeof shapeTransform>, point: { x: number; z: number }): PrimitiveV1 | null {
    if (transform.mode === 'translate') {
      const dx = point.x - transform.startPoint.x;
      const dz = point.z - transform.startPoint.z;
      return {
        ...transform.startPrimitive,
        anchors: transform.startPrimitive.anchors.map((anchor) => ({
          ...anchor,
          x: anchor.x + dx,
          z: anchor.z + dz
        }))
      } as PrimitiveV1;
    }

    const angle = Math.atan2(point.z - transform.pivot.z, point.x - transform.pivot.x);
    const delta = angle - transform.startAngle;
    const cos = Math.cos(delta);
    const sin = Math.sin(delta);
    return {
      ...transform.startPrimitive,
      anchors: transform.startPrimitive.anchors.map((anchor) => {
        const dx = anchor.x - transform.pivot.x;
        const dz = anchor.z - transform.pivot.z;
        return {
          ...anchor,
          x: transform.pivot.x + dx * cos - dz * sin,
          z: transform.pivot.z + dx * sin + dz * cos
        };
      })
    } as PrimitiveV1;
  }

  function isTextInput(target: EventTarget | null) {
    const element = target as HTMLElement | null;
    return element?.tagName === 'INPUT' || element?.tagName === 'SELECT' || element?.tagName === 'TEXTAREA';
  }

  function formatCoordinate(value: number | null | undefined) {
    return value === null || value === undefined ? '-' : value.toFixed(1);
  }

  async function exportWorld() {
    if (!manager.config) {
      status = 'Create a world before exporting.';
      return;
    }
    if (!window.showDirectoryPicker) {
      status = 'Export requires a browser with the File System Access API.';
      return;
    }
    await flushWaterSettingsSave();
    exporting = true;
    status = 'Exporting PNG tiles...';
    try {
      const directory = await window.showDirectoryPicker({ mode: 'readwrite' });
      await manager.exportToDirectory(directory);
      status = 'Export complete.';
    } catch (error) {
      status = error instanceof Error ? error.message : 'Export canceled.';
    } finally {
      exporting = false;
    }
  }

  const modes: { id: ViewMode; label: string; icon: typeof Crosshair; disabled?: boolean }[] = [
    { id: 'free', label: 'Free camera', icon: Navigation },
    { id: 'ortho', label: 'Ortho top down', icon: Map },
    { id: 'character', label: 'Character controller', icon: UserRound, disabled: false }
  ];

  const visualizations: { id: VisualizationMode; label: string; icon: typeof Crosshair }[] = [
    { id: 'wireframe', label: 'Wireframe visualization', icon: Grid3X3 },
    { id: 'topo', label: 'Topo visualization', icon: Mountain },
    { id: 'render', label: 'Material visualization', icon: Palette }
  ];

  const authoringTools: { id: AuthoringTool; label: string; icon: typeof Crosshair }[] = [
    { id: 'select', label: 'Select primitive', icon: MousePointer2 },
    { id: 'addPoint', label: 'Add control point', icon: CirclePlus },
    { id: 'landformArea', label: 'Landform area', icon: Paintbrush },
    { id: 'mountainSpline', label: 'Mountain spline', icon: Route }
  ];
</script>

<div class="app-shell" bind:this={container}>
  <canvas bind:this={canvas} aria-label="Heightmap editor viewport"></canvas>

  <div class="topbar">
    <div class="brand"><Mountain size={18} /> WorldForge</div>
    <div class="toolbar">
      <button type="button" title="New world" onclick={newWorld}><Plus size={17} /></button>
      <button type="button" title="Open latest OPFS world" onclick={openLatestWorld} disabled={opening}><FolderOpen size={17} /></button>
      <button type="button" title="Export world" onclick={exportWorld} disabled={exporting || !manager.config}><Download size={17} /></button>
      <button type="button" title="Rendering settings" class:active={showRenderSettings} onclick={() => { showRenderSettings = !showRenderSettings; }}>
        <Settings size={17} />
      </button>
    </div>
  </div>

  <div class="mode-stack" aria-label="View mode">
    {#each modes as mode}
      <button
        type="button"
        class:active={viewMode === mode.id}
        disabled={mode.disabled}
        title={mode.label}
        aria-label={mode.label}
        onclick={() => setViewMode(mode.id)}
      >
        <svelte:component this={mode.icon} size={18} />
        <span class="icon-tooltip" role="tooltip">{mode.label}</span>
      </button>
    {/each}
  </div>

  <div class="visual-stack" aria-label="Visualization mode">
    {#each visualizations as visualization}
      <button
        type="button"
        class:active={visualizationMode === visualization.id}
        title={visualization.label}
        aria-label={visualization.label}
        onclick={() => setVisualizationMode(visualization.id)}
      >
        <svelte:component this={visualization.icon} size={18} />
        <span class="icon-tooltip" role="tooltip">{visualization.label}</span>
      </button>
    {/each}
  </div>

  <div class="authoring-stack" aria-label="Authoring tools">
    {#each authoringTools as tool}
      <button
        type="button"
        class:active={activeTool === tool.id}
        disabled={!hasAuthoringWorld}
        title={hasAuthoringWorld ? tool.label : 'Create or open a world first'}
        aria-label={tool.label}
        onclick={() => setActiveTool(tool.id)}
      >
        <svelte:component this={tool.icon} size={18} />
        <span class="icon-tooltip" role="tooltip">{tool.label}</span>
      </button>
    {/each}
    <button
      type="button"
      class:active={showAuthoring}
      disabled={!hasAuthoringWorld}
      title={hasAuthoringWorld ? (showAuthoring ? 'Hide authoring overlays' : 'Show authoring overlays') : 'Create or open a world first'}
      aria-label={showAuthoring ? 'Hide authoring overlays' : 'Show authoring overlays'}
      onclick={() => { showAuthoring = !showAuthoring; syncAuthoringViewport(); }}
    >
      {#if showAuthoring}<Eye size={18} />{:else}<EyeOff size={18} />{/if}
      <span class="icon-tooltip" role="tooltip">{showAuthoring ? 'Hide overlays' : 'Show overlays'}</span>
    </button>
  </div>

  <section class="metrics" aria-label="Editor metrics">
    <div class="metric-title">Runtime</div>
    <dl>
      <div><dt>Backend</dt><dd>{backend}</dd></div>
      <div><dt>Compute</dt><dd>{metrics.computeBackend}</dd></div>
      <div><dt>Tiles</dt><dd>{metrics.renderedTiles}</dd></div>
      <div><dt>Verts</dt><dd>{Math.round(metrics.vertices).toLocaleString()}</dd></div>
      <div><dt>Tris</dt><dd>{Math.round(metrics.triangles).toLocaleString()}</dd></div>
      <div><dt>Cache</dt><dd>{metrics.cachedTiles}</dd></div>
      <div><dt>RAM</dt><dd>{metrics.ramLimitMb > 0 ? `${metrics.ramUsedMb.toFixed(0)} / ${metrics.ramLimitMb.toFixed(0)} MB` : 'n/a'}</dd></div>
      <div><dt>Read avg</dt><dd>{metrics.tileReadAvgMs.toFixed(1)} ms</dd></div>
      <div><dt>Write avg</dt><dd>{metrics.tileWriteAvgMs.toFixed(1)} ms</dd></div>
      <div><dt>LOD</dt><dd>{metrics.lodRebuildMs.toFixed(1)} ms</dd></div>
    </dl>
  </section>

  {#if showRenderSettings}
    <section class="render-settings" aria-label="Rendering settings">
      <div class="metric-title">Rendering</div>
      <label class="toggle-row">
        <input type="checkbox" bind:checked={showWater} onchange={() => applyWaterSettings()} />
        <span>Show water</span>
      </label>
      <label class="toggle-row">
        <input type="checkbox" bind:checked={bakeDebugTelemetry} />
        <span>Bake debug telemetry</span>
      </label>
      <label>
        <span>Water level</span>
        <input
          type="range"
          min="0"
          max={manager.config?.worldHeight ?? DEFAULT_WORLD_INPUT.worldHeight}
          step="1"
          bind:value={waterLevel}
          oninput={() => applyWaterSettings()}
        />
      </label>
      <input
        type="number"
        min="0"
        max={manager.config?.worldHeight ?? DEFAULT_WORLD_INPUT.worldHeight}
        step="1"
        bind:value={waterLevel}
        oninput={() => applyWaterSettings()}
      />
    </section>
  {/if}

  {#if hasAuthoringWorld && authoringDocument}
    <section class="authoring-panel" aria-label="Authoring inspector">
      <div class="panel-header">
        <div>
          <div class="metric-title">Authoring</div>
          <div class={`bake-pill ${bakeState}`}>{bakeState}</div>
        </div>
        <div class="panel-actions">
          <button type="button" title="Undo" disabled={undoStack.length === 0} onclick={undoAuthoring}><Undo2 size={16} /></button>
          <button type="button" title="Redo" disabled={redoStack.length === 0} onclick={redoAuthoring}><Redo2 size={16} /></button>
          <button type="button" title="Bake terrain" disabled={bakeState === 'baking'} onclick={() => void bakeAuthoring()}><Hammer size={16} /></button>
        </div>
      </div>

      {#if activeTool === 'landformArea' && draftAnchors.length > 0}
        <div class="draft-row">
          <span>{draftAnchors.length} anchors</span>
          <button type="button" onclick={cancelDraft}>Cancel</button>
        </div>
      {:else if activeTool === 'mountainSpline' && draftAnchors.length > 0}
        <div class="draft-row">
          <span>{draftAnchors.length} anchors</span>
          <button type="button" disabled={!canFinishMountain} onclick={finishMountainDraft}>Finish</button>
          <button type="button" onclick={cancelDraft}>Cancel</button>
        </div>
      {/if}

      {#if selectedPrimitive}
        <label>
          <span>Name</span>
          <input value={selectedPrimitive.name} oninput={(event) => updateSelectedPrimitive({ name: event.currentTarget.value } as Partial<PrimitiveV1>)} />
        </label>
        <label class="toggle-row">
          <input type="checkbox" checked={selectedPrimitive.enabled} onchange={(event) => updateSelectedPrimitive({ enabled: event.currentTarget.checked } as Partial<PrimitiveV1>)} />
          <span>Enabled</span>
        </label>
        <div class="field-picker">
          <label>
            <span>Noise field</span>
            <select value={selectedPrimitive.fieldId ?? ''} onchange={(event) => setSelectedField(event.currentTarget.value)}>
              <option value="">none</option>
              {#each authoringDocument.fieldLibrary as field}
                <option value={field.id}>{field.name}</option>
              {/each}
            </select>
          </label>
          <div class="field-actions">
            <button type="button" title="Add field" onclick={createFieldForSelectedPrimitive}><Plus size={16} /></button>
            <button type="button" title="Edit selected field" disabled={!selectedField} onclick={editSelectedField}><Edit3 size={16} /></button>
            <button type="button" title="Delete selected field" disabled={!selectedField} onclick={deleteSelectedField}><Trash2 size={16} /></button>
          </div>
        </div>
        {#if selectedAnchor}
          <div class="draft-row">
            <span>Point {selectedPrimitive.anchors.findIndex((anchor) => anchor.id === selectedAnchor.id) + 1}</span>
            <button type="button" class="danger" onclick={deleteSelection}><Trash2 size={16} /> Remove point</button>
          </div>
        {/if}

        {#if selectedPrimitive.type === 'landformArea'}
          <label>
            <span>Mode</span>
            <select value={selectedPrimitive.mode} onchange={(event) => updateSelectedPrimitive({ mode: event.currentTarget.value as LandformModeV1 } as Partial<PrimitiveV1>)}>
              <option value="land">land</option>
              <option value="water">water</option>
              <option value="plateau">plateau</option>
            </select>
          </label>
          <div class="field-grid compact">
            <label>
              <span>Elevation</span>
              <input type="number" step="1" value={selectedPrimitive.elevation} oninput={(event) => updateSelectedPrimitive({ elevation: Number(event.currentTarget.value) } as Partial<PrimitiveV1>)} />
            </label>
            <label>
              <span>Priority</span>
              <input type="number" step="1" value={selectedPrimitive.priority} oninput={(event) => updateSelectedPrimitive({ priority: Number(event.currentTarget.value) } as Partial<PrimitiveV1>)} />
            </label>
          </div>
          <label>
            <span>Noise scale</span>
            <input type="number" step="1" value={selectedPrimitive.noiseScale} oninput={(event) => updateSelectedPrimitive({ noiseScale: Number(event.currentTarget.value) } as Partial<PrimitiveV1>)} />
          </label>
          <label>
            <span>Edge smoothness</span>
            <input type="number" min="0" step="1" value={selectedPrimitive.edgeSmoothness} oninput={(event) => updateSelectedPrimitive({ edgeSmoothness: Number(event.currentTarget.value) } as Partial<PrimitiveV1>)} />
          </label>
          <label>
            <span>Curve smoothness</span>
            <input type="range" min="0" max="1" step="0.01" value={selectedPrimitive.splineSmoothness} oninput={(event) => updateSelectedPrimitive({ splineSmoothness: Number(event.currentTarget.value) } as Partial<PrimitiveV1>)} />
          </label>
        {:else}
          <div class="field-grid compact">
            <label>
              <span>Height</span>
              <input type="number" min="0" step="1" value={selectedPrimitive.height} oninput={(event) => updateSelectedPrimitive({ height: Number(event.currentTarget.value) } as Partial<PrimitiveV1>)} />
            </label>
            <label>
              <span>Width</span>
              <input type="number" min="0" step="1" value={selectedPrimitive.width} oninput={(event) => updateSelectedPrimitive({ width: Number(event.currentTarget.value) } as Partial<PrimitiveV1>)} />
            </label>
          </div>
          <label>
            <span>Edge smoothness</span>
            <input type="number" min="0" step="1" value={selectedPrimitive.edgeSmoothness} oninput={(event) => updateSelectedPrimitive({ edgeSmoothness: Number(event.currentTarget.value) } as Partial<PrimitiveV1>)} />
          </label>
          <label>
            <span>Curve smoothness</span>
            <input type="range" min="0" max="1" step="0.01" value={selectedPrimitive.splineSmoothness} oninput={(event) => updateSelectedPrimitive({ splineSmoothness: Number(event.currentTarget.value) } as Partial<PrimitiveV1>)} />
          </label>
        {/if}
        <button type="button" class="danger" onclick={deleteSelection}><Trash2 size={16} /> {selectedAnchor ? 'Delete selection' : 'Delete'}</button>
      {:else}
        <div class="empty-inspector">
          {authoringDocument.primitives.length} primitives
        </div>
      {/if}
    </section>
  {/if}

  <div class="coordinates" aria-label="Mouse world coordinates">
    x: {formatCoordinate(hoverCoordinates?.x)}
    y: {formatCoordinate(hoverCoordinates?.y)}
    z: {formatCoordinate(hoverCoordinates?.z)}
    {hoverCoordinates?.unit ?? manager.config?.unit ?? DEFAULT_WORLD_INPUT.unit}
  </div>

  <div class="status">{status}</div>

  {#if bulkProgress || restoring}
    <div class="progress-panel" aria-label="Bulk operation progress">
      <div>{bulkProgress?.label ?? 'Restoring world'}</div>
      <div class="progress-track"><span style={`width: ${restoring ? 38 : bulkProgressPercent}%`}></span></div>
    </div>
  {/if}

  {#if showDialog}
    <div class="dialog-backdrop">
      <form class="world-dialog" onsubmit={(event) => event.preventDefault()}>
        <header>
          <Mountain size={22} />
          <div>
            <h1>World Config</h1>
            <p>One OPFS-backed heightmap project is active at a time.</p>
          </div>
        </header>

        <label>
          <span>Name</span>
          <input bind:value={worldInput.name} autocomplete="off" />
        </label>

        <div class="field-grid">
          <label>
            <span>Tile size</span>
            <input type="number" min="2" step="2" bind:value={worldInput.tileSize} />
          </label>
          <label>
            <span>Tiles per side</span>
            <input type="number" min="1" step="1" bind:value={worldInput.tilesPerSide} />
          </label>
        </div>

        <div class="field-grid unit-grid">
          <label>
            <span>Unit size</span>
            <input type="number" min="0.0001" step="0.25" bind:value={worldInput.unitSize} />
          </label>
          <label>
            <span>Unit</span>
            <select bind:value={worldInput.unit}>
              <option value="foot">foot</option>
              <option value="meter">meter</option>
              <option value="cm">cm</option>
            </select>
          </label>
        </div>

        <label>
          <span>Overall world height</span>
          <input type="number" min="1" step="1" bind:value={worldInput.worldHeight} />
        </label>

        {#if replacingExistingWorld && manager.config}
          <div class="warning">
            Creating this world will permanently delete the OPFS project data for “{manager.config.name}” before generating the replacement world.
          </div>
          <label class="confirm-row">
            <input type="checkbox" bind:checked={confirmedReplace} />
            <span>Delete the existing world from browser storage</span>
          </label>
        {/if}

        <label>
          <span>Total world area</span>
          <input readonly value={`${worldAreaSquareMiles.toLocaleString(undefined, { maximumFractionDigits: 2 })} sq mi`} />
        </label>

        {#if configErrors.length > 0}
          <ul class="errors">
            {#each configErrors as error}
              <li>{error}</li>
            {/each}
          </ul>
        {/if}

        <footer>
          {#if manager.config}
            <button type="button" class="secondary" disabled={creating} onclick={cancelWorldDialog}>Cancel</button>
          {/if}
          <button type="button" class="primary" disabled={creating || configErrors.length > 0 || (replacingExistingWorld && !confirmedReplace)} onclick={() => void createWorld()}>
            {creating ? 'Generating...' : 'Create World'}
          </button>
        </footer>
      </form>
    </div>
  {/if}

  {#if editingField}
    <NoiseGraphEditor graph={editingField} onSave={saveEditingField} onCancel={() => { editingField = null; }} />
  {/if}
</div>
