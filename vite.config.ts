import { defineConfig } from 'vite';

const isolation = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };

export default defineConfig({
  base: './',
  worker: { format: 'es' },
  // Cross-origin isolation (multi-threaded WASM) in dev/preview; production gets it from public/coi-sw.js.
  server: { headers: isolation },
  preview: { headers: isolation },
  optimizeDeps: { exclude: ['@imgly/background-removal', 'onnxruntime-web'] },
});
