<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { CircleDot, Crosshair, Download, FolderOpen, Grid3X3, Map, Mountain, Navigation, Plus, Settings, UserRound } from '@lucide/svelte';
  import { DEFAULT_WORLD_INPUT, getWorldAreaSquareMiles, validateWorldConfig, type WorldConfigInput } from './lib/heightmap/worldConfig';
  import { TileManager, type BulkProgress, type EditorMetrics } from './lib/heightmap/tileManager';
  import { EditorViewport, type HoverCoordinates } from './lib/render/editorViewport';
  import type { ViewMode } from './lib/render/cameraController';
  import type { VisualizationMode } from './lib/render/terrainRenderer';

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
  let waterLevel = 0;
  let hoverCoordinates: HoverCoordinates | null = null;
  let metrics: EditorMetrics = { ...manager.metrics };
  let configErrors: string[] = [];
  let bulkProgress: BulkProgress | null = null;
  let waterSaveTimer: number | null = null;

  $: worldAreaSquareMiles = getWorldAreaSquareMiles(worldInput);
  $: configErrors = validateWorldConfig(worldInput);
  $: bulkProgressPercent = bulkProgress ? Math.max(0, Math.min(100, (bulkProgress.current / Math.max(1, bulkProgress.total)) * 100)) : 0;

  onMount(async () => {
    viewport = new EditorViewport(canvas, container, manager, (coordinates) => {
      hoverCoordinates = coordinates;
    });
    await viewport.init();
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
      }
    };
    window.addEventListener('keydown', keyHandler);

    return () => {
      window.clearInterval(metricsTimer);
      window.removeEventListener('keydown', keyHandler);
      if (waterSaveTimer !== null) window.clearTimeout(waterSaveTimer);
      resizeObserver.disconnect();
      viewport?.dispose();
    };
  });

  onDestroy(() => {
    if (waterSaveTimer !== null) window.clearTimeout(waterSaveTimer);
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
    { id: 'render', label: 'Material visualization', icon: CircleDot }
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
</div>
