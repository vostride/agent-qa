import { defineConfig } from 'tsdown'

// The host spawns dist/main.js and the emitter imports dist/plugin.js; neither is a library entry.
export default defineConfig({
  entry: { main: 'src/main.ts', plugin: 'src/plugin.ts' },
  format: ['esm'],
  dts: false,
  clean: true,
  sourcemap: true,
  target: 'node24',
  fixedExtension: false,
})
