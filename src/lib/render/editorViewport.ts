import Stats from 'stats.js';
import * as THREE from 'three';
import type { TileManager } from '../heightmap/tileManager';
import { CameraController, type ViewMode } from './cameraController';
import { createRenderer, type RendererAdapter } from './rendererAdapter';
import { LakeFillHeightDebugRenderer, TerrainQuadtreeRenderer, type VisualizationMode } from './terrainRenderer';
import { AuthoringOverlay, type AuthoringSelection } from './authoringOverlay';
import type { AnchorV1, AuthoringDocumentV1 } from '../authoring/authoringDocument';

const TERRAIN_UPDATE_INTERVAL_FRAMES = 8;
const ENABLE_TERRAIN_RAYCAST = false;

export interface HoverCoordinates {
  x: number;
  y: number;
  z: number;
  unit: string;
}

export interface WaterSettings {
  visible: boolean;
  level: number;
}

export interface AuthoringPointerPoint {
  x: number;
  z: number;
  event: PointerEvent;
}

export interface AuthoringPointerHandlers {
  pointerDown(point: AuthoringPointerPoint): boolean;
  pointerMove(point: AuthoringPointerPoint): boolean;
  pointerUp(point: AuthoringPointerPoint): boolean;
}

export class EditorViewport {
  readonly controller: CameraController;
  readonly terrain: TerrainQuadtreeRenderer;
  readonly fillDebug: LakeFillHeightDebugRenderer;
  readonly authoringOverlay = new AuthoringOverlay();
  readonly stats = new Stats();
  backend: 'webgpu' | 'webgl' = 'webgl';

