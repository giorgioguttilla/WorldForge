import * as THREE from 'three';
import type { TileManager } from '../heightmap/tileManager';
import { r16ToElevation, type WorldConfig } from '../heightmap/worldConfig';
import type { TileKey } from '../heightmap/tileKey';

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
  wireframe = false;

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

  setWireframe(enabled: boolean): void {
    this.wireframe = enabled;
    for (const node of this.pool) {
      node.mesh.material.wireframe = enabled;
      node.mesh.material.needsUpdate = true;
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
      unused.mesh.material.wireframe = this.wireframe;
      unused.mesh.material.needsUpdate = true;
      return unused;
    }

    const segments = Math.min(64, Math.max(8, config.tileSize / 16));
    const geometry = new THREE.PlaneGeometry(config.tileSize * config.unitSize, config.tileSize * config.unitSize, segments, segments);
    geometry.rotateX(-Math.PI / 2);
    const material = new THREE.MeshStandardMaterial({
      color: 0x7db294,
      roughness: 0.88,
      metalness: 0.02,
      wireframe: this.wireframe
    });
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
      positions.setY(i, r16ToElevation(samples[sy * config.tileSize + sx], config.worldHeight));
    }

    positions.needsUpdate = true;
    geometry.computeVertexNormals();
    node.mesh.position.set(originX, 0, originZ);
    node.mesh.scale.set(2 ** key.d, 1, 2 ** key.d);
    node.mesh.material.wireframe = this.wireframe;
    node.mesh.material.needsUpdate = true;
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
}
