import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

// `vitest/config` re-exports vite's `defineConfig` and additionally types the `test` key. This
// package has no separate vitest.config.ts, so vitest reads this file.
export default defineConfig({
  test: {
    setupFiles: ['./src/test/browser-observers.ts'],
    // Slow CI runners push multi-step jsdom tests past the 5s default; other packages use 30s.
    testTimeout: 30_000,
    typecheck: {
      enabled: true,
      tsconfig: './tsconfig.json',
      include: ['src/**/*.test-d.ts'],
    },
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
    extensions: ['.mjs', '.js', '.mts', '.tsx', '.ts', '.jsx', '.json'],
  },
  optimizeDeps: {
    include: ['monaco-editor'],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    // Object form with no changeOrigin: a string entry makes Vite rewrite Host to the target, and
    // the same-site guard would then refuse the dashboard's own dev page.
    proxy: {
      '/api/live-editor/ws': {
        target: 'http://localhost:3470',
        ws: true,
      },
      '/api': { target: 'http://localhost:3470' },
    },
  },
})
