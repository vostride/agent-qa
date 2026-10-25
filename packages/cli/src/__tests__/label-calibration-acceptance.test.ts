import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { Command } from 'commander'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as model from '@vostride/agent-qa-model'
import { asRef, GateReceiptSchema, receiptDigestOf, screenStateHash, sha256hex, type Verdict } from '@vostride/agent-qa-schema'
import { readCommittedCorpus, FsReportStore,
  committedLabelPath, runReplayGate, serializeReplayGateReceipt, FsRunArtifactSource, seedCommittedCorpus } from '@vostride/agent-qa-eval-local'
import { projectSilverLabelRecord, extractRunCassettes, buildSeedingPlan, projectCorpusEntry, canonicalJson, type LeafCassette } from '@vostride/agent-qa-eval'
import { files, markFixture } from '../gates/__tests__/feedback-fixture.js'
import { createEvalCommand } from '../commands/eval.js'
import * as host from '../composition/local-agent-host.js'
import * as verbs from '../eval-session-composition.js'

const { labelGateFixture, labelMetricIds, legacyReport, rewriteReport } = await import(new URL('../../../eval-local/src/__tests__/fixtures/label-gate-fixtures.js', import.meta.url).href)
const { gate1Responder, warmGateRoot, writeGate1Fixture } = await import(new URL('../../../eval-local/src/__tests__/fixtures/gate1-fixtures.js', import.meta.url).href)
const { actionGenerateResult, respondingStub, noneAuth, stubProfile } = await import(new URL('../../../eval-local/src/__tests__/fixtures/replay-fixtures.js', import.meta.url).href)
const { incrementingClock } = await import(new URL('../../../eval-local/src/__tests__/fixtures/floor-fixtures.js', import.meta.url).href)
const actualCreateModel = model.createModel
let fixtureModels = false
const NO_DECLARED_SECRETS = (text: string) => text
const roots: string[] = []
const terminals: Array<PassThrough | Writable> = []
const bytes = (root: string) => files(root).map(path => [path, readFileSync(path).toString('hex')])
beforeEach(() => {
  fixtureModels = false
  process.exitCode = 0
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('external provider forbidden') })
  vi.spyOn(model, 'createModel').mockImplementation(() => { throw new Error('model creation forbidden') })
  const compose = host.composeCliLocalAgent
  // 2026-10-01 (432-16): the terminal confirm that answered `y` here is deleted; nothing asks.
  vi.spyOn(host, 'composeCliLocalAgent').mockImplementation(options =>
    compose({ ...options, resolveExecutionContext: () => 'local-interactive' }))
})
afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled()
  if (!fixtureModels) expect(model.createModel).not.toHaveBeenCalled()
  process.exitCode = 0
  vi.restoreAllMocks()
  for (const terminal of terminals.splice(0)) terminal.destroy()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
async function command(configPath: string, args: string[]) {
  vi.mocked(console.log).mockClear(); vi.mocked(console.error).mockClear(); process.exitCode = 0
  await new Command('agent-qa').option('--config <path>')
    .addCommand(createEvalCommand()).exitOverride()
    .parseAsync(['--config', configPath, ...args], { from: 'user' })
  const stdout = vi.mocked(console.log).mock.calls.map(row => row.join(' ')).join('\n')
  const stderr = vi.mocked(console.error).mock.calls.map(row => row.join(' ')).join('\n')
  return { stdout, stderr, exit: process.exitCode }
}
async function json(configPath: string, args: string[]) {
  const output = await command(configPath, [...args, '--json'])
  if (args[1] !== 'gate' && args[1] !== 'report') expect(output.stderr).toBe('')
  return { ...output, dto: JSON.parse(output.stdout) }
}
async function fixture() {
  const f = markFixture(); roots.push(f.root)
  writeFileSync(join(f.root, '.env.secrets.local'), '')
  const member = f.handoff.tests[0]!, original = member.steps[0]!
  member.outcome = 'passed'; f.handoff.aggregateVerdict = 'passed'
  // Twenty-one distinct source addresses, including one false-pass correction.
  // The near-gold pair is a separate source and never pads the marked denominator.
  member.steps = Array.from({ length: 21 }, (_, stepIndex) => ({ ...structuredClone(original), stepIndex,
    verifierVerdict: { pass: true, reasoning: 'Recorded fixture verdict' } }))
  const pair = structuredClone(original); pair.stepIndex = 21
  pair.modelProfile = { provider: 'openai', modelId: 'small-fixture', vision: true }
  pair.verifierVerdict = { pass: true, reasoning: 'Recovery verified' }
  const failed = pair.subActions[0]!, recovering = structuredClone(failed), ref = asRef('e-recovery')
  failed.result = { success: false, error: 'First action failed' }
  recovering.stateBefore.elements.push({ ...structuredClone(recovering.stateBefore.elements[0]!), ref, name: 'Recovery', nameNormalized: 'recovery' })
  recovering.stateBefore.refMap[ref] = structuredClone(recovering.stateBefore.refMap[recovering.stateBefore.elements[0]!.ref]!)
  recovering.plannedAction = { type: 'click', ref }; recovering.result = { success: true }
  recovering.callRecord = { resolvedModelId: 'small-fixture' }
  pair.subActions = [failed, recovering]
  pair.selfHeal = { failedDecision: { plan: failed.plan, plannedAction: failed.plannedAction, result: failed.result },
    recoveringDecision: { plan: recovering.plan, plannedAction: recovering.plannedAction, result: recovering.result } }
  member.steps.push(pair); f.save()
  const seeded = await json(f.configPath, ['eval', 'seed', '--held-out-fraction', '0.4', '--private-fraction', '0.5'])
  expect(seeded.exit, seeded.stdout).toBe(0)
  expect(seeded.dto).toMatchObject({ seededCount: 23, refusals: [], runsSkipped: [] })
  const calibrate = (flags: string[] = []) => json(f.configPath, ['eval', 'calibrate', ...flags])
  return { ...f, committedRoot: join(f.root, 'agent-qa-eval'), calibrate }
}

