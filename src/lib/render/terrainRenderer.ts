import * as THREE from 'three';
import type { TileManager } from '../heightmap/tileManager';
import { r16ToElevation, type WorldConfig } from '../heightmap/worldConfig';
import type { TileKey } from '../heightmap/tileKey';

interface TerrainNode {
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>;
  key: string;
  inUse: boolean;
}

export class TerrainQuadtreeRenderer {
  readonly group = new THREE.Group();
  wireframe = false;

  private readonly pool: TerrainNode[] = [];
  private readonly active = new Map<string, TerrainNode>();
  private readonly maxVisibleTiles = 64;
  private updateQueued = false;
  private lastSelectionId = '';

  constructor(private readonly manager: TileManager) {}

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
    for (const node of this.active.values()) {
      node.inUse = false;
      node.mesh.visible = false;
    }
    this.active.clear();
    this.lastSelectionId = '';
    this.manager.setRenderMetrics(0, 0, 0);
  }

  private selectTiles(config: WorldConfig, camera: THREE.Camera): TileKey[] {
    const worldSize = config.tileSize * config.tilesPerSide * config.unitSize;
    let depth: number;

    if (camera instanceof THREE.OrthographicCamera) {
      const visibleHeight = (camera.top - camera.bottom) / Math.max(camera.zoom, 0.0001);
      const targetTileWorldSize = Math.max(1, visibleHeight / 2.6);
      depth = Math.floor(Math.log2(targetTileWorldSize / (config.tileSize * config.unitSize)));
    } else {
      const position = camera.position;
      const distance = Math.max(Math.abs(position.x), Math.abs(position.z), position.y);
      depth = 0;
      if (distance > worldSize * 1.2) depth = 2;
      else if (distance > worldSize * 0.55) depth = 1;
    }

    depth = Math.max(0, depth);
    depth = Math.min(depth, Math.log2(config.tilesPerSide));

    const side = config.tilesPerSide / 2 ** depth;
    const keys: TileKey[] = [];
    for (let y = 0; y < side; y += 1) {
      for (let x = 0; x < side; x += 1) {
        keys.push({ x, y, d: depth });
      }
    }
    return keys.slice(0, this.maxVisibleTiles);
  }

  private acquireNode(id: string, config: WorldConfig, visible = true): TerrainNode {
    const unused = this.pool.find((node) => !node.inUse);
    if (unused) {
      unused.inUse = true;
      unused.key = id;
      unused.mesh.visible = visible;
      unused.mesh.material.wireframe = this.wireframe;
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
    node.mesh.visible = false;
  }

  private updateMetrics(): void {
    const vertices = [...this.active.values()].reduce((sum, node) => sum + node.mesh.geometry.attributes.position.count, 0);
    const triangles = [...this.active.values()].reduce((sum, node) => sum + (node.mesh.geometry.index?.count ?? 0) / 3, 0);
    this.manager.setRenderMetrics(this.active.size, vertices, triangles);
  }
}
