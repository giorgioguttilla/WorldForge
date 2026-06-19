import * as THREE from 'three';

export type ViewMode = 'free' | 'ortho' | 'character';

export class CameraController {
  readonly perspective = new THREE.PerspectiveCamera(55, 1, 0.5, 1000000);
  readonly ortho = new THREE.OrthographicCamera(-1000, 1000, 1000, -1000, -100000, 1000000);
  mode: ViewMode = 'free';

  private readonly keys = new Set<string>();
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private yaw = -Math.PI / 4;
  private pitch = -0.5;
  private orthoTarget = new THREE.Vector3(0, 0, 0);

  constructor(private readonly dom: HTMLElement) {
    this.perspective.position.set(1800, 900, 1800);
    this.updatePerspectiveRotation();
    this.ortho.position.set(0, 5000, 0);
    this.ortho.lookAt(0, 0, 0);
    this.bind();
  }

  get activeCamera(): THREE.Camera {
    return this.mode === 'ortho' ? this.ortho : this.perspective;
  }

  setMode(mode: ViewMode): void {
    this.mode = mode;
    if (mode === 'ortho') {
      this.orthoTarget.set(this.perspective.position.x, 0, this.perspective.position.z);
      this.updateOrthoPosition();
    }
  }

  resize(width: number, height: number): void {
    this.perspective.aspect = width / Math.max(1, height);
    this.perspective.updateProjectionMatrix();

    const halfH = height;
    const halfW = halfH * (width / Math.max(1, height));
    this.ortho.left = -halfW;
    this.ortho.right = halfW;
    this.ortho.top = halfH;
    this.ortho.bottom = -halfH;
    this.ortho.updateProjectionMatrix();
  }

  update(deltaSeconds: number): void {
    const speed = this.mode === 'ortho' ? 1600 : 900;
    const amount = speed * deltaSeconds;

    if (this.mode === 'ortho') {
      if (this.keys.has('KeyW')) this.orthoTarget.z -= amount;
      if (this.keys.has('KeyS')) this.orthoTarget.z += amount;
      if (this.keys.has('KeyA')) this.orthoTarget.x -= amount;
      if (this.keys.has('KeyD')) this.orthoTarget.x += amount;
      this.updateOrthoPosition();
      return;
    }

    if (this.mode === 'character') return;

    const forward = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw)).normalize();
    const right = new THREE.Vector3(forward.z, 0, -forward.x).normalize();
    if (this.keys.has('KeyW')) this.perspective.position.addScaledVector(forward, amount);
    if (this.keys.has('KeyS')) this.perspective.position.addScaledVector(forward, -amount);
    if (this.keys.has('KeyA')) this.perspective.position.addScaledVector(right, -amount);
    if (this.keys.has('KeyD')) this.perspective.position.addScaledVector(right, amount);
    if (this.keys.has('KeyQ')) this.perspective.position.y -= amount;
    if (this.keys.has('KeyE')) this.perspective.position.y += amount;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    this.dom.removeEventListener('contextmenu', this.onContextMenu);
    this.dom.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    this.dom.removeEventListener('wheel', this.onWheel);
  }

  private bind(): void {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    this.dom.addEventListener('contextmenu', this.onContextMenu);
    this.dom.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    this.dom.addEventListener('wheel', this.onWheel, { passive: false });
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    this.keys.add(event.code);
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.keys.delete(event.code);
  };

  private readonly onContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 2) return;
    this.dragging = true;
    this.lastX = event.clientX;
    this.lastY = event.clientY;
    this.dom.setPointerCapture(event.pointerId);
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (!this.dragging) return;
    const dx = event.clientX - this.lastX;
    const dy = event.clientY - this.lastY;
    this.lastX = event.clientX;
    this.lastY = event.clientY;

    if (this.mode === 'ortho') {
      const scale = 1 / Math.max(0.2, this.ortho.zoom);
      this.orthoTarget.x -= dx * scale;
      this.orthoTarget.z -= dy * scale;
      this.updateOrthoPosition();
      return;
    }

    if (this.mode === 'free') {
      this.yaw -= dx * 0.004;
      this.pitch = Math.max(-1.48, Math.min(1.2, this.pitch - dy * 0.004));
      this.updatePerspectiveRotation();
    }
  };

  private readonly onPointerUp = (): void => {
    this.dragging = false;
  };

  private readonly onWheel = (event: WheelEvent): void => {
    if (this.mode !== 'ortho') return;
    event.preventDefault();
    this.ortho.zoom = Math.max(0.05, Math.min(8, this.ortho.zoom * (event.deltaY > 0 ? 0.9 : 1.1)));
    this.ortho.updateProjectionMatrix();
  };

  private updatePerspectiveRotation(): void {
    this.perspective.rotation.order = 'YXZ';
    this.perspective.rotation.y = this.yaw;
    this.perspective.rotation.x = this.pitch;
  }

  private updateOrthoPosition(): void {
    this.ortho.position.set(this.orthoTarget.x, 5000, this.orthoTarget.z);
    this.ortho.lookAt(this.orthoTarget);
  }
}
