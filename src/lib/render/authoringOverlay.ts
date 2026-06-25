import * as THREE from 'three';
import type { AnchorV1, AuthoringDocumentV1, PrimitiveV1 } from '../authoring/authoringDocument';
import { DEFAULT_SPLINE_SMOOTHNESS, sampleSplineAnchors, type SplinePoint2D } from '../authoring/spline';

export interface AuthoringSelection {
  primitiveId: string | null;
  anchorId: string | null;
}

export class AuthoringOverlay {
  readonly group = new THREE.Group();

  private document: AuthoringDocumentV1 | null = null;
  private selection: AuthoringSelection = { primitiveId: null, anchorId: null };
  private previewAnchors: AnchorV1[] = [];
  private visible = true;
  private waterLevel = 0;
  private readonly disposable: THREE.Object3D[] = [];

  constructor() {
    this.group.renderOrder = 20;
  }

  setDocument(document: AuthoringDocumentV1 | null): void {
    this.document = document;
    this.rebuild();
  }

  setSelection(selection: AuthoringSelection): void {
    this.selection = selection;
    this.rebuild();
  }

  setPreviewAnchors(anchors: AnchorV1[]): void {
    this.previewAnchors = anchors;
    this.rebuild();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.group.visible = visible;
  }

  setWaterLevel(waterLevel: number): void {
    this.waterLevel = waterLevel;
    this.group.position.y = waterLevel + 2;
  }

  dispose(): void {
    this.clear();
  }

  private rebuild(): void {
    this.clear();
    this.group.visible = this.visible;
    this.group.position.y = this.waterLevel + 2;
    for (const primitive of this.document?.primitives ?? []) {
      if (!primitive.enabled) continue;
      this.addPrimitive(primitive, primitive.id === this.selection.primitiveId);
    }
    if (this.previewAnchors.length > 0) {
      this.addPolyline(this.previewAnchors, false, 0xf2d678, true, false, DEFAULT_SPLINE_SMOOTHNESS);
      this.addAnchors(this.previewAnchors, 0xf2d678, false);
    }
  }

  private clear(): void {
    for (const object of this.disposable) {
      this.group.remove(object);
      object.traverse((child) => {
        const mesh = child as THREE.Mesh;
        mesh.geometry?.dispose();
        const material = mesh.material;
        if (Array.isArray(material)) {
          for (const item of material) item.dispose();
        } else {
          material?.dispose();
        }
      });
    }
    this.disposable.length = 0;
  }

  private addPrimitive(primitive: PrimitiveV1, selected: boolean): void {
    if (primitive.type === 'landformArea') {
      if (primitive.anchors.length >= 3) this.addFill(primitive.anchors, primitive.mode === 'water' ? 0x5cb8ff : primitive.mode === 'plateau' ? 0xe0c46a : 0x75c28f, primitive.splineSmoothness);
      this.addPolyline(primitive.anchors, true, selected ? 0xffffff : 0x75c28f, selected, true, primitive.splineSmoothness);
      this.addAnchors(primitive.anchors, selected ? 0xffffff : 0x75c28f, selected);
      return;
    }
    this.addSplineInfluence(primitive.anchors, primitive.width, selected ? 0xffffff : 0xd59a6f, selected, primitive.splineSmoothness);
    this.addSplineBody(primitive.anchors, selected ? 0xffffff : 0xd59a6f, selected, primitive.splineSmoothness);
    this.addPolyline(primitive.anchors, false, selected ? 0xffffff : 0xd59a6f, selected, false, primitive.splineSmoothness);
    this.addAnchors(primitive.anchors, selected ? 0xffffff : 0xd59a6f, selected);
  }

  private addFill(anchors: AnchorV1[], color: number, smoothness: number): void {
    const points = sampleSplineAnchors(anchors, true, smoothness);
    const shape = new THREE.Shape(points.map((point) => new THREE.Vector2(point.x, point.z)));
    const geometry = new THREE.ShapeGeometry(shape);
    geometry.rotateX(Math.PI / 2);
    const material = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.18,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = 21;
    this.track(mesh);
  }

