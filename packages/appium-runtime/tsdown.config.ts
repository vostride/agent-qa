import { defineConfig, type Rolldown, type UserConfig } from 'tsdown'

// Declarations ship without maps, but rolldown-plugin-dts leaves the ESM build's
// declarations pointing at the maps it dropped.
const withoutDeclarationMapUrls: Rolldown.Plugin = {
  name: 'without-declaration-map-urls',
  generateBundle(_options, bundle) {
    for (const file of Object.values(bundle)) {
      if (file.type !== 'chunk' || !/\.d\.[cm]?ts$/.test(file.fileName)) continue
      if (`${file.fileName}.map` in bundle) continue
      file.code = file.code.replace(/\n\/\/# sourceMappingURL=\S+\s*$/, '')
    }
  },
}

// One build per entry, so each output is self-contained with no shared chunks. The CJS
// declaration build skips user plugins, so it is built with no source maps at all.
const shared: UserConfig = {
  format: ['esm', 'cjs'],
  dts: { sourcemap: false },
  clean: true,
  sourcemap: true,
  target: 'node24',
  fixedExtension: false,
  plugins: [withoutDeclarationMapUrls],
  outputOptions: (options, _format, { cjsDts }) => ({
    ...options,
    codeSplitting: false,
    sourcemap: !cjsDts,
  }),
}

export default defineConfig([
  {
    ...shared,
    entry: { index: 'src/index.ts' },
    publint: true,
    attw: { profile: 'node16', level: 'error' },
  },
])
