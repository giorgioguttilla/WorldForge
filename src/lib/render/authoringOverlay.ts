import * as THREE from 'three';
import type { AnchorV1, AuthoringDocumentV1, PrimitiveV1 } from '../authoring/authoringDocument';

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
      this.addPolyline(this.previewAnchors, false, 0xf2d678, true, false);
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
      if (primitive.anchors.length >= 3) this.addFill(primitive.anchors, primitive.mode === 'water' ? 0x5cb8ff : primitive.mode === 'plateau' ? 0xe0c46a : 0x75c28f);
      this.addPolyline(primitive.anchors, true, selected ? 0xffffff : 0x75c28f, selected, true);
      this.addAnchors(primitive.anchors, selected ? 0xffffff : 0x75c28f, selected);
      return;
    }
    this.addPolyline(primitive.anchors, false, selected ? 0xffffff : 0xd59a6f, selected, false);
    this.addAnchors(primitive.anchors, selected ? 0xffffff : 0xd59a6f, selected);
  }

  private addFill(anchors: AnchorV1[], color: number): void {
    const shape = new THREE.Shape(anchors.map((anchor) => new THREE.Vector2(anchor.x, anchor.z)));
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

  private addPolyline(anchors: AnchorV1[], closed: boolean, color: number, selected: boolean, canClose: boolean): void {
    if (anchors.length < 2) return;
    const points = anchors.map((anchor) => new THREE.Vector3(anchor.x, 0, anchor.z));
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
