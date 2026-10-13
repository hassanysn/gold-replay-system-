import { defineConfig } from 'vitest/config';

// The built app goes to app/ and is served together with data/ by serve.py (see start.bat).
// In dev (npm run dev) Vite serves the repo root, so /data/... resolves to ./data as well.
export default defineConfig({
  base: './',
  publicDir: false,
  build: { outDir: 'app', emptyOutDir: true, target: 'es2022' },
  worker: { format: 'es' },
  test: { include: ['tests/**/*.test.ts'] },
});
