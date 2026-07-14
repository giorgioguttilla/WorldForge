import * as THREE from 'three';
import type { AnchorV1, AuthoringDocumentV1, HydrologyPointV1, HydrologySceneV1, PrimitiveV1 } from '../authoring/authoringDocument';
import { DEFAULT_SPLINE_SMOOTHNESS, sampleSplineAnchors, type SplinePoint2D } from '../authoring/spline';
import { LAKE_RING_SIMPLIFY_TOLERANCE_CELLS, simplifyLakeRing } from '../authoring/hydrologyAuthoring';
import { r16ToElevation, type WorldConfig } from '../heightmap/worldConfig';

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
  private controlWorldUnitsPerPixel = 2;
  private transformControlsGroup: THREE.Group | null = null;
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

  setControlWorldUnitsPerPixel(worldUnitsPerPixel: number): void {
    const next = Math.max(0.05, worldUnitsPerPixel);
    if (Math.abs(next - this.controlWorldUnitsPerPixel) < 0.0001) return;
    this.controlWorldUnitsPerPixel = next;
    this.transformControlsGroup?.scale.setScalar(next);
  }

  getSelectedPivot(): SplinePoint2D | null {
    const primitive = this.document?.primitives.find((item) => item.id === this.selection.primitiveId);
    if (!primitive) return null;
    return getTransformControls(primitive.anchors)?.pivot ?? null;
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
    this.transformControlsGroup = null;
  }

  private addPrimitive(primitive: PrimitiveV1, selected: boolean): void {
    if (primitive.type === 'landformArea') {
      if (primitive.anchors.length >= 3) this.addFill(primitive.anchors, primitive.mode === 'water' ? 0x5cb8ff : primitive.mode === 'plateau' ? 0xe0c46a : 0x75c28f, primitive.splineSmoothness);
      this.addPolyline(primitive.anchors, true, selected ? 0xffffff : 0x75c28f, selected, true, primitive.splineSmoothness);
      this.addAnchors(primitive.anchors, selected ? 0xffffff : 0x75c28f, selected);
      if (selected) this.addTransformControls(primitive.anchors);
      return;
    }
    this.addSplineInfluence(primitive.anchors, primitive.width, selected ? 0xffffff : 0xd59a6f, selected, primitive.splineSmoothness);
    this.addSplineBody(primitive.anchors, selected ? 0xffffff : 0xd59a6f, selected, primitive.splineSmoothness);
    this.addPolyline(primitive.anchors, false, selected ? 0xffffff : 0xd59a6f, selected, false, primitive.splineSmoothness);
    this.addAnchors(primitive.anchors, selected ? 0xffffff : 0xd59a6f, selected);
    if (selected) this.addTransformControls(primitive.anchors);
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

  private addTransformControls(anchors: AnchorV1[]): void {
    const controls = getTransformControls(anchors);
    if (!controls) return;
    const controlGroup = new THREE.Group();
    controlGroup.position.set(controls.pivot.x, 0, controls.pivot.z);
    controlGroup.scale.setScalar(this.controlWorldUnitsPerPixel);
    controlGroup.renderOrder = 29;
    this.transformControlsGroup = controlGroup;

    const translateGeometry = new THREE.SphereGeometry(10, 18, 12);
    const translateMaterial = new THREE.MeshBasicMaterial({
      color: 0x8ee8ff,
      depthTest: false,
      depthWrite: false
    });
    const translate = new THREE.Mesh(translateGeometry, translateMaterial);
    translate.position.set(0, 9, 0);
    translate.renderOrder = 30;
    controlGroup.add(translate);
    this.addTransformArrow(controlGroup, { x: 0, z: 0 }, { x: controls.arrowLength, z: 0 }, 0xff6b6b);
    this.addTransformArrow(controlGroup, { x: 0, z: 0 }, { x: 0, z: controls.arrowLength }, 0x74d77e);

    const ringGeometry = new THREE.RingGeometry(controls.radius - controls.ringWidth / 2, controls.radius + controls.ringWidth / 2, 48);
    ringGeometry.rotateX(-Math.PI / 2);
    const ringMaterial = new THREE.MeshBasicMaterial({
      color: 0x8ee8ff,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false
    });
    const ring = new THREE.Mesh(ringGeometry, ringMaterial);
    ring.position.set(0, 3.5, 0);
    ring.renderOrder = 29;
    controlGroup.add(ring);
    this.addRotationTicks(controlGroup, controls);
    this.track(controlGroup);
  }

  private addRotationTicks(group: THREE.Group, controls: { radius: number; ringWidth: number }): void {
    const material = new THREE.LineBasicMaterial({
      color: 0xe7fbff,
      depthTest: false,
      depthWrite: false
    });
    const tickCount = 16;
    const points: THREE.Vector3[] = [];
    for (let i = 0; i < tickCount; i += 1) {
      const angle = (i / tickCount) * Math.PI * 2;
      const inner = controls.radius - controls.ringWidth * 0.45;
      const outer = controls.radius + controls.ringWidth * 0.45;
      points.push(
        new THREE.Vector3(Math.cos(angle) * inner, 4.5, Math.sin(angle) * inner),
        new THREE.Vector3(Math.cos(angle) * outer, 4.5, Math.sin(angle) * outer)
      );
    }
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const ticks = new THREE.LineSegments(geometry, material);
    ticks.renderOrder = 30;
    group.add(ticks);
  }

  private addTransformArrow(group: THREE.Group, pivot: SplinePoint2D, offset: SplinePoint2D, color: number): void {
    const length = Math.hypot(offset.x, offset.z);
    if (length <= 0) return;
    const angle = Math.atan2(offset.z, offset.x);
    const shaftLength = length * 0.72;
    const thickness = Math.max(2, length * 0.075);
    const shaftGeometry = new THREE.CylinderGeometry(thickness, thickness, shaftLength, 12, 1);
    shaftGeometry.rotateZ(Math.PI / 2);
    const material = new THREE.MeshBasicMaterial({
      color,
      depthTest: false,
      depthWrite: false
    });
    const shaft = new THREE.Mesh(shaftGeometry, material);
    shaft.position.set(
      pivot.x + Math.cos(angle) * shaftLength * 0.5,
      thickness * 2.6,
      pivot.z + Math.sin(angle) * shaftLength * 0.5
    );
    shaft.rotation.y = -angle;
    shaft.renderOrder = 30;
    group.add(shaft);

    const coneGeometry = new THREE.ConeGeometry(thickness * 2.8, thickness * 5.6, 16, 1);
    coneGeometry.rotateZ(-Math.PI / 2);
    const cone = new THREE.Mesh(coneGeometry, material);
    cone.position.set(pivot.x + offset.x, thickness * 2.6, pivot.z + offset.z);
    cone.rotation.y = -angle;
    cone.renderOrder = 31;
    group.add(cone);
  }

  private track(object: THREE.Object3D): void {
    this.group.add(object);
    this.disposable.push(object);
  }
}

