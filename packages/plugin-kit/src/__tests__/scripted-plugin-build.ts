import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'tsdown'

const kitDir = fileURLToPath(new URL('../..', import.meta.url))

// Spawned tests run dist/scripted-plugin.js, so it is rebuilt from the source under test first.
// The build lands beside dist, keeping its source map paths, and each file is renamed into dist
// so a test in another package never reads a half-written file.
export default async function setup(): Promise<void> {
  const staging = join(kitDir, `.scripted-plugin-build-${process.pid}`)
  try {
    await build({
      config: false,
      cwd: kitDir,
      entry: { 'scripted-plugin': 'src/testing/scripted-plugin-main.ts' },
      outDir: staging,
      format: ['esm'],
      platform: 'node',
      target: 'node24',
      dts: false,
      clean: false,
      sourcemap: true,
      fixedExtension: false,
      shims: true,
      logLevel: 'warn',
    })
    const dist = join(kitDir, 'dist')
    mkdirSync(dist, { recursive: true })
    for (const file of readdirSync(staging)) renameSync(join(staging, file), join(dist, file))
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}