it('keeps all eleven own-profile comparison rows and legacy exits through real fresh/saved gate commands', async () => {
  // These model calls use in-process fixture languageModels; the external fetch port still throws.
  fixtureModels = true; vi.mocked(model.createModel).mockImplementation(actualCreateModel)
  const root = mkdtempSync(join(tmpdir(), 'agent-qa-calibration-gate-')); roots.push(root)
  const f = await labelGateFixture(root), configPath = join(root, 'agent-qa.config.yaml')
  writeFileSync(configPath, ['workspace:', '  testMatch: [tests/**/*.yaml]', '  suiteMatch: [suites/**/*.suite.yaml]',
    '  hooksFile: hooks.yaml', '  envFile: .env', '  secretsFile: .env.secrets.local', 'registry:', '  llms:',
    '    - name: planner', '      provider: openai-compatible', `      model: ${f.input.mode.profile.model}`,
    '      baseURL: http://localhost:1/v1', 'use:', '  llm: planner', '  mobile:', '    appState: preserve', ''].join('\n'))
  writeFileSync(join(root, '.env.secrets.local'), '')
  const actualGate = verbs.runGateVerb
  vi.spyOn(verbs, 'runGateVerb').mockImplementation((session, opts) => actualGate(session, { ...opts, plannerOverrides: f.input.mode.modelOverrides }))
  const fresh = await json(configPath, ['eval', 'gate'])
  expect(fresh.exit).toBe(0); expect(fresh.dto.kind).toBe('verdict')
  expect(fresh.dto.verdict.labelMetrics.rows.map((row: { metric: string }) => row.metric)).toEqual(labelMetricIds)
  // This historical floor fixture has no mark/handoff population and reports that absence.
  expect(fresh.dto.currentReport.calibration).toEqual({ status: 'uncalibrated' })
  f.stub.captured.length = 0
  const currentBytes = readFileSync(fresh.dto.currentReportFile, 'utf8')
  for (const legacy of [false, true]) {
    if (legacy) rewriteReport(f.baselineFile, legacyReport)
    const baselineBytes = readFileSync(f.baselineFile, 'utf8')
    const flags = ['eval', 'gate', '--report', fresh.dto.currentReport.batchKey]
    const saved = await json(configPath, flags)
    expect(saved.exit).toBe(fresh.exit); expect(saved.dto.modelCalls).toBe(0)
    const text = await command(configPath, flags)
    for (const row of saved.dto.verdict.labelMetrics.rows) {
      const line = text.stdout.split('\n').find(line => line.startsWith(`label-metric: ${row.metric} `))!
      expect(JSON.parse(line.slice(`label-metric: ${row.metric} `.length))).toEqual(row)
    }
    if (legacy) expect(saved.dto.verdict.labelMetrics.rows[0]).toMatchObject({ status: 'not-comparable',
      reasons: expect.arrayContaining([expect.objectContaining({ side: 'baseline', reason: 'missing-field' })]) })
    else expect(saved.dto.verdict).toEqual(fresh.dto.verdict)
    expect(readFileSync(f.baselineFile, 'utf8')).toBe(baselineBytes)
  }
  expect(readFileSync(fresh.dto.currentReportFile, 'utf8')).toBe(currentBytes)
  expect(f.stub.captured).toHaveLength(0)
  // A genuine saved report with harness-error accounting still yields exit2.
  const errored = structuredClone(fresh.dto.currentReport)
  errored.honesty.harnessErrorCount = 1
  const decisions = JSON.parse(readFileSync(fresh.dto.currentReportFile.replace(/\.json$/, '.decisions.json'), 'utf8'))
  const directory = join(root, 'staged-error')
  new FsReportStore({ root: f.input.agentQaRoot, outputDir: directory }).save(errored, decisions)
  expect((await json(configPath, ['eval', 'gate', '--report', errored.batchKey, '--staged-dir', directory])).exit).toBe(2)
})

