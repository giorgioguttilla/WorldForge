import * as THREE from 'three';
import type { TileManager } from '../heightmap/tileManager';
import { r16ToElevation, type WorldConfig } from '../heightmap/worldConfig';
import type { TileKey } from '../heightmap/tileKey';

export type VisualizationMode = 'wireframe' | 'topo' | 'render';

const TOPO_LOW = new THREE.Color(0x173824);
const TOPO_MID = new THREE.Color(0x5aa36e);
const TOPO_HIGH = new THREE.Color(0xe4f6bc);
const TOPO_COLOR = new THREE.Color();

interface TerrainNode {
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>;
  key: string;
  inUse: boolean;
}

interface TileBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  centerX: number;
  centerZ: number;
  size: number;
}

export class TerrainQuadtreeRenderer {
  readonly group = new THREE.Group();
  visualizationMode: VisualizationMode = 'topo';

  private readonly pool: TerrainNode[] = [];
  private readonly active = new Map<string, TerrainNode>();
  private updateQueued = false;
  private lastSelectionId = '';
  private viewportHeight = 720;
  private readonly sparePoolNodes = 8;

  constructor(private readonly manager: TileManager) {}

  setViewportSize(_width: number, height: number): void {
    this.viewportHeight = Math.max(1, height);
  }

  async update(camera: THREE.Camera): Promise<void> {
    if (this.updateQueued) return;
    this.updateQueued = true;
    try {
      const config = this.manager.config;
      if (!config) return;

      const keys = this.selectTiles(config, camera);
      const nextSelectionId = keys.map((key) => `${key.d}:${key.x}:${key.y}`).join('|');
      if (nextSelectionId === this.lastSelectionId) {
        this.updateMetrics();
        return;
      }

      const nextActive = new Map<string, TerrainNode>();
      for (const key of keys) {
        const id = `${key.d}:${key.x}:${key.y}`;
        const existing = this.active.get(id);
        if (existing) {
          nextActive.set(id, existing);
          continue;
        }
        const node = this.acquireNode(id, config, false);
        await this.populateNode(node, key, config);
        nextActive.set(id, node);
      }

      for (const [id, node] of this.active) {
        if (!nextActive.has(id)) {
          node.inUse = false;
          node.mesh.visible = false;
        }
      }

      this.active.clear();
      for (const [id, node] of nextActive) {
        node.inUse = true;
        node.mesh.visible = true;
        this.active.set(id, node);
      }
      this.lastSelectionId = nextSelectionId;
      this.trimUnusedPool();
      this.updateMetrics();
    } finally {
      this.updateQueued = false;
    }
  }

  dispose(): void {
    for (const node of this.pool) {
      node.mesh.geometry.dispose();
      node.mesh.material.dispose();
    }
    this.pool.length = 0;
    this.active.clear();
  }

  clear(): void {
    for (const node of this.pool) {
      this.group.remove(node.mesh);
      node.mesh.geometry.dispose();
      node.mesh.material.dispose();
    }
    this.pool.length = 0;
    this.active.clear();
    this.lastSelectionId = '';
    this.manager.setRenderMetrics(0, 0, 0);
  }

  setVisualizationMode(mode: VisualizationMode): void {
    this.visualizationMode = mode;
    for (const node of this.pool) {
      this.applyVisualizationMode(node.mesh.material);
    }
  }

  private selectTiles(config: WorldConfig, camera: THREE.Camera): TileKey[] {
    const maxDepth = Math.log2(config.tilesPerSide);
    const keys: TileKey[] = [];
    const root: TileKey = { x: 0, y: 0, d: maxDepth };
    const visit = (key: TileKey): void => {
      const bounds = this.getTileBounds(config, key);
      if (!this.shouldRenderTile(bounds, camera)) return;
      if (key.d > 0 && this.shouldSubdivide(config, key, bounds, camera)) {
        const childDepth = key.d - 1;
        const childX = key.x * 2;
        const childY = key.y * 2;
        visit({ x: childX, y: childY, d: childDepth });
        visit({ x: childX + 1, y: childY, d: childDepth });
        visit({ x: childX, y: childY + 1, d: childDepth });
        visit({ x: childX + 1, y: childY + 1, d: childDepth });
        return;
      }
      keys.push(key);
    };

    visit(root);
    return keys.sort((a, b) => b.d - a.d || a.y - b.y || a.x - b.x);
  }

