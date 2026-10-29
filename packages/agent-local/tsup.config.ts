import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node24',
  splitting: false,
  // esbuild rewrites `node:sqlite` to a bare `sqlite`, which does not resolve.
  removeNodeProtocol: false,
})