  private readonly scene = new THREE.Scene();
  private readonly raycaster = new THREE.Raycaster();
  private readonly water: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>;
  private tileGrid: THREE.GridHelper | null = null;
  private rendererAdapter: RendererAdapter | null = null;
  private lastFrameTime = performance.now();
  private frame = 0;
  private disposed = false;
  private animationFrame: number | null = null;
  private lastControlScaleCameraKey = '';
  private waterSettings: WaterSettings = { visible: false, level: 0 };
  private authoringHandlers: AuthoringPointerHandlers | null = null;
  private authoringPointerId: number | null = null;
  private inputLocked = false;
  private fillDebugVisible = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly container: HTMLElement,
    private readonly manager: TileManager,
    private readonly onHoverCoordinates?: (coordinates: HoverCoordinates | null) => void
  ) {
    this.controller = new CameraController(canvas, manager);
    this.terrain = new TerrainQuadtreeRenderer(manager);
    this.fillDebug = new LakeFillHeightDebugRenderer(manager);
    const waterGeometry = new THREE.PlaneGeometry(1, 1, 1, 1);
    waterGeometry.rotateX(-Math.PI / 2);
    const waterMaterial = new THREE.MeshStandardMaterial({
      color: 0x76d0ff,
      transparent: true,
      opacity: 0.34,
      roughness: 0.22,
      metalness: 0,
      depthWrite: false
    });
    this.water = new THREE.Mesh(waterGeometry, waterMaterial);
    this.water.visible = false;
    this.water.renderOrder = 8;
  }

  async init(): Promise<void> {
    this.rendererAdapter = await createRenderer(this.canvas);
    this.backend = this.rendererAdapter.backend;
    this.scene.background = new THREE.Color(0x0c1116);
    this.scene.fog = new THREE.FogExp2(0x0c1116, 0.000045);
    this.scene.add(this.terrain.group);
    this.scene.add(this.fillDebug.group);
    this.scene.add(this.water);
    this.scene.add(this.authoringOverlay.group);
    this.scene.add(new THREE.HemisphereLight(0xcdeaff, 0x30402d, 1.8));

    const sun = new THREE.DirectionalLight(0xffffff, 2.4);
    sun.position.set(5000, 7000, 3000);
    this.scene.add(sun);

    this.addGizmo();

    this.stats.showPanel(0);
    this.stats.dom.classList.add('stats-panel');
    this.container.appendChild(this.stats.dom);
    if (ENABLE_TERRAIN_RAYCAST) {
      this.canvas.addEventListener('pointermove', this.onPointerMove);
      this.canvas.addEventListener('pointerleave', this.onPointerLeave);
    }
    this.canvas.addEventListener('pointerdown', this.onAuthoringPointerDown);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('pointermove', this.onAuthoringPointerMove);
    window.addEventListener('pointerup', this.onAuthoringPointerUp);
    this.resize();
    this.animate();
  }

  setMode(mode: ViewMode): void {
    this.controller.setMode(mode);
    this.terrain.setViewMode(mode);
  }

  setVisualizationMode(mode: VisualizationMode): void {
    this.terrain.setVisualizationMode(mode);
  }

  setLodAggression(aggression: number): void {
    this.terrain.setLodSettings({ aggression });
  }

  setWater(settings: WaterSettings): void {
    this.waterSettings = settings;
    this.updateWaterPlane();
  }

  resize(): void {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    this.rendererAdapter?.renderer.setSize(width, height, false);
    this.controller.resize(width, height);
    this.terrain.setViewportSize(width, height);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.animationFrame !== null) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }
    this.stats.dom.remove();
    this.controller.dispose();
    this.terrain.dispose();
    this.fillDebug.dispose();
    if (ENABLE_TERRAIN_RAYCAST) {
      this.canvas.removeEventListener('pointermove', this.onPointerMove);
      this.canvas.removeEventListener('pointerleave', this.onPointerLeave);
    }
    this.canvas.removeEventListener('pointerdown', this.onAuthoringPointerDown);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('pointermove', this.onAuthoringPointerMove);
    window.removeEventListener('pointerup', this.onAuthoringPointerUp);
    this.water.geometry.dispose();
    this.water.material.dispose();
    this.disposeTileGrid();
    this.authoringOverlay.dispose();
    this.rendererAdapter?.renderer.dispose();
  }

  setAuthoringInputHandlers(handlers: AuthoringPointerHandlers | null): void {
    this.authoringHandlers = handlers;
  }

  setInputLocked(locked: boolean): void {
    this.inputLocked = locked;
    this.controller.setInputLocked(locked);
    if (locked) {
      this.authoringPointerId = null;
      this.onHoverCoordinates?.(null);
    }
  }

  setAuthoringDocument(document: AuthoringDocumentV1 | null): void {
    this.authoringOverlay.setDocument(document);
  }

  setAuthoringSelection(selection: AuthoringSelection): void {
    this.authoringOverlay.setSelection(selection);
  }

  setAuthoringPreview(anchors: AnchorV1[]): void {
    this.authoringOverlay.setPreviewAnchors(anchors);
  }

  setAuthoringVisible(visible: boolean): void {
    this.authoringOverlay.setVisible(visible);
    this.updateTileGrid();
  }

  getWorldUnitsPerScreenPixelAt(x: number, z: number): number {
    return this.worldUnitsPerScreenPixelAt(new THREE.Vector3(x, this.waterSettings.level + 2, z));
  }

  refreshTerrain(): void {
    this.terrain.clear();
    this.fillDebug.clear();
    if (this.fillDebugVisible) {
      void this.fillDebug.rebuild();
    } else {
      void this.terrain.update(this.controller.activeCamera);
    }
  }

  private animate = (): void => {
    if (this.disposed) return;
    this.animationFrame = requestAnimationFrame(this.animate);
    this.stats.begin();
    const now = performance.now();
    const delta = Math.min(0.1, (now - this.lastFrameTime) / 1000);
    this.lastFrameTime = now;
    this.controller.update(delta);
    this.updateAuthoringControlScale();
    if (!this.fillDebugVisible && this.frame % TERRAIN_UPDATE_INTERVAL_FRAMES === 0) void this.terrain.update(this.controller.activeCamera);
    this.rendererAdapter?.renderer.render(this.scene, this.controller.activeCamera);
    this.frame += 1;
    this.stats.end();
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (this.inputLocked) return;
    if (!this.onHoverCoordinates || !this.manager.config) return;
    const rect = this.canvas.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((event.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1,
      -(((event.clientY - rect.top) / Math.max(1, rect.height)) * 2 - 1)
    );
    this.raycaster.setFromCamera(pointer, this.controller.activeCamera);
    const intersections = this.raycaster.intersectObjects(this.terrain.getRaycastTargets(), false);
    const hit = intersections.find((intersection) => intersection.object.visible);
    if (!hit) {
      this.onHoverCoordinates(null);
      return;
    }
    this.onHoverCoordinates({
      x: hit.point.x,
      y: hit.point.y,
      z: hit.point.z,
      unit: this.manager.config.unit
    });
  };

  private readonly onPointerLeave = (): void => {
    this.onHoverCoordinates?.(null);
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (this.inputLocked || event.repeat || event.code !== 'KeyO' || isTextInput(event.target)) return;
    this.setFillDebugVisible(!this.fillDebugVisible);
    event.preventDefault();
  };

  private setFillDebugVisible(visible: boolean): void {
    this.fillDebugVisible = visible;
    this.terrain.group.visible = !visible;
    this.fillDebug.setVisible(visible);
    this.water.visible = visible ? false : this.waterSettings.visible && Boolean(this.manager.config);
    if (!visible) {
      void this.terrain.update(this.controller.activeCamera);
    }
  }

  private readonly onAuthoringPointerDown = (event: PointerEvent): void => {
    if (this.inputLocked) return;
    if (event.button !== 0 || !this.authoringHandlers) return;
    const point = this.projectPointerToAuthoringPlane(event);
    if (!point) return;
    if (!this.authoringHandlers.pointerDown(point)) return;
    event.preventDefault();
    event.stopPropagation();
    this.authoringPointerId = event.pointerId;
    this.canvas.setPointerCapture(event.pointerId);
  };

  private readonly onAuthoringPointerMove = (event: PointerEvent): void => {
    if (this.inputLocked) return;
    if (!this.authoringHandlers || this.authoringPointerId !== event.pointerId) return;
    const point = this.projectPointerToAuthoringPlane(event);
    if (!point) return;
    if (this.authoringHandlers.pointerMove(point)) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  private readonly onAuthoringPointerUp = (event: PointerEvent): void => {
    if (this.inputLocked) return;
    if (!this.authoringHandlers || this.authoringPointerId !== event.pointerId) return;
    const point = this.projectPointerToAuthoringPlane(event);
    if (point && this.authoringHandlers.pointerUp(point)) {
      event.preventDefault();
      event.stopPropagation();
    }
    this.authoringPointerId = null;
  };

  private addGizmo(): void {
    const axes = new THREE.AxesHelper(550);
    axes.position.set(-900, 20, -900);
    this.scene.add(axes);
  }

  private updateWaterPlane(): void {
    const config = this.manager.config;
    this.water.visible = !this.fillDebugVisible && this.waterSettings.visible && Boolean(config);
    if (!config) return;
    const worldSize = config.tileSize * config.tilesPerSide * config.unitSize;
    const planeSize = Math.max(worldSize * 3, 10000);
    this.water.position.set(0, this.waterSettings.level, 0);
    this.water.scale.set(planeSize, 1, planeSize);
    this.authoringOverlay.setWaterLevel(this.waterSettings.level);
    this.updateTileGrid();
  }

  private updateTileGrid(): void {
    const config = this.manager.config;
    if (!config) {
      if (this.tileGrid) this.tileGrid.visible = false;
      return;
    }

    const worldSize = config.tileSize * config.tilesPerSide * config.unitSize;
    if (!this.tileGrid || this.tileGrid.userData.worldSize !== worldSize || this.tileGrid.userData.divisions !== config.tilesPerSide) {
      this.disposeTileGrid();
      this.tileGrid = new THREE.GridHelper(worldSize, config.tilesPerSide, 0x6f8f9b, 0x2c424a);
      this.tileGrid.userData.worldSize = worldSize;
      this.tileGrid.userData.divisions = config.tilesPerSide;
      this.tileGrid.renderOrder = 19;
      this.scene.add(this.tileGrid);
    }

    this.tileGrid.position.y = this.waterSettings.level + 1;
    this.tileGrid.visible = this.authoringOverlay.group.visible;
  }

  private updateAuthoringControlScale(): void {
    const pivot = this.authoringOverlay.getSelectedPivot();
    if (!pivot) return;
    const camera = this.controller.activeCamera;
    const cameraKey = this.getControlScaleCameraKey(camera);
    if (cameraKey === this.lastControlScaleCameraKey) return;
    this.lastControlScaleCameraKey = cameraKey;
    this.authoringOverlay.setControlWorldUnitsPerPixel(this.getWorldUnitsPerScreenPixelAt(pivot.x, pivot.z));
  }

  private worldUnitsPerScreenPixelAt(point: THREE.Vector3): number {
    const height = Math.max(1, this.container.clientHeight);
    const camera = this.controller.activeCamera;
    camera.updateMatrixWorld();
    if (camera instanceof THREE.OrthographicCamera) {
      return (camera.top - camera.bottom) / Math.max(0.0001, camera.zoom) / height;
    }
    if (camera instanceof THREE.PerspectiveCamera) {
      const dx = point.x - camera.position.x;
      const dy = point.y - camera.position.y;
      const dz = point.z - camera.position.z;
      const distance = Math.max(1, Math.hypot(dx, dy, dz));
      return (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * distance) / height;
    }
    return 2;
  }

  private getControlScaleCameraKey(camera: THREE.Camera): string {
    if (camera instanceof THREE.OrthographicCamera) {
      return `o:${camera.position.x.toFixed(2)}:${camera.position.z.toFixed(2)}:${camera.zoom.toFixed(4)}:${this.container.clientHeight}`;
    }
    if (camera instanceof THREE.PerspectiveCamera) {
      return `p:${camera.position.x.toFixed(2)}:${camera.position.y.toFixed(2)}:${camera.position.z.toFixed(2)}:${camera.quaternion.x.toFixed(4)}:${camera.quaternion.y.toFixed(4)}:${camera.quaternion.z.toFixed(4)}:${camera.quaternion.w.toFixed(4)}:${this.container.clientHeight}`;
    }
    return `${this.frame}`;
  }

  private disposeTileGrid(): void {
    if (!this.tileGrid) return;
    this.scene.remove(this.tileGrid);
    this.tileGrid.geometry.dispose();
    const material = this.tileGrid.material;
    if (Array.isArray(material)) {
      for (const item of material) item.dispose();
    } else {
      material.dispose();
    }
    this.tileGrid = null;
  }

  private projectPointerToAuthoringPlane(event: PointerEvent): AuthoringPointerPoint | null {
    const rect = this.canvas.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((event.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1,
      -(((event.clientY - rect.top) / Math.max(1, rect.height)) * 2 - 1)
    );
    this.raycaster.setFromCamera(pointer, this.controller.activeCamera);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -this.waterSettings.level);
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(plane, hit)) return null;
    return { x: hit.x, z: hit.z, event };
  }
}

function isTextInput(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;
}