export class HydrologyOverlay {
  readonly group = new THREE.Group();

  private hydrology: HydrologySceneV1 | null = null;
  private config: WorldConfig | null = null;
  private visible = true;
  private readonly disposable: THREE.Object3D[] = [];

  constructor() {
    this.group.renderOrder = 18;
  }

  setHydrology(hydrology: HydrologySceneV1 | null | undefined): void {
    this.hydrology = hydrology ?? null;
    this.rebuild();
  }

  setConfig(config: WorldConfig | null): void {
    this.config = config;
    this.rebuild();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.group.visible = visible;
  }

  dispose(): void {
    this.clear();
  }

  private rebuild(): void {
    this.clear();
    this.group.visible = this.visible;
    if (!this.hydrology || !this.config) return;
    for (const body of this.hydrology.waterBodies) {
      const y = r16ToElevation(body.waterLevelR16, this.config.worldHeight);
      for (const ring of body.rings) {
        this.addWaterBodyRing(simplifyLakeRing(ring, LAKE_RING_SIMPLIFY_TOLERANCE_CELLS * this.config.unitSize), y);
      }
    }
    for (const river of this.hydrology.rivers) {
      for (const segment of river.segments) {
        this.addRiver(segment.points, Math.max(1, river.widthHint));
      }
    }
  }