  private shouldRenderTile(bounds: TileBounds, camera: THREE.Camera): boolean {
    if (!(camera instanceof THREE.OrthographicCamera)) return true;

    const visibleHeight = (camera.top - camera.bottom) / Math.max(camera.zoom, 0.0001);
    const visibleWidth = (camera.right - camera.left) / Math.max(camera.zoom, 0.0001);
    const margin = bounds.size * 0.15;
    const minX = camera.position.x - visibleWidth / 2 - margin;
    const maxX = camera.position.x + visibleWidth / 2 + margin;
    const minZ = camera.position.z - visibleHeight / 2 - margin;
    const maxZ = camera.position.z + visibleHeight / 2 + margin;

    return bounds.maxX >= minX && bounds.minX <= maxX && bounds.maxZ >= minZ && bounds.minZ <= maxZ;
  }

  private shouldSubdivide(config: WorldConfig, key: TileKey, bounds: TileBounds, camera: THREE.Camera): boolean {
    if (key.d <= 0) return false;
    if (camera instanceof THREE.OrthographicCamera) {
      const visibleHeight = (camera.top - camera.bottom) / Math.max(camera.zoom, 0.0001);
      const tileScreenPx = (bounds.size / visibleHeight) * this.viewportHeight;
      return tileScreenPx > 620;
    }

    const distance = Math.max(1, this.distanceToBounds(camera.position.x, camera.position.z, bounds));
    const perspective = camera as THREE.PerspectiveCamera;
    const visibleWorldHeight = 2 * distance * Math.tan(THREE.MathUtils.degToRad(perspective.fov) / 2);
    const tileScreenPx = (bounds.size / Math.max(1, visibleWorldHeight)) * this.viewportHeight;
    const worldSize = config.tileSize * config.tilesPerSide * config.unitSize;
    const nearBias = distance < worldSize * 0.42;
    return tileScreenPx > (nearBias ? 420 : 560);
  }

  private getTileBounds(config: WorldConfig, key: TileKey): TileBounds {
    const size = config.tileSize * config.unitSize * 2 ** key.d;
    const worldSize = config.tileSize * config.tilesPerSide * config.unitSize;
    const minX = key.x * size - worldSize / 2;
    const minZ = key.y * size - worldSize / 2;
    return {
      minX,
      minZ,
      maxX: minX + size,
      maxZ: minZ + size,
      centerX: minX + size / 2,
      centerZ: minZ + size / 2,
      size
    };
  }

  private distanceToBounds(x: number, z: number, bounds: TileBounds): number {
    const dx = x < bounds.minX ? bounds.minX - x : x > bounds.maxX ? x - bounds.maxX : 0;
    const dz = z < bounds.minZ ? bounds.minZ - z : z > bounds.maxZ ? z - bounds.maxZ : 0;
    return Math.hypot(dx, dz);
  }

