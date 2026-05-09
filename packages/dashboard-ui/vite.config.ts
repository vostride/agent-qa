import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export default defineConfig({
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
    proxy: {
      '/api/live-editor/ws': {
        target: 'http://localhost:3470',
        ws: true,
      },
      '/api': 'http://localhost:3470',
      '/screenshots': 'http://localhost:3470',
      '/videos': 'http://localhost:3470',
    },
  },
})
