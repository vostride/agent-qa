import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/server/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node24',
  splitting: false,
})