  private acquireNode(id: string, config: WorldConfig, visible = true): TerrainNode {
    const unused = this.pool.find((node) => !node.inUse);
    if (unused) {
      unused.inUse = true;
      unused.key = id;
      unused.mesh.visible = visible;
      this.applyVisualizationMode(unused.mesh.material);
      return unused;
    }

    const segments = Math.min(64, Math.max(8, config.tileSize / 16));
    const geometry = new THREE.PlaneGeometry(config.tileSize * config.unitSize, config.tileSize * config.unitSize, segments, segments);
    geometry.rotateX(-Math.PI / 2);
    const material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.88,
      metalness: 0.02
    });
    this.applyVisualizationMode(material);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    this.group.add(mesh);
    mesh.visible = visible;
    const node = { mesh, key: id, inUse: true };
    this.pool.push(node);
    return node;
  }

  private async populateNode(node: TerrainNode, key: TileKey, config: WorldConfig): Promise<void> {
    const samples = await this.manager.readTile(key);
    const geometry = node.mesh.geometry;
    const positions = geometry.attributes.position as THREE.BufferAttribute;
    const colors = this.ensureColorAttribute(geometry);
    const tileWorldSize = config.tileSize * config.unitSize * 2 ** key.d;
    const originX = (key.x + 0.5) * tileWorldSize - (config.tilesPerSide * config.tileSize * config.unitSize) / 2;
    const originZ = (key.y + 0.5) * tileWorldSize - (config.tilesPerSide * config.tileSize * config.unitSize) / 2;

    for (let i = 0; i < positions.count; i += 1) {
      const localX = positions.getX(i);
      const localZ = positions.getZ(i);
      const u = Math.max(0, Math.min(1, localX / (config.tileSize * config.unitSize) + 0.5));
      const v = Math.max(0, Math.min(1, localZ / (config.tileSize * config.unitSize) + 0.5));
      const sx = Math.min(config.tileSize - 1, Math.floor(u * (config.tileSize - 1)));
      const sy = Math.min(config.tileSize - 1, Math.floor(v * (config.tileSize - 1)));
      const rawHeight = samples[sy * config.tileSize + sx];
      const height01 = rawHeight / 65535;
      positions.setY(i, r16ToElevation(rawHeight, config.worldHeight));
      this.setTopoColor(colors, i, height01);
    }

    positions.needsUpdate = true;
    colors.needsUpdate = true;
    geometry.computeVertexNormals();
    node.mesh.position.set(originX, 0, originZ);
    node.mesh.scale.set(2 ** key.d, 1, 2 ** key.d);
    this.applyVisualizationMode(node.mesh.material);
    node.mesh.visible = false;
  }

  private updateMetrics(): void {
    const vertices = [...this.active.values()].reduce((sum, node) => sum + node.mesh.geometry.attributes.position.count, 0);
    const triangles = [...this.active.values()].reduce((sum, node) => sum + (node.mesh.geometry.index?.count ?? 0) / 3, 0);
    this.manager.setRenderMetrics(this.active.size, vertices, triangles);
  }

  private trimUnusedPool(): void {
    let spareCount = 0;
    for (let i = this.pool.length - 1; i >= 0; i -= 1) {
      const node = this.pool[i];
      if (node.inUse) continue;
      spareCount += 1;
      if (spareCount <= this.sparePoolNodes) continue;
      this.group.remove(node.mesh);
      node.mesh.geometry.dispose();
      node.mesh.material.dispose();
      this.pool.splice(i, 1);
    }
  }

  private applyVisualizationMode(material: THREE.MeshStandardMaterial): void {
    material.wireframe = this.visualizationMode === 'wireframe';
    material.vertexColors = this.visualizationMode === 'topo';
    material.color.set(this.visualizationMode === 'render' ? 0xf4f3ee : 0xdff8e9);
    material.roughness = this.visualizationMode === 'render' ? 0.96 : 0.82;
    material.metalness = 0;
    material.needsUpdate = true;
  }

  private ensureColorAttribute(geometry: THREE.PlaneGeometry): THREE.BufferAttribute {
    const existing = geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
    if (existing) return existing;
    const colors = new Float32Array(geometry.attributes.position.count * 3);
    const attribute = new THREE.BufferAttribute(colors, 3);
    geometry.setAttribute('color', attribute);
    return attribute;
  }

  private setTopoColor(colors: THREE.BufferAttribute, index: number, height01: number): void {
    const t = THREE.MathUtils.clamp(height01, 0, 1);
    if (t < 0.62) {
      TOPO_COLOR.copy(TOPO_LOW).lerp(TOPO_MID, t / 0.62);
    } else {
      TOPO_COLOR.copy(TOPO_MID).lerp(TOPO_HIGH, (t - 0.62) / 0.38);
    }
    colors.setXYZ(index, TOPO_COLOR.r, TOPO_COLOR.g, TOPO_COLOR.b);
  }
}
