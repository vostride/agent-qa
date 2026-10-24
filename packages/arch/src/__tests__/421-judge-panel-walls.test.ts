import { globSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { judgePanelWalls } from '../lint/judge-panel-walls.js'
import { calibrationBoundaryHits, calibrationClosure } from '../lint/label-calibration-walls.js'
import { calibrationImports } from '../lint/label-calibration-walls.js'
import { ARCH_MANIFEST } from '../manifest.js'
import { findSetMismatchOffenders } from '../lint/reconcile-deps.js'
import { findSurfaceFirewallOffenders } from '../lint/surface-firewall.js'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const read = (file: string) => readFileSync(`${root}/${file}`, 'utf8')
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
// Phase 421 introduced no runtime dependency or SDK change. These independently pinned
// sets also prevent editing both package.json and ownership metadata to bless a new edge.
// Re-blessed once since Phase 421, for the cli set only. Phase 424 plan 35, commit
// 51a16ebc0, raised playwright-core from 1.59.1 to 1.61.0 in packages/cli, authorized by
// Phase 424 plan 11's disposition: that release's public first-frame metadata is what the
// local-web recording witnesses read. The cli digest below was recomputed from that tree
// by this wall's own expression. No other pin moved and no ownership edge was widened.
// Re-blessed 2026-10-15 for knowledge-local only (441-41, D-15): both of its pins moved because
// its @vostride/agent-qa-safety-local edge was REMOVED with the last JsonlAuditSink import. Both
// digests were recomputed by this wall's own expression; no edge was added.
// Re-blessed 2026-10-15 for cli only (441-43, D-15): both of its pins moved because its
// @vostride/agent-qa-safety edge was REMOVED with curation-tail.ts's audit sink type, its last
// shipped import. Its tests still import the package, so it moved to devDependencies. Both digests
// were recomputed by this wall's own expression; no edge was added.
// Re-blessed 2026-10-15 for eval-local only (441-32, D-15): both of its pins moved because its
// @vostride/agent-qa-safety-local edge was REMOVED with the replay and judge calibration audit
// scopes, its last imports. Both digests were recomputed by this wall's own expression; no edge
// was added.
// Re-blessed 2026-10-21 for cli only (446-20, D-35/D-36): @modelcontextprotocol/server 2.0.0 -> 2.3.1.
// Re-blessed 2026-10-24 for cli, eval, eval-local and knowledge-local (GHSA-mrhx-c7xc-m3w5): zod
// 4.4.2 -> 4.6.7 is the only dependency that moved. No ownership edge changed.
const dependencyPins = {
  eval: '417bcbb571062963128aa46794162754246daf6a809385e08cebd7e3f3dda145',
  'eval-local': 'cb22f0373c7e8d1728d580e48a1943cf80c2dddd9c77f73e44d876f5eaf68096',
  'knowledge-local': '1d948c676485e6010852336416ca9fc7b1e7e8a6e03f0ef23cf44daf737a9f7d',
  'agent-local': 'b2e720e8c49b10e5882523a1cffdfa8e502619dd3e1e799e1078eba3dc6d01d0',
  cli: '2bbccc81ac9a3b3bf2937d3c354c5b7ea5df63363d7f2b91c2e59e5b4277fa04',
}
const internalPins: Record<string, string> = {
  eval: 'f09db8107041e27d15929be67224e779d7ecaca3b45594f7c63cee45c9c200ed',
  'eval-local': '7c4b292bddc81bd586e59a67436a51996f0fb146ca48f5628843fa3e7f94bdfc',
  'knowledge-local': '5410ce22c0e1e698cc2040f8652231ea72b48313430d1d289e9c1a38442fb955',
  'agent-local': 'ffe54e4e45a22c4544b49e376470cea3421d2b9e03f0bd903755b0af711db469',
  cli: '1817c1a2602f85746c3c86e448f2633444dca109f8bb97397947941af699923a',
}
const local = 'packages/eval-local/src/'
const sources = [...globSync('packages/*/src/**/*.{ts,tsx}', { cwd: root })]
  .filter(file => !file.startsWith('packages/arch/') && !file.includes('__tests__') && !/\.test\.|\.d\.ts$/.test(file))
  .map(file => ({ file, text: read(file) }))
const check = (text: string, file = local + 'replay-composition.ts') => judgePanelWalls([{ file, text }]).map(hit => hit.rule)
const replay = (value: string, extra = '') => `import { assessPanelEligibility as assess } from '@vostride/agent-qa-eval'
  function runCassetteReplay(input: RunCassetteReplayInput) { ${extra}
    assess({ replayedModelId: ${value}, recordedModelId: input.cassette.receipt.model.declared?.modelId ?? input.cassette.receipt.model.resolvedModelId,
      memberModelIds: input.judge.members.map(m => m.profile.model) }) }`

describe('421 judge panel walls', () => {
  it.each(Object.entries(dependencyPins))('pins runtime versions and exact ownership edges for %s', (pkg, pin) => {
    const dependencies = JSON.parse(read(`packages/${pkg}/package.json`)).dependencies
    expect(digest(JSON.stringify(Object.entries(dependencies).sort()))).toBe(pin)
    const contract = ARCH_MANIFEST.packages.find(row => row.packageDir === `packages/${pkg}`)!
    expect(digest(JSON.stringify([...contract.internalDependencies].sort()))).toBe(internalPins[pkg])
    // CLI's package dependencies predate and exceed its direct-import ownership set;
    // pin both independently instead of broadening the direct-import contract.
    const declared = [...contract.internalDependencies, ...contract.externalDependencies]
    expect(findSetMismatchOffenders('judge-dependency-edge', [...declared, 'new-sdk'], declared))
      .toEqual(['judge-dependency-edge: unexpected new-sdk'])
  })
  // Re-blessed once, 2026-09-30 (Phase 432 plan 07, D-05/D-07): the ledger gained exactly one
  // pair, packages/cli/src/composition/local-agent-host.ts -> @vostride/agent-qa-dashboard, for
  // the direct config writer the plan binds through the CLI's existing dashboard dependency. No
  // judge-panel or eval-local edge was added; the digest was recomputed from that ledger.
  it('retains the exact existing firewall ledger and rejects new direct/aliased/dynamic CLI imports', () => {
    // Re-blessed again, 2026-10-01 (Phase 432 plan 14, D-03): the ledger SHRANK by one entry —
    // packages/cli/src/run-session-composition.ts -> @vostride/agent-qa-safety-local, whose only
    // import (the readline confirm default) was deleted with the presentation confirm contract.
    // Nothing was added; the digest was recomputed from that ledger.
    // Re-blessed 2026-10-14 (Phase 441 plan 02, D-01/E3): two pairs for the declared-secrets loader,
    // packages/cli/src/composition/declared-secrets.ts -> core and -> runner. No judge-panel or
    // eval-local edge was added; the digest was recomputed from that ledger.
    // Re-blessed 2026-10-14 (Phase 441 plan 14, D-07): the ledger SHRANK by one entry —
    // packages/cli/src/reporters/console-reporter.ts -> @vostride/agent-qa-safety, whose only import
    // (the unmask) 441-13 deleted. Nothing was added; the digest was recomputed from that ledger.
    // Re-blessed 2026-10-15 (Phase 441 plan 42, D-15): the ledger SHRANK by one entry —
    // packages/cli/src/wm-flush.ts -> @vostride/agent-qa-safety, whose only import (the flush's
    // committed-egress scan) 441-42 deleted. Nothing was added; the digest was recomputed from that ledger.
    // Re-blessed 2026-10-15 (Phase 441 plan 24, D-26): the ledger SHRANK by one entry —
    // packages/cli/src/curation/emit-candidates.ts -> @vostride/agent-qa-safety, whose only import
    // (the emit-time injection scan) 441-24 deleted. Nothing was added; the digest was recomputed.
    // Re-blessed 2026-10-15 (Phase 441 plan 30, D-12/D-15): the ledger SHRANK by one entry —
    // packages/cli/src/run-session-composition.ts -> @vostride/agent-qa-safety, whose only import
    // (the per-run hook registrar's types) 441-30 deleted. Nothing was added; the digest was recomputed.
    // Re-blessed again 2026-10-15 (Phase 441 plan 30, D-12/D-15): the ledger SHRANK by one more entry —
    // packages/cli/src/commands/run.ts -> @vostride/agent-qa-safety, whose only import (the hook
    // runner type of the producers' late-bound slots) 441-30 deleted. Nothing was added; the digest
    // was recomputed.
    // Re-blessed 2026-10-15 (Phase 441 plan 43, D-15): the ledger SHRANK by one entry —
    // packages/cli/src/curation/curation-tail.ts -> @vostride/agent-qa-safety, whose only import
    // (the audit sink type) 441-43 deleted. Nothing was added; the digest was recomputed.
    expect(digest(read('packages/arch/src/lint/surface-firewall-ledger.ts'))).toBe('a59f9dffb057cf69ab9dd64363f10e3bf4c1172732bab5f301426cfc010aa4a9')
    for (const text of ["import { loadJudgeCalibrationEvidence as data } from '@vostride/agent-qa-eval-local'",
      "const data = await import('@vostride/agent-qa-eval-local')"]) {
      const hits = calibrationImports({ file: 'packages/cli/src/judge-new.ts', text })
      expect(findSurfaceFirewallOffenders([{ packageDir: 'packages/cli', hits }], [])).toEqual([
        'packages/cli | packages/cli/src/judge-new.ts:1 | @vostride/agent-qa-eval-local | surface-firewall un-ledgered internal import',
      ])
    }
  })
  it('rejects caller-controlled family declarations', () => {
    expect(check('const key = "plannerFamily"; const shape = { [key]: z.string(), judgeFamily: z.string() }',
      'packages/core/src/schema/config-schema.ts')).toContain('caller-family')
  })
  it('keeps config and registry declarations free of model/provider and filesystem bindings', () => {
    for (const specifier of ['@vostride/agent-qa-model', '@ai-sdk/openai', 'node:fs']) {
      expect(check(`const host = await import('${specifier}')`, 'packages/core/src/schema/registry-schema.ts')).toContain('core-judge-host')
    }
  })
  it.each(['"gpt-forged"', 'input.judge.members[0].profile.model', 'profile.model', 'replayedModelId'])(
    'rejects wrong replay provenance %s despite matching identifier names', value => {
      expect(check(replay(value, 'const profile = { model: "gpt-forged" }; const replayedModelId = "gpt-forged"'))).toContain('replay-provenance')
    })
  it('accepts aliases of actual replay profile and rejects lexical shadowing', () => {
    expect(check(replay('id', 'const { profile: actual } = input; const id = actual.model'))).toEqual([])
    expect(check(replay('id', 'const actual = input.profile; function inner(actual: Fake) { const id = actual.model; assess({ replayedModelId: id }); } const id = actual.model'))).toContain('replay-provenance')
  })
  it('refuses reassigned model aliases and mutation of the actual profile identity', () => {
    expect(check(replay('id', 'let id = input.profile.model; id = "forged"'))).toContain('replay-provenance')
    expect(check(replay('input.profile.model', 'input.profile.model = "forged"'))).toContain('identity-mutation')
  })
  it.each([
    "import { assessPanelEligibility as hidden } from '@vostride/agent-qa-eval'; const call = hidden;",
    "import * as evalCore from '@vostride/agent-qa-eval'; const call = evalCore.assessPanelEligibility;",
    "const { assessPanelEligibility: call } = await import('@vostride/agent-qa-eval');",
    "const evalCore = await import('@vostride/agent-qa-eval'); const call = evalCore['assessPanelEligibility'];",
  ])('detects direct, aliased and dynamic eligibility calls: %s', declaration => {
    expect(check(`${declaration} function runCassetteReplay(input: RunCassetteReplayInput) { call({ replayedModelId: 'forged' }) }`)).toContain('replay-provenance')
  })
  it('rejects forged recorded identity and omission on the real replay path', () => {
    const source = sources.find(row => row.file === local + 'replay-composition.ts')!
    expect(check(source.text.replace('recordedReceiptModelId(input.cassette)', "'gpt-forged'"))).toContain('recorded-provenance')
    expect(check(source.text.replace('...(recordedModelId !== undefined ? { recordedModelId } : {}),', ''))).toContain('recorded-provenance')
    expect(check(source.text.replace('cassette.receipt.model.declared?.modelId ?? cassette.receipt.model.resolvedModelId', "'gpt-forged'"))).toContain('recorded-provenance')
  })
  it('rejects forged member IDs and removal of production eligibility', () => {
    for (const name of ['replay-composition.ts', 'replay-gate-composition.ts', 'judge-calibration-composition.ts']) {
      const source = sources.find(row => row.file === local + name)!
      expect(check(source.text.replace(/assessPanelEligibility\(/g, 'unreviewedEligibility('), source.file)).toContain('eligibility-site')
    }
    expect(check(replay('input.profile.model').replace('input.judge.members.map(m => m.profile.model)', '["claude-forged", "gemini-forged"]'))).toContain('member-provenance')
  })
  it('accepts Gate identity aliases but rejects a same-named forged identity', () => {
    const source = sources.find(row => row.file === local + 'replay-gate-composition.ts')!
    expect(check(source.text.replace('const { injection, identity } = input', 'const { injection } = input; const identity = { plannerModelId: "forged" }'), source.file)).toContain('replay-provenance')
    expect(check(source.text.replace('const common = { replayedModelId: identity.plannerModelId,', 'const actual = identity; const modelId = actual.plannerModelId; const common = { replayedModelId: modelId,'), source.file)).toEqual([])
  })
  it.each([
    "import { createModel as hidden } from '@vostride/agent-qa-model'; hidden(profile, auth)",
    "const { createModel: hidden } = await import('@vostride/agent-qa-model'); hidden(profile, auth)",
    "import * as model from '@vostride/agent-qa-model'; const hidden = model.createModel; hidden(profile, auth)",
  ])('rejects a second judge factory %s', text => {
    expect(check(text, local + 'judge-second.ts')).toContain('judge-factory')
  })
  it('pins N existing bindings and the single factory in bindJudgePort', () => {
    const source = sources.find(row => row.file === local + 'judge-binding.ts')!
    expect(check(source.text.replace('inputs.map(bindJudgePort)', 'inputs.map(input => createModel(input.profile, input.auth))'), source.file)).toContain('panel-binding')
    expect(check(source.text + '\nconst second = createModel(profile, auth)', source.file)).toContain('judge-factory')
  })
  it.each(["export { loadJudgeCalibrationEvidence as publicData } from './judge-calibration-evidence-source.js'",
    "export * from './judge-calibration-evidence-source.js'",
    "const data = await import('./judge-calibration-evidence-source.js'); export { data }"])(
    'rejects private evidence through reader %s', text => {
      expect(check(text, local + 'reader.ts')).toContain('private-reader')
    })
  it.each(["import { publishJudgeCalibration as write } from '@vostride/agent-qa-eval-local'",
    "const writer = await import('@vostride/agent-qa-eval-local')"])(
    'rejects learner writer %s', text => {
      expect(check(text, 'packages/knowledge-local/src/plant.ts')).toContain('learner-eval-writer')
    })
  it.each(['eval', 'eval-local'])('rejects eval/knowledge edges in %s', pkg => {
    expect(check("const k = await import('@vostride/agent-qa-knowledge-local')", `packages/${pkg}/src/plant.ts`)).toContain('eval-knowledge-edge')
  })
  it.each(['Promise.all', 'Promise.allSettled', 'Promise.race'])('rejects member concurrency through %s', method => {
    expect(check(`import { judgePairwise as run } from './adjudicate'; const pending = members.map(m => run(m, evidence)); await ${method}(pending)`,
      'packages/eval/src/judge/plant.ts')).toContain('judge-concurrency')
  })
  it('rejects async member scheduling even without Promise.all but preserves legal unrelated concurrency', () => {
    expect(check('members.forEach(async member => { await judgePairwise(member, evidence) })', 'packages/eval/src/judge/plant.ts')).toContain('judge-concurrency')
    expect(check('await Promise.all(files.map(file => readFile(file)))', local + 'judge-calibration-composition.ts')).toEqual([])
    expect(check('function compare(panel: JudgePanelPort) { return Promise.all(panel.members.map(member => member.call(request))) }',
      'packages/eval/src/judge/adjudicate.ts')).toContain('judge-concurrency')
  })
  it('accepts completed real source including captured-provider and operator seams', () => {
    expect(sources.length).toBeGreaterThan(500)
    expect(judgePanelWalls(sources)).toEqual([])
    expect(calibrationBoundaryHits(sources)).toEqual([])
  })
  it('reader transitive closure never reaches private calibration DATA', () => {
    const packages = new Map<string, string>()
    for (const file of globSync('packages/*/package.json', { cwd: root })) {
      const pkg = JSON.parse(read(file))
      for (const [key, value] of Object.entries(pkg.exports ?? {})) {
        const target = typeof value === 'string' ? value : (value as { import?: string; default?: string }).import ?? (value as { default?: string }).default
        if (target) packages.set(pkg.name + (key === '.' ? '' : key.slice(1)), file.replace('package.json', '') + target.replace(/^\.\//, '').replace(/^dist\//, 'src/').replace(/\.js$/, '.ts'))
      }
    }
    const closure = calibrationClosure(sources, [local + 'reader.ts'], packages)
    expect(closure.missingEntries).toEqual([])
    expect(closure.unresolved).toEqual([])
    expect(closure.files.filter(file => /judge-calibration|calibration-evidence/.test(file))).toEqual([])
  })
})
