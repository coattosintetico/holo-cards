import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  optimizeDeps: { exclude: ['@imgly/background-removal', 'onnxruntime-web'] },
});