it('persists an actual zero-tolerance harmed receipt carrying the weight produced by calibration', async () => {
  const f = await fixture()
  await f.calibrate(['--commit'])
  const weight = [...readCommittedCorpus(f.committedRoot).snapshot.labelsById.values()].find(row => row.weight)?.weight!
  expect(weight.value).toBeGreaterThan(0)
  fixtureModels = true; vi.mocked(model.createModel).mockImplementation(actualCreateModel)
  const root = mkdtempSync(join(tmpdir(), 'agent-qa-calibration-harm-')); roots.push(root)
  const gate = writeGate1Fixture(root)
  const baseline = respondingStub((call: { prompt: unknown }) => JSON.stringify(call.prompt).includes('gate1-target-sibling-1')
    ? actionGenerateResult() : gate1Responder(gate)(call))
  await warmGateRoot(gate, baseline)
  const stub = respondingStub((call: { prompt: unknown }) => JSON.stringify(call.prompt).includes('gate1-collateral-0')
    ? actionGenerateResult('web', 'e-other') : gate1Responder(gate)(call))
  const { cassette } = gate.selected.find((row: { cassette: LeafCassette }) => row.cassette.input.stepText === 'gate1-collateral-0')!
  const label = { ...projectSilverLabelRecord({ cassette, runId: cassette.runId }), weight }
  const path = join(gate.committedRoot, committedLabelPath('alpha', cassette.id))
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(label))
  const result = await runReplayGate({ injection: gate.injection, committedRoot: gate.committedRoot, agentQaRoot: gate.agentQaRoot,
    identity: gate.identity, planner: { profile: stubProfile(), modelOverrides: { languageModels: stub.languageModels }, resolveAuth: async () => noneAuth },
    judgeOverrideConfigured: false, k: 3, kSource: 'default', maxScreens: 64,
    baselineSeed: { floorSeeds: [11] }, producedBy: { opId: 'eval.replay-gate' }, clock: incrementingClock(),
    mask: (text: string) => text })
  expect(result.kind).toBe('receipt')
  if (result.kind !== 'receipt') throw new Error('gate receipt refused')
  expect(result.receipt.verdict).toBe('fail')
  expect(result.receipt.reasons).toEqual(['collateral-harm'])
  expect(result.receipt.harmed).toEqual([expect.objectContaining({ cassetteId: cassette.id, softWeight: weight.value })])
  const receiptPath = join(root, 'receipt.json')
  writeFileSync(receiptPath, serializeReplayGateReceipt(result.receipt))
  const saved = GateReceiptSchema.parse(JSON.parse(readFileSync(receiptPath, 'utf8')))
  expect(saved).toEqual(result.receipt); expect(receiptDigestOf(saved)).toBe(saved.receiptDigest)
})

const fractions = { heldOutFraction: 0.4, privateFraction: 0.5 }
const partition = { ...fractions, saltHex: '0'.repeat(64) }
const verdict = (classification: Verdict['class'], perTest: number): Verdict => ({ class: classification,
  producer: 'deterministic-classifier', perTest, confidence: 1, memoryMisdirectionRuledOut: true,
  evidence: { citedSteps: [0], citedAnchors: [], citedArtifacts: [], rationale: 'Recorded failure' } })
