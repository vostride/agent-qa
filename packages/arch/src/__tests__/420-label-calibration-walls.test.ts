import { globSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import ts from 'typescript'
import { calibrationBoundaryHits, calibrationClosure, calibrationFoldCalls, calibrationImports, calibrationPureHits,
  type CalibrationSource } from '../lint/label-calibration-walls.js'

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const read = (file: string) => readFileSync(`${repoRoot}/${file}`, 'utf8')
const sources: CalibrationSource[] = [...globSync('packages/*/src/**/*.{ts,tsx,json}', { cwd: repoRoot }),
  ...globSync('packages/*/package.json', { cwd: repoRoot })]
  .filter(file => !file.startsWith('packages/arch/') && !file.includes('__tests__')
    && !file.endsWith('/ownership-contract.ts') && !/\.test\.|\.d\.ts$/.test(file))
  .map(file => ({ file, text: read(file) }))
const byFile = new Map(sources.map(source => [source.file, source]))
const packages = new Map<string, string>()
for (const manifest of globSync('packages/*/package.json', { cwd: repoRoot })) {
  const pkg = JSON.parse(read(manifest))
  for (const [subpath, exported] of Object.entries(pkg.exports ?? {})) {
    const target = typeof exported === 'string' ? exported
      : (exported as { import?: string; default?: string }).import
        ?? (exported as { default?: string }).default
    if (typeof target !== 'string') continue
    packages.set(pkg.name + (subpath === '.' ? '' : subpath.slice(1)),
      manifest.replace('package.json', '') + target.replace(/^\.\//, '').replace(/^dist\//, 'src/').replace(/\.js$/, '.ts'))
  }
}
const knowledgePrefix = 'packages/knowledge-local/src/'
// Plans 10/11: these ten calls expose status/counters/validity only. Canary now
// receives priors (20), though its use still projects status. diffSince never folds.
const statusOnly: Record<string, number> = { 'gc.ts': 1, 'inspect.ts': 1, 'show-records.ts': 1,
  'lineage-fold.ts': 1, 'gates/gate-receipt-read.ts': 1, 'rollback.ts': 3,
  'review/propose-review.ts': 1, 'review/apply-review.ts': 1 }
const numerical: Record<string, number> = { 'bundle-read.ts': 1, 'bundle-scan.ts': 2,
  'curator/disposition.ts': 1, 'curator/knowledge-store.ts': 3,
  'gates/candidate-injection.ts': 1, 'gates/canary-posture-facts.ts': 1,
  'index-reader.ts': 1, 'index-rebuild.ts': 2, 'list-bundles.ts': 1,
  'promotion-gate-input.ts': 1, 'retrieve.ts': 1, 'serving/reader.ts': 3 }
// Pins for the full read/serve/store/index/host chain, including forwarding seams
// without a direct fold. The graph below walks beyond each pin; these are not exclusions.
const priorEntrypoints = [
  ...Object.keys(numerical).map(file => knowledgePrefix + file),
  'packages/knowledge-local/src/curator/commit.ts',
  'packages/knowledge-local/src/curator/drain.ts',
  'packages/knowledge-local/src/curator/maintenance.ts',
  'packages/knowledge-local/src/serving/authoring-reader.ts',
  'packages/knowledge-local/src/trust-prior-context.ts',
  'packages/agent-local/src/composition/compose-local-agent.ts',
  'packages/agent-local/src/composition/knowledge-reader.ts',
  'packages/agent-local/src/composition/knowledge-review-reader.ts',
  'packages/agent-local/src/composition/run-composition.ts',
  'packages/cli/src/composition/local-agent-host.ts',
  'packages/cli/src/composition/in-process-run-execution.ts',
  'packages/cli/src/curation/curation-tail.ts',
  'packages/cli/src/curation/post-run-tail.ts',
  'packages/cli/src/curation/trust-priors.ts',
  'packages/cli/src/daemon/host.ts',
  'packages/cli/src/commands/doctor-knowledge-checks.ts',
  'packages/cli/src/commands/knowledge-maintain.ts',
  'packages/cli/src/commands/run.ts',
]

describe('420 label calibration walls', () => {
  it.each(["import {} from 'node:fs'", "export {} from 'node:fs'",
    "import { type Stats } from 'node:fs'", "export { type Stats } from 'node:fs'"])(
    'retains emitted runtime edges for %s under verbatim module syntax', text => {
      const source = { file: 'packages/eval/src/labels/plant.ts', text }
      const emitted = ts.transpileModule(text, { compilerOptions: {
        module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext, verbatimModuleSyntax: true,
      } }).outputText
      expect(emitted).toContain("from 'node:fs'")
      expect(calibrationImports(source, true).map(hit => hit.specifier)).toEqual(['node:fs'])
      expect(calibrationPureHits([source]).map(hit => hit.specifier)).toEqual(['node:fs'])
    },
  )
  it.each(["import type { Stats } from 'node:fs'", "export type { Stats } from 'node:fs'"])(
    'excludes erased statement-level type edges for %s', text => {
      const source = { file: 'packages/eval/src/labels/plant.ts', text }
      const emitted = ts.transpileModule(text, { compilerOptions: {
        module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext, verbatimModuleSyntax: true,
      } }).outputText
      expect(emitted).not.toContain('node:fs')
      expect(calibrationImports(source, true)).toEqual([])
      expect(calibrationPureHits([source])).toEqual([])
    },
  )
  it('walks every real learner entry without reaching eval calibration or its main entry', () => {
    const entries = sources.filter(source => /^packages\/(?:knowledge-local|agent-local)\/src\//.test(source.file)).map(source => source.file)
    expect(entries.length).toBeGreaterThan(100)
    const closure = calibrationClosure(sources, entries, packages)
    expect(closure.missingEntries).toEqual([])
    expect(closure.unresolved).toEqual([])
    expect(closure.files.length).toBeGreaterThan(entries.length)
    expect(closure.files.filter(file => /^packages\/eval(?:-local)?\//.test(file))).toEqual([])
    expect(calibrationBoundaryHits(sources)).toEqual([])
  })

  it('keeps the pure calibration closure filesystem and provider free', () => {
    const closure = calibrationClosure(sources, ['packages/eval/src/labels/calibration.ts'], packages, true)
    expect(closure.missingEntries).toEqual([])
    expect(closure.unresolved).toEqual([])
    expect(closure.files).toContain('packages/eval/src/stats/wilson.ts')
    expect(closure.files).toContain('packages/schema/src/knowledge/trust-fold.ts')
    expect(calibrationPureHits(closure.files.map(file => byFile.get(file)!))).toEqual([])
  })

  it('pins filesystem writer and mapping ownership to eval plus explicit CLI composition', () => {
    expect(sources.filter(source => /\brunLabelCalibration\b/.test(source.text)).map(source => source.file).sort()).toEqual([
      'packages/cli/src/eval-session-composition.ts', 'packages/eval-local/src/calibration-composition.ts',
      'packages/eval-local/src/index.ts',
    ])
    expect(sources.filter(source => /labels\/calibration\.json/.test(source.text)).map(source => source.file)).toEqual([
      'packages/eval-local/src/calibration-source.ts',
    ])
    expect(sources.filter(source => /\bCHANNEL_TO_ORIGIN_CLASS\b/.test(source.text)).map(source => source.file).sort()).toEqual([
      'packages/eval/src/index.ts', 'packages/eval/src/labels/calibration.ts',
    ])
    const facade = calibrationImports(byFile.get('packages/cli/src/curation/trust-priors.ts')!)
    expect(facade.filter(hit => hit.specifier.includes('eval')).map(hit => hit.specifier)).toEqual(['../eval-session-composition.js'])
    const closure = calibrationClosure(sources, ['packages/cli/src/curation/trust-priors.ts'], packages)
    expect(closure.files).toContain('packages/eval-local/src/calibration-evidence-source.ts')
    expect(read('packages/eval-local/src/calibration-evidence-source.ts')).toContain('calibrationGoldSetDigest')
  })

  it('censuses all actual fold calls and every prior forwarding entrypoint', () => {
    const noPrior: Record<string, number> = {}, withPrior: Record<string, number> = {}
    for (const source of sources.filter(source => source.file.startsWith(knowledgePrefix))) {
      for (const call of calibrationFoldCalls(source)) {
        const file = source.file.slice(knowledgePrefix.length)
        const census = call.prior === undefined ? noPrior : withPrior
        census[file] = (census[file] ?? 0) + 1
        if (call.prior !== undefined) expect(call.prior).not.toMatch(/^(?:undefined|null|\{\})$/)
      }
    }
    expect(noPrior).toEqual(statusOnly)
    expect(withPrior).toEqual(numerical)
    expect(calibrationFoldCalls(byFile.get(knowledgePrefix + 'diff-since.ts')!)).toEqual([])
    for (const file of ['serving/get-authoring-brief.ts', 'serving/get-procedure.ts']) {
      expect(byFile.has(knowledgePrefix + file)).toBe(true)
      expect(calibrationFoldCalls(byFile.get(knowledgePrefix + file)!)).toEqual([])
    }
    for (const entry of priorEntrypoints) {
      expect(byFile.has(entry), entry).toBe(true)
      expect(byFile.get(entry)!.text, entry).toMatch(/priors|TrustPriors|TrustPrior/)
    }
    const closure = calibrationClosure(sources, priorEntrypoints, packages)
    expect(closure.missingEntries).toEqual([])
    expect(closure.unresolved).toEqual([])
    for (const entry of priorEntrypoints) expect(closure.files).toContain(entry)
  })

  it.each(['import { runLabelCalibration as innocuous } from', 'export { runLabelCalibration as innocuous } from',
    'export * from', 'import type { LabelSourceChannel as Neutral } from'])(
    'detects a synthetic forbidden edge through %s and a relative barrel', statement => {
      const entry = 'packages/knowledge-local/src/plant.ts', bridge = 'packages/knowledge-local/src/bridge.ts'
      const plants = [ { file: entry, text: "import { innocuous } from './bridge.js'" },
        { file: bridge, text: `${statement}\n'@vostride/agent-qa-eval-local'` },
        { file: 'packages/eval-local/src/index.ts', text: "export { runLabelCalibration } from './calibration-composition.js'" },
        { file: 'packages/eval-local/src/calibration-composition.ts', text: 'export function runLabelCalibration() {}' } ]
      const closure = calibrationClosure(plants, [entry], packages)
      expect(closure.unresolved).toEqual([])
      expect(closure.files).toContain('packages/eval-local/src/calibration-composition.ts')
      expect(calibrationBoundaryHits(plants)).toContain(`${bridge}: eval main/writer import`)
    },
  )

  it.each(['CHANNEL_TO_ORIGIN_CLASS', 'LabelSourceChannel', 'LABEL_TIERS', 'labels/calibration.json', 'readLabelCalibration'])(
    'rejects planted neutral-boundary leakage of %s', needle => {
      for (const root of ['knowledge-local', 'agent-local', 'schema']) {
        const source = { file: `packages/${root}/src/plant.ts`, text: `const leaked = '${needle}'` }
        expect(calibrationBoundaryHits([source])).toContain(`${source.file}: calibration vocabulary crossed neutral boundary`)
      }
    },
  )

  it('rejects unresolved imports and missing entrypoints instead of certifying an empty walk', () => {
    const planted = [{ file: 'packages/knowledge-local/src/plant.ts', text: "export * from './missing.js'" }]
    expect(calibrationClosure(planted, [planted[0]!.file], packages).unresolved).toHaveLength(1)
    expect(calibrationClosure(planted, ['missing.ts'], packages).missingEntries).toEqual(['missing.ts'])
  })

  it('sees aliased and namespace fold calls so changing their spelling cannot hide a lost prior', () => {
    const source = { file: 'plant.ts', text: "import { deriveBundleTrust as fold } from './bundle-read.js'\nimport * as schema from '@vostride/agent-qa-schema'\nfold(bundle)\nschema.foldBundleTrust(events, opts, priors)" }
    expect(calibrationFoldCalls(source)).toEqual([
      { name: 'deriveBundleTrust', arguments: 1, prior: undefined },
      { name: 'foldBundleTrust', arguments: 3, prior: 'priors' },
    ])
  })

  it.each(['node:fs', 'fs/promises', '@ai-sdk/openai', '@vostride/agent-qa-model'])(
    'follows a planted pure-core helper to its forbidden %s runtime import', specifier => {
      const plants = [{ file: 'packages/eval/src/labels/calibration.ts', text: "export * from './bridge.js'" },
        { file: 'packages/eval/src/labels/bridge.ts', text: `import { readFile as acquire } from '${specifier}'` }]
      const closure = calibrationClosure(plants, [plants[0]!.file], packages, true)
      expect(closure.files).toContain(plants[1]!.file)
      expect(calibrationImports(plants[1]!, true).map(hit => hit.specifier)).toEqual([specifier])
      expect(calibrationPureHits(plants).map(hit => hit.specifier)).toEqual([specifier])
    },
  )
})