  private addPolyline(anchors: AnchorV1[], closed: boolean, color: number, selected: boolean, canClose: boolean, smoothness: number): void {
    if (anchors.length < 2) return;
    const points = sampleSplineAnchors(anchors, closed, smoothness).map((point) => new THREE.Vector3(point.x, 0, point.z));
    if (closed && canClose) points.push(points[0].clone());
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity: selected ? 1 : 0.82,
      depthTest: false,
      depthWrite: false
    });
    const line = new THREE.Line(geometry, material);
    line.renderOrder = 23;
    this.track(line);
  }

  private addPointPolyline(points2d: SplinePoint2D[], closed: boolean, color: number, selected: boolean, opacity: number): void {
    if (points2d.length < 2) return;
    const points = points2d.map((point) => new THREE.Vector3(point.x, -0.4, point.z));
    if (closed) points.push(points[0].clone());
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity: selected ? Math.max(opacity, 0.45) : opacity,
      depthTest: false,
      depthWrite: false
    });
    const line = new THREE.Line(geometry, material);
    line.renderOrder = 21;
    this.track(line);
  }

  private addSplineBody(anchors: AnchorV1[], color: number, selected: boolean, smoothness: number): void {
    if (anchors.length < 2) return;
    const points = sampleSplineAnchors(anchors, false, smoothness);
    const material = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: selected ? 0.34 : 0.22,
      depthTest: false,
      depthWrite: false
    });
    for (let i = 0; i < points.length - 1; i += 1) {
      const a = points[i];
      const b = points[i + 1];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const length = Math.hypot(dx, dz);
      if (length <= 0) continue;
      const geometry = new THREE.CylinderGeometry(selected ? 13 : 9, selected ? 13 : 9, length, 10, 1);
      geometry.rotateZ(Math.PI / 2);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set((a.x + b.x) / 2, 0, (a.z + b.z) / 2);
      mesh.rotation.y = -Math.atan2(dz, dx);
      mesh.renderOrder = 22;
      this.track(mesh);
    }
  }

  private addSplineInfluence(anchors: AnchorV1[], width: number, color: number, selected: boolean, smoothness: number): void {
    if (anchors.length < 2 || width <= 0) return;
    const radius = width / 2;
    const sampled = sampleSplineAnchors(anchors, false, smoothness);
    const corridor = buildCorridorPolygon(sampled, radius);
    if (corridor.length < 3) return;
    const material = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: selected ? 0.13 : 0.08,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false
    });
    const shape = new THREE.Shape(corridor.map((point) => new THREE.Vector2(point.x, point.z)));
    const geometry = new THREE.ShapeGeometry(shape);
    geometry.rotateX(Math.PI / 2);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.y = -0.6;
    mesh.renderOrder = 20;
    this.track(mesh);

    this.addPointPolyline(corridor, true, color, selected, 0.22);
  }

  private addAnchors(anchors: AnchorV1[], color: number, selectedPrimitive: boolean): void {
    for (const anchor of anchors) {
      const selectedAnchor = selectedPrimitive && anchor.id === this.selection.anchorId;
      const geometry = new THREE.SphereGeometry(selectedAnchor ? 20 : 14, 12, 8);
      const material = new THREE.MeshBasicMaterial({
        color: selectedAnchor ? 0xf2d678 : color,
        depthTest: false,
        depthWrite: false
      });
      const sphere = new THREE.Mesh(geometry, material);
      sphere.position.set(anchor.x, 0, anchor.z);
      sphere.renderOrder = 24;
      this.track(sphere);
    }
  }

  private track(object: THREE.Object3D): void {
    this.group.add(object);
    this.disposable.push(object);
  }
}

function buildCorridorPolygon(points: SplinePoint2D[], radius: number): SplinePoint2D[] {
  const left: SplinePoint2D[] = [];
  const right: SplinePoint2D[] = [];
  for (let i = 0; i < points.length; i += 1) {
    const previous = points[Math.max(0, i - 1)];
    const next = points[Math.min(points.length - 1, i + 1)];
    const dx = next.x - previous.x;
    const dz = next.z - previous.z;
    const length = Math.hypot(dx, dz);
    if (length <= 0) continue;
    const nx = -dz / length;
    const nz = dx / length;
    left.push({ x: points[i].x + nx * radius, z: points[i].z + nz * radius });
    right.push({ x: points[i].x - nx * radius, z: points[i].z - nz * radius });
  }
  return [...left, ...right.reverse()];
}
