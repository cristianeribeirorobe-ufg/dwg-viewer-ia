import { defineConfig } from 'vite';

export default defineConfig({
  // O módulo emscripten usa import.meta.url; evitar o pré-bundle do esbuild.
  optimizeDeps: { exclude: ['@mlightcad/libredwg-web'] },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
});
