import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node24',
  splitting: false,
  // esbuild rewrites `node:sqlite` to a bare `sqlite`, which is
  // not resolvable — `node:sqlite` is one of the builtins with no bare alias. It went unnoticed
  // while nothing on the barrel reached the store; `composeLocalAgent()` does, so loading this
  // package from another one failed outright. Same setting, same reason, as knowledge-local and
  // dashboard-server.
  removeNodeProtocol: false,
})
