import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    svelte({
      compilerOptions: {
        compatibility: {
          componentApi: 4
        }
      }
    })
  ],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts']
  }
});