  private addWaterBodyRing(ring: HydrologyPointV1[], y: number): void {
    if (ring.length < 4) return;
    const shape = new THREE.Shape(ring.map((point) => new THREE.Vector2(point.x, point.z)));
    const geometry = new THREE.ShapeGeometry(shape);
    geometry.rotateX(Math.PI / 2);
    const fill = new THREE.MeshBasicMaterial({
      color: 0x35a8ff,
      transparent: true,
      opacity: 0.34,
      side: THREE.DoubleSide,
      depthTest: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1
    });
    const mesh = new THREE.Mesh(geometry, fill);
    mesh.position.y = y;
    mesh.renderOrder = 18;
    this.track(mesh);

    const linePoints = ring.map((point) => new THREE.Vector3(point.x, y, point.z));
    const lineGeometry = new THREE.BufferGeometry().setFromPoints(linePoints);
    const lineMaterial = new THREE.LineBasicMaterial({
      color: 0xaee8ff,
      transparent: true,
      opacity: 0.92,
      depthTest: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2
    });
    const line = new THREE.Line(lineGeometry, lineMaterial);
    line.renderOrder = 19;
    this.track(line);
  }

  private addRiver(points: HydrologyPointV1[], widthHint: number): void {
    if (points.length < 2 || !this.config) return;
    const radius = Math.min(10, Math.max(1.5, widthHint * 0.75));
    const positions = new Float32Array(points.length * 2 * 3);
    const indices: number[] = [];
    for (let index = 0; index < points.length; index += 1) {
      const point = points[index];
      const previous = points[Math.max(0, index - 1)];
      const next = points[Math.min(points.length - 1, index + 1)];
      let tangentX = next.x - previous.x;
      let tangentZ = next.z - previous.z;
      const tangentLength = Math.hypot(tangentX, tangentZ);
      if (tangentLength > 0) {
        tangentX /= tangentLength;
        tangentZ /= tangentLength;
      } else {
        tangentX = 1;
        tangentZ = 0;
      }
      const normalX = -tangentZ * radius;
      const normalZ = tangentX * radius;
      const y = r16ToElevation(point.heightR16 ?? 0, this.config.worldHeight);
      const offset = index * 6;
      positions.set([point.x + normalX, y, point.z + normalZ, point.x - normalX, y, point.z - normalZ], offset);
      if (index < points.length - 1) {
        const left = index * 2;
        const right = left + 1;
        const nextLeft = left + 2;
        const nextRight = left + 3;
        indices.push(left, right, nextLeft, right, nextRight, nextLeft);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    const material = new THREE.MeshBasicMaterial({
      color: 0x0aa7ff,
      transparent: true,
      opacity: 0.42,
      side: THREE.DoubleSide,
      depthTest: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1
    });
    const strip = new THREE.Mesh(geometry, material);
    strip.renderOrder = 19;
    this.track(strip);
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

  private track<T extends THREE.Object3D>(object: T): T {
    this.group.add(object);
    this.disposable.push(object);
    return object;
  }
}

function getTransformControls(anchors: AnchorV1[]): { pivot: SplinePoint2D; radius: number; ringWidth: number; arrowLength: number } | null {
  if (anchors.length === 0) return null;
  let x = 0;
  let z = 0;
  for (const anchor of anchors) {
    x += anchor.x;
    z += anchor.z;
  }
  const pivot = { x: x / anchors.length, z: z / anchors.length };
  const radius = 48;
  const ringWidth = 17;
  const arrowLength = 39;
  return {
    pivot,
    radius,
    ringWidth,
    arrowLength
  };
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
