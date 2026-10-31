import { defineConfig, type UserConfig } from 'tsdown'

// One build per entry, so each output is self-contained with no shared chunks.
const shared: UserConfig = {
  format: ['esm', 'cjs'],
  dts: { sourcemap: false },
  clean: true,
  sourcemap: true,
  target: 'node24',
  fixedExtension: false,
  outputOptions: { codeSplitting: false },
}

export default defineConfig([
  {
    ...shared,
    entry: { index: 'src/index.ts' },
    publint: true,
    attw: { profile: 'node16', level: 'error' },
  },
])
