import Stats from 'stats.js';
import * as THREE from 'three';
import type { TileManager } from '../heightmap/tileManager';
import { CameraController, type ViewMode } from './cameraController';
import { createRenderer, type RendererAdapter } from './rendererAdapter';
import { TerrainQuadtreeRenderer, type VisualizationMode } from './terrainRenderer';
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
  readonly authoringOverlay = new AuthoringOverlay();
  readonly stats = new Stats();
  backend: 'webgpu' | 'webgl' = 'webgl';

  private readonly scene = new THREE.Scene();
  private readonly raycaster = new THREE.Raycaster();
  private readonly water: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>;
  private rendererAdapter: RendererAdapter | null = null;
  private lastFrameTime = performance.now();
  private frame = 0;
  private disposed = false;
  private waterSettings: WaterSettings = { visible: false, level: 0 };
  private authoringHandlers: AuthoringPointerHandlers | null = null;
  private authoringPointerId: number | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly container: HTMLElement,
    private readonly manager: TileManager,
    private readonly onHoverCoordinates?: (coordinates: HoverCoordinates | null) => void
  ) {
    this.controller = new CameraController(canvas, manager);
    this.terrain = new TerrainQuadtreeRenderer(manager);
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
    this.scene.add(this.water);
    this.scene.add(this.authoringOverlay.group);
    this.scene.add(new THREE.HemisphereLight(0xcdeaff, 0x30402d, 1.8));

    const sun = new THREE.DirectionalLight(0xffffff, 2.4);
    sun.position.set(5000, 7000, 3000);
    this.scene.add(sun);

    const grid = new THREE.GridHelper(12000, 48, 0x39515a, 0x1c2a30);
    this.scene.add(grid);
    this.addGizmo();

    this.stats.showPanel(0);
    this.stats.dom.classList.add('stats-panel');
    this.container.appendChild(this.stats.dom);
    if (ENABLE_TERRAIN_RAYCAST) {
      this.canvas.addEventListener('pointermove', this.onPointerMove);
      this.canvas.addEventListener('pointerleave', this.onPointerLeave);
    }
    this.canvas.addEventListener('pointerdown', this.onAuthoringPointerDown);
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
    this.disposed = true;
    this.stats.dom.remove();
    this.controller.dispose();
    this.terrain.dispose();
    if (ENABLE_TERRAIN_RAYCAST) {
      this.canvas.removeEventListener('pointermove', this.onPointerMove);
      this.canvas.removeEventListener('pointerleave', this.onPointerLeave);
    }
    this.canvas.removeEventListener('pointerdown', this.onAuthoringPointerDown);
    window.removeEventListener('pointermove', this.onAuthoringPointerMove);
    window.removeEventListener('pointerup', this.onAuthoringPointerUp);
    this.water.geometry.dispose();
    this.water.material.dispose();
    this.authoringOverlay.dispose();
    this.rendererAdapter?.renderer.dispose();
  }

  setAuthoringInputHandlers(handlers: AuthoringPointerHandlers | null): void {
    this.authoringHandlers = handlers;
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
  }

  refreshTerrain(): void {
    this.terrain.clear();
    void this.terrain.update(this.controller.activeCamera);
  }

  private animate = (): void => {
    if (this.disposed) return;
    requestAnimationFrame(this.animate);
    this.stats.begin();
    const now = performance.now();
    const delta = Math.min(0.1, (now - this.lastFrameTime) / 1000);
    this.lastFrameTime = now;
    this.controller.update(delta);
    if (this.frame % TERRAIN_UPDATE_INTERVAL_FRAMES === 0) void this.terrain.update(this.controller.activeCamera);
    this.rendererAdapter?.renderer.render(this.scene, this.controller.activeCamera);
    this.frame += 1;
    this.stats.end();
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
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

  private readonly onAuthoringPointerDown = (event: PointerEvent): void => {
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
    if (!this.authoringHandlers || this.authoringPointerId !== event.pointerId) return;
    const point = this.projectPointerToAuthoringPlane(event);
    if (!point) return;
    if (this.authoringHandlers.pointerMove(point)) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  private readonly onAuthoringPointerUp = (event: PointerEvent): void => {
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
    this.water.visible = this.waterSettings.visible && Boolean(config);
    if (!config) return;
    const worldSize = config.tileSize * config.tilesPerSide * config.unitSize;
    const planeSize = Math.max(worldSize * 3, 10000);
    this.water.position.set(0, this.waterSettings.level, 0);
    this.water.scale.set(planeSize, 1, planeSize);
    this.authoringOverlay.setWaterLevel(this.waterSettings.level);
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
