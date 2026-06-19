import Stats from 'stats.js';
import * as THREE from 'three';
import type { TileManager } from '../heightmap/tileManager';
import { CameraController, type ViewMode } from './cameraController';
import { createRenderer, type RendererAdapter } from './rendererAdapter';
import { TerrainQuadtreeRenderer } from './terrainRenderer';

export class EditorViewport {
  readonly controller: CameraController;
  readonly terrain: TerrainQuadtreeRenderer;
  readonly stats = new Stats();
  backend: 'webgpu' | 'webgl' = 'webgl';

  private readonly scene = new THREE.Scene();
  private rendererAdapter: RendererAdapter | null = null;
  private lastFrameTime = performance.now();
  private frame = 0;
  private disposed = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly container: HTMLElement,
    private readonly manager: TileManager
  ) {
    this.controller = new CameraController(canvas);
    this.terrain = new TerrainQuadtreeRenderer(manager);
  }

  async init(): Promise<void> {
    this.rendererAdapter = await createRenderer(this.canvas);
    this.backend = this.rendererAdapter.backend;
    this.scene.background = new THREE.Color(0x0c1116);
    this.scene.fog = new THREE.FogExp2(0x0c1116, 0.000045);
    this.scene.add(this.terrain.group);
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
    this.resize();
    this.animate();
  }

  setMode(mode: ViewMode): void {
    this.controller.setMode(mode);
  }

  setWireframe(enabled: boolean): void {
    this.terrain.wireframe = enabled;
    for (const child of this.terrain.group.children) {
      const mesh = child as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
      if (mesh.material) mesh.material.wireframe = enabled;
    }
  }

  resize(): void {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    this.rendererAdapter?.renderer.setSize(width, height, false);
    this.controller.resize(width, height);
  }

  dispose(): void {
    this.disposed = true;
    this.stats.dom.remove();
    this.controller.dispose();
    this.terrain.dispose();
    this.rendererAdapter?.renderer.dispose();
  }

  private animate = (): void => {
    if (this.disposed) return;
    requestAnimationFrame(this.animate);
    this.stats.begin();
    const now = performance.now();
    const delta = Math.min(0.1, (now - this.lastFrameTime) / 1000);
    this.lastFrameTime = now;
    this.controller.update(delta);
    if (this.frame % 20 === 0) void this.terrain.update(this.controller.activeCamera);
    this.rendererAdapter?.renderer.render(this.scene, this.controller.activeCamera);
    this.frame += 1;
    this.stats.end();
  };

  private addGizmo(): void {
    const axes = new THREE.AxesHelper(550);
    axes.position.set(-900, 20, -900);
    this.scene.add(axes);
  }
}