function rerunFixture(existingOriginal = true) {
  const f = markFixture(); roots.push(f.root)
  writeFileSync(join(f.root, '.env.secrets.local'), '')
  const member = f.handoff.tests[0]!
  f.handoff.tests = [member]
  const committedRoot = join(f.root, 'agent-qa-eval')
  const artifacts = new FsRunArtifactSource({ root: f.agentQaRoot, runId: f.handoff.runId })
  const evidence = structuredClone(member.steps[0]!)
  // 422-12: extraction now projects the member's recorded root cause onto the cassette label, so
  // the ORIGINAL cassette must be extracted from a handoff carrying the ORIGINAL attempt's
  // verdict — the one `rerunOrigin.rootCause` preserves below — never the rerun's final class.
  member.rootCause = verdict('environment', 0)
  const originalExtraction = extractRunCassettes({ handoff: f.handoff, artifacts }).cassettes
  const original = originalExtraction.find(row => row.cassette.granularity === 'leaf')!.cassette
  if (original.granularity !== 'leaf') throw new Error('fixture leaf missing')
  const label = projectSilverLabelRecord({ cassette: original, runId: f.handoff.runId })
  const originalPlan = buildSeedingPlan({ handoff: f.handoff, cassettes: originalExtraction, partition })
  originalPlan.cases = [{ cassetteId: original.id, labelRecord: label, corpusEntry: projectCorpusEntry({
    cassette: original, product: 'default', runId: f.handoff.runId, assignment: { split: 'natural' },
  }) }]
  if (existingOriginal) {
    const initial = seedCommittedCorpus({ plan: originalPlan, cassettes: originalExtraction,
      committedRoot, mask: NO_DECLARED_SECRETS })
    expect(initial.refusals).toEqual([])
    expect(initial.seededCount).toBe(1)
  }
  const facts = { runId: f.handoff.runId, testId: member.testId, testIndex: member.testIndex,
    stepIndex: evidence.stepIndex, decisionOrdinal: 0, evidence }
  const origin = { attempt: 0, outcome: 'failed' as const, rootCause: verdict('environment', 0),
    decisions: [{ ...facts, screenStateHash: screenStateHash(evidence.subActions[0]!.stateBefore),
      evidenceDigest: sha256hex(canonicalJson(facts)) }] }
  member.isRerun = true; member.rerunAttempt = 2
  member.rerunOrigin = { ...origin, evidenceDigest: sha256hex(canonicalJson(origin)) }
  member.rootCause = verdict('flake', 0)
  member.outcome = 'passed'
  member.steps[0]!.verifierVerdict = { pass: true, reasoning: 'Retry passed' }
  // A recovery on a later step keeps distinct actual cassette addresses from the original.
  const pairStep = structuredClone(member.steps[0]!)
  pairStep.stepIndex = 1
  const failed = pairStep.subActions[0]!, recovering = structuredClone(failed)
  failed.result = { success: false, error: 'Action rejected' }
  const ref = asRef('e-recovery')
  recovering.stateBefore.elements.push({ ...structuredClone(recovering.stateBefore.elements[0]!), ref,
    name: 'Recovery', nameNormalized: 'recovery' })
  recovering.stateBefore.refMap[ref] = structuredClone(recovering.stateBefore.refMap[recovering.stateBefore.elements[0]!.ref]!)
  recovering.plannedAction = { type: 'click', ref }
  recovering.result = { success: true }
  pairStep.subActions = [failed, recovering]
  const decision = (sub: typeof failed) => ({ plan: sub.plan, plannedAction: sub.plannedAction, result: sub.result })
  pairStep.selfHeal = { failedDecision: decision(failed), recoveringDecision: decision(recovering) }
  member.steps.push(pairStep)
  const silver = structuredClone(member)
  silver.testIndex = 2; silver.rootCause = verdict('flake', 2)
  delete silver.rerunOrigin
  silver.steps = [structuredClone(member.steps[0]!)]
  const excluded = structuredClone(member)
  excluded.testIndex = 5; excluded.rootCause = verdict('timeout', 5)
  excluded.outcome = 'timeout'
  delete excluded.isRerun; delete excluded.rerunAttempt; delete excluded.rerunOrigin
  // Even a self-heal step here must not enter this mixed run's admission/population.
  f.handoff.tests = [member, silver, excluded]
  f.save()
  return { ...f, member, silver, excluded, original, committedRoot, artifacts }
}

it('seeds original-failure rerun quarantine and recovery through the actual command and repeats byte-identically', async () => {
  const f = rerunFixture(), old = bytes(f.committedRoot)
  const result = (await json(f.configPath, ['eval', 'seed', '--held-out-fraction', '0.4', '--private-fraction', '0.5'])).dto
  expect(result).toMatchObject({ seededCount: 3, supersededOriginalCount: 1,
    retirementCounts: { missing: 0, conflict: 0 }, refusals: [], runsSkipped: [] })
  const read = readCommittedCorpus(f.committedRoot)
  expect(read.snapshot.labelsById.get(f.original.id)?.quarantine).toBe('rerun-overturned')
  expect(read.snapshot.entries.some(entry => entry.cassetteId === f.original.id)).toBe(false)
  const pairs = [...read.snapshot.labelsById.values()].filter(label => label.label.sourceChannel === 'self-heal-pair')
  expect(pairs).toHaveLength(2)
  for (const label of pairs) expect(label).toMatchObject({ weight: { k: 1, n: 1 }, provenance: { rerun: { attempt: 2 } } })
  for (const [path, content] of old) expect(readFileSync(path!).toString('hex')).toBe(content)
  const before = bytes(f.root)
  expect((await json(f.configPath, ['eval', 'seed'])).dto).toMatchObject({ seededCount: 0, unchangedCount: 3, supersededOriginalCount: 0 })
  expect(bytes(f.root)).toEqual(before)
})
