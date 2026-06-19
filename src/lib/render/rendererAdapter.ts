import * as THREE from 'three';

export interface RendererAdapter {
  renderer: THREE.WebGLRenderer;
  backend: 'webgpu' | 'webgl';
}

export async function createRenderer(canvas: HTMLCanvasElement): Promise<RendererAdapter> {
  if ('gpu' in navigator) {
    try {
      const webgpu = await import('three/webgpu');
      const WebGPURenderer = webgpu.WebGPURenderer as typeof THREE.WebGLRenderer | undefined;
      if (WebGPURenderer) {
        const renderer = new WebGPURenderer({ canvas, antialias: true }) as THREE.WebGLRenderer;
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        await (renderer as unknown as { init?: () => Promise<void> }).init?.();
        return { renderer, backend: 'webgpu' };
      }
    } catch (error) {
      console.warn('WebGPU renderer unavailable; falling back to WebGL.', error);
    }
  }

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  return { renderer, backend: 'webgl' };
}
