import * as THREE from 'three';
import type { TileManager } from '../heightmap/tileManager';
import { metersToWorldUnits } from '../heightmap/worldConfig';

export type ViewMode = 'free' | 'ortho' | 'character';

const HALF_PI = Math.PI / 2;
const CHARACTER_EYE_HEIGHT_METERS = 2;
const CHARACTER_WALK_SPEED_METERS = 3.2;
const CHARACTER_SPRINT_SPEED_METERS = 7.2;
const CHARACTER_JUMP_SPEED_METERS = 5.4;
const CHARACTER_GRAVITY_METERS = 18;

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
  private characterGroundY = 0;
  private characterGrounded = false;
  private characterVelocityY = 0;
  private characterGroundPending = false;

  constructor(
    private readonly dom: HTMLElement,
    private readonly manager: TileManager
  ) {
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
    } else if (mode === 'character') {
      this.pitch = this.clampPitch(this.pitch);
      this.updatePerspectiveRotation();
      void this.snapCharacterToGround();
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
    const shiftMultiplier = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 4 : 1;
    const speed = (this.mode === 'ortho' ? 1600 : 900) * shiftMultiplier;
    const amount = speed * deltaSeconds;

    if (this.mode === 'ortho') {
      if (this.keys.has('KeyW')) this.orthoTarget.z -= amount;
      if (this.keys.has('KeyS')) this.orthoTarget.z += amount;
      if (this.keys.has('KeyA')) this.orthoTarget.x -= amount;
      if (this.keys.has('KeyD')) this.orthoTarget.x += amount;
      this.updateOrthoPosition();
      return;
    }

    if (this.mode === 'character') {
      this.updateCharacter(deltaSeconds);
      return;
    }

    const forward = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)).normalize();
    const right = new THREE.Vector3(-forward.z, 0, forward.x).normalize();
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
    if (event.code === 'Space' && this.mode === 'character') {
      event.preventDefault();
    }
    this.keys.add(event.code);
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.keys.delete(event.code);
  };

  private readonly onContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    event.preventDefault();
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
      const scale = 2 / Math.max(0.2, this.ortho.zoom);
      this.orthoTarget.x -= dx * scale;
      this.orthoTarget.z -= dy * scale;
      this.updateOrthoPosition();
      return;
    }

    if (this.mode === 'free' || this.mode === 'character') {
      this.yaw -= dx * 0.004;
      this.pitch = this.clampPitch(this.pitch - dy * 0.004);
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

  private updateCharacter(deltaSeconds: number): void {
    const config = this.manager.config;
    if (!config) return;

    const sprinting = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    const speed = metersToWorldUnits(sprinting ? CHARACTER_SPRINT_SPEED_METERS : CHARACTER_WALK_SPEED_METERS, config);
    const forward = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)).normalize();
    const right = new THREE.Vector3(-forward.z, 0, forward.x).normalize();
    const move = new THREE.Vector3();
    if (this.keys.has('KeyW')) move.add(forward);
    if (this.keys.has('KeyS')) move.addScaledVector(forward, -1);
    if (this.keys.has('KeyA')) move.addScaledVector(right, -1);
    if (this.keys.has('KeyD')) move.add(right);
    if (move.lengthSq() > 0) {
      move.normalize();
      this.perspective.position.addScaledVector(move, speed * deltaSeconds);
      this.clampCharacterToWorld();
    }

    void this.refreshCharacterGround();
    if (this.characterGrounded && this.keys.has('Space')) {
      this.characterVelocityY = metersToWorldUnits(CHARACTER_JUMP_SPEED_METERS, config);
      this.characterGrounded = false;
    }

    const eyeHeight = metersToWorldUnits(CHARACTER_EYE_HEIGHT_METERS, config);
    const groundedEyeY = this.characterGroundY + eyeHeight;
    this.characterVelocityY -= metersToWorldUnits(CHARACTER_GRAVITY_METERS, config) * deltaSeconds;
    this.perspective.position.y += this.characterVelocityY * deltaSeconds;
    if (this.perspective.position.y <= groundedEyeY) {
      this.perspective.position.y = groundedEyeY;
      this.characterVelocityY = 0;
      this.characterGrounded = true;
    }
  }

  private async snapCharacterToGround(): Promise<void> {
    const config = this.manager.config;
    if (!config) return;
    const height = await this.manager.sampleHeightAtWorld(this.perspective.position.x, this.perspective.position.z);
    if (height === null) return;
    this.characterGroundY = height;
    this.perspective.position.y = height + metersToWorldUnits(CHARACTER_EYE_HEIGHT_METERS, config);
    this.characterVelocityY = 0;
    this.characterGrounded = true;
  }

  private async refreshCharacterGround(): Promise<void> {
    if (this.characterGroundPending || !this.manager.config) return;
    this.characterGroundPending = true;
    try {
      const height = await this.manager.sampleHeightAtWorld(this.perspective.position.x, this.perspective.position.z);
      if (height === null) return;
      this.characterGroundY = height;
      const eyeHeight = metersToWorldUnits(CHARACTER_EYE_HEIGHT_METERS, this.manager.config);
      const groundedEyeY = height + eyeHeight;
      if (this.characterGrounded || this.perspective.position.y < groundedEyeY) {
        this.perspective.position.y = groundedEyeY;
        this.characterVelocityY = 0;
        this.characterGrounded = true;
      }
    } finally {
      this.characterGroundPending = false;
    }
  }

  private clampCharacterToWorld(): void {
    const config = this.manager.config;
    if (!config) return;
    const halfWorld = (config.tileSize * config.tilesPerSide * config.unitSize) / 2;
    this.perspective.position.x = THREE.MathUtils.clamp(this.perspective.position.x, -halfWorld, halfWorld);
    this.perspective.position.z = THREE.MathUtils.clamp(this.perspective.position.z, -halfWorld, halfWorld);
  }

  private clampPitch(value: number): number {
    return THREE.MathUtils.clamp(value, -HALF_PI + 0.001, HALF_PI - 0.001);
  }
}
