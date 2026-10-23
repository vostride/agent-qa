import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest'
import { calibrateLabels, canonicalJson } from '@vostride/agent-qa-eval'
import { ORIGIN_PRIORS, sha256hex } from '@vostride/agent-qa-schema'
import type { LabelCalibrationArtifact } from '@vostride/agent-qa-eval-local'

vi.mock('@vostride/agent-qa-eval-local', async original => {
  const actual = await original<typeof import('@vostride/agent-qa-eval-local')>()
  return { ...actual, readLabelCalibration: vi.fn(actual.readLabelCalibration) }
})
vi.mock('@vostride/agent-qa-agent-local', async original => {
  const actual = await original<typeof import('@vostride/agent-qa-agent-local')>()
  return { ...actual, composeLocalAgent: vi.fn(actual.composeLocalAgent),
    openRunKnowledgeComposition: vi.fn(actual.openRunKnowledgeComposition),
    createKnowledgeReader: vi.fn(actual.createKnowledgeReader),
    // 432-09: a mark's fix goes through the direct writer, which receives the same priors resolver.
    applyKnowledgeChange: vi.fn(actual.applyKnowledgeChange) }
})
import { LABEL_CALIBRATION_SCHEMA_VERSION, readLabelCalibration } from '@vostride/agent-qa-eval-local'
import { applyKnowledgeChange, composeLocalAgent, createKnowledgeReader, openRunKnowledgeComposition, LOCAL_CURATION_CAPABILITIES } from '@vostride/agent-qa-agent-local'
import { composeCliLocalAgent } from '../../composition/local-agent-host.js'
import { createReplayGateHost, createReplayGatePortForHost } from '../../gates/replay-gate-host.js'
import { createFeedbackPortForHost } from '../../gates/feedback-host.js'
import { markFixture } from '../../gates/__tests__/feedback-fixture.js'
import { buildTrustPriorsResolver } from '../trust-priors.js'

let root: string
beforeEach(() => { vi.clearAllMocks(); root = mkdtempSync(join(tmpdir(), 'agent-qa-priors-cli-')) })
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }) })
afterAll(async () => {
  const { removeInProcessFixtures } = await import('../../composition/__tests__/in-process-run-fixture.js')
  removeInProcessFixtures()
})
function fixture(precision = 0.75): LabelCalibrationArtifact {
  const report = calibrateLabels({ snapshot: { entries: [], labelsById: new Map(), cassettesById: new Map(), blobPresentById: new Map() }, marks: [] })
  const mass = ORIGIN_PRIORS['agent-verified'].alpha + ORIGIN_PRIORS['agent-verified'].beta
  const body = { ...report, minGold: { value: report.minGold.value, source: 'default' as const }, schemaVersion: LABEL_CALIBRATION_SCHEMA_VERSION as typeof LABEL_CALIBRATION_SCHEMA_VERSION, evidenceDigest: sha256hex('synthetic evidence'), targetRevisions: [],
    channels: { ...report.channels, 'recorded-verdict': { status: 'calibrated' as const, n: 20, n_gold: 20,
      precision, wilson95: { lower: 0.1, upper: 0.9, halfWidth: 0.4 } } },
    priors: { 'agent-verified': { alpha: precision * mass, beta: (1 - precision) * mass } },
  }
  return { ...body, generationId: sha256hex(canonicalJson(body)) }
}
function writeArtifact(value: unknown, project = root) {
  const path = join(project, 'agent-qa-eval/labels/calibration.json')
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value))
}
async function build() {
  const result = buildTrustPriorsResolver({ configPath: join(root, 'agent-qa.config.yaml') })
  return result as Extract<typeof result, { kind: 'ready' }>
}

it('resolves once and retains independent immutable old and new snapshots', async () => {
  const old = fixture(); writeArtifact(old)
  const first = await build()
  expect(first?.kind).toBe('ready')
  expect(first.resolve()).toEqual(old.priors)
  expect(first.disclosure).toEqual({ status: 'calibrated', digest: old.generationId,
    nByOrigin: { 'agent-verified': 20, 'agent-observed': 0 } })
  expect(Object.isFrozen(first.resolve())).toBe(true)
  expect(Object.isFrozen(first.resolve()!['agent-verified'])).toBe(true)
  writeArtifact(fixture(0.25))
  expect(first.resolve()).toEqual(old.priors)
  expect(first.resolve()).toBe(first.resolve())
  expect(readLabelCalibration).toHaveBeenCalledTimes(1)
  const second = await build()
  expect(second.resolve()).toEqual(fixture(0.25).priors)
  expect(readLabelCalibration).toHaveBeenCalledTimes(2)
  expect(Object.keys(first.resolve()!)).toEqual(['agent-verified'])
  expect(JSON.stringify(first)).not.toMatch(/targetRevisions|goldSetDigest|channels|correction/)
})

it('distinguishes absent and uncalibrated fallback from a fixed safe refusal', async () => {
  const absent = await build()
  expect(absent?.kind).toBe('ready')
  expect(absent.resolve()).toBeUndefined()
  expect(absent.disclosure.status).toBe('provisional')
  const report = calibrateLabels({ snapshot: { entries: [], labelsById: new Map(), cassettesById: new Map(), blobPresentById: new Map() }, marks: [] })
  const body = { ...report, schemaVersion: LABEL_CALIBRATION_SCHEMA_VERSION, evidenceDigest: sha256hex('fixture'), targetRevisions: [] }
  writeArtifact({ ...body, generationId: sha256hex(canonicalJson(body)) })
  const empty = await build()
  expect(empty.resolve()).toBeUndefined()
  expect(empty.disclosure.status).toBe('provisional')
  writeArtifact({ privateCorrection: 'never disclose this' })
  expect(await build()).toEqual({ kind: 'refused', reason: 'Trust prior calibration is invalid or unavailable; inspect the selected config\'s committed calibration marker and referenced revisions, following https://vostride.com/docs/agent-qa/self-improvement/evals#if-calibration-is-refused before composing this host.' })
})

it('copies both noisy origins and their separate counts without admitting gold or private data', async () => {
  const { generationId: _id, ...body } = fixture()
  const mass = ORIGIN_PRIORS['agent-observed'].alpha + ORIGIN_PRIORS['agent-observed'].beta
  body.channels['self-heal-pair'] = { status: 'calibrated', n: 25, n_gold: 25,
    precision: 0.4, wilson95: { lower: 0.2, upper: 0.6, halfWidth: 0.2 } }
  body.priors = { ...body.priors, 'agent-observed': { alpha: 0.4 * mass, beta: 0.6 * mass } }
  writeArtifact({ ...body, generationId: sha256hex(canonicalJson(body)) })
  const snapshot = await build()
  expect(snapshot.resolve()).toEqual(body.priors)
  expect(snapshot.disclosure.nByOrigin).toEqual({ 'agent-verified': 20, 'agent-observed': 25 })
  expect(Reflect.set(snapshot.resolve()!['agent-observed']!, 'alpha', 100)).toBe(false)
  expect(Reflect.set(snapshot.disclosure.nByOrigin, 'agent-observed', 100)).toBe(false)
  expect(snapshot.resolve()).not.toHaveProperty('user')
  expect(snapshot.resolve()).not.toHaveProperty('import')
  expect(readLabelCalibration).toHaveBeenCalledTimes(1)
})

it('production local host loads once and refuses malformed calibration before composition', async () => {
  writeArtifact(fixture())
  const host = composeCliLocalAgent({ configPath: join(root, 'agent-qa.config.yaml'), agentQaRoot: join(root, '.agent-qa') })
  try {
    const input = vi.mocked(composeLocalAgent).mock.calls.at(-1)![0]
    expect(input.resolveTrustPriors?.()).toEqual(fixture().priors)
    expect(readLabelCalibration).toHaveBeenCalledTimes(1)
    writeArtifact(fixture(0.25))
    expect(input.resolveTrustPriors?.()).toEqual(fixture().priors)
  } finally { await host.close() }
  const replacement = composeCliLocalAgent({ configPath: join(root, 'agent-qa.config.yaml'), agentQaRoot: join(root, '.agent-qa') })
  try {
    expect(vi.mocked(composeLocalAgent).mock.calls.at(-1)![0].resolveTrustPriors?.()).toEqual(fixture(0.25).priors)
    expect(replacement.trustPriorDisclosure.digest).toBe(fixture(0.25).generationId)
    expect(readLabelCalibration).toHaveBeenCalledTimes(2)
  } finally { await replacement.close() }
  writeArtifact({ privateCorrection: 'never disclose this' })
  expect(() => composeCliLocalAgent({ configPath: join(root, 'agent-qa.config.yaml'), agentQaRoot: join(root, '.agent-qa') })).toThrow('Trust prior calibration is invalid or unavailable')
  expect(composeLocalAgent).toHaveBeenCalledTimes(2)
})

it('feedback mark reader and review reuse composition data after artifact replacement without writing calibration', async () => {
  const f = markFixture()
  rmSync(root, { recursive: true, force: true }); root = f.root
  writeArtifact(fixture())
  const port = createFeedbackPortForHost(f.deps)
  expect(readLabelCalibration).toHaveBeenCalledTimes(1)
  writeArtifact(fixture(0.25))
  const before = readFileSync(join(root, 'agent-qa-eval/labels/calibration.json'), 'utf8')
  const result = await port.mark({ runId: f.handoff.runId, kind: 'false-fail' })
  expect(result.kind).toBe('marked')
  const readResolver = vi.mocked(createKnowledgeReader).mock.calls.at(-1)![3]
  const reviewResolver = vi.mocked(applyKnowledgeChange).mock.calls.at(-1)![0].resolveTrustPriors
  expect(readResolver?.()).toEqual(fixture().priors)
  expect(reviewResolver).toBe(readResolver)
  expect(readFileSync(join(root, 'agent-qa-eval/labels/calibration.json'), 'utf8')).toBe(before)
  writeArtifact({ malformed: 'private correction' })
  expect(() => createFeedbackPortForHost(f.deps)).toThrow('Trust prior calibration is invalid or unavailable')
})

it('production suite producer binds the captured snapshot after artifact replacement', async () => {
  const { createInProcessFixture } = await import('../../composition/__tests__/in-process-run-fixture.js')
  const { produceMembersFromPatterns, resolveRunInvocationInputs } = await import('../../commands/run.js')
  const f = createInProcessFixture({ origin: 'http://127.0.0.1:1', environment: 'local' })
  rmSync(root, { recursive: true, force: true }); root = f.project
  writeArtifact(fixture())
  const inputs = await resolveRunInvocationInputs({ configPath: f.configPath, patterns: [f.suitePattern] })
  const produced = await produceMembersFromPatterns({ inputs, runId: 'fixture-run' })
  try {
    expect(produced.members).toHaveLength(1)
    writeArtifact(fixture(0.25))
    produced.bindKnowledge!(1)
    const input = vi.mocked(openRunKnowledgeComposition).mock.calls.at(-1)![0]
    expect(input.resolveTrustPriors?.()).toEqual(fixture().priors)
    expect(readLabelCalibration).toHaveBeenCalledTimes(1)
  } finally { await produced.finalize?.() }
})

it('standalone replay host binds a cached reader and refuses malformed data before any gate', async () => {
  writeArtifact(fixture())
  const deps = { configPath: join(root, 'agent-qa.config.yaml'), agentQaRoot: root,
    session: { config: { knowledge: { dir: 'knowledge' } } }, record: false, composition: {} } as never
  createReplayGateHost(deps)
  const resolver = vi.mocked(createKnowledgeReader).mock.calls.at(-1)?.[3]
  expect(resolver?.()).toEqual(fixture().priors)
  writeArtifact(fixture(0.25))
  expect(resolver?.()).toEqual(fixture().priors)
  expect(readLabelCalibration).toHaveBeenCalledTimes(1)
  writeArtifact({ secret: 'private mark' })
  expect(() => createReplayGateHost(deps)).toThrow('Trust prior calibration is invalid or unavailable')
})

it('replay reader and receipt writer share the prior snapshot and preserve calibration bytes', async () => {
  const f = markFixture()
  rmSync(root, { recursive: true, force: true }); root = f.root
  writeArtifact(fixture())
  const { resolveEvalSession } = await import('../../eval-session-composition.js')
  const { completeGate1Receipt } = await import(new URL('../../../../knowledge-local/src/curator/__tests__/fixtures/promotion-floor-fixture.js', import.meta.url).href)
  const session = await resolveEvalSession({ configPath: f.configPath, keyOnly: true })
  const recordGateReceipt = vi.fn<typeof LOCAL_CURATION_CAPABILITIES.recordGateReceipt>(async () => ({ kind: 'appended' as const }))
  const host = createReplayGateHost({ configPath: f.configPath, agentQaRoot: f.agentQaRoot, session, record: true,
    composition: {} as never, curation: { recordGateReceipt, maintenance: LOCAL_CURATION_CAPABILITIES.maintenance },
    runReplayGate: async () => ({ kind: 'receipt', receipt: completeGate1Receipt(f.published.id),
      lines: [], notices: [], refusals: [], modelCalls: 0, wallClockMs: 0 }),
  })
  writeArtifact(fixture(0.25))
  const before = readFileSync(join(root, 'agent-qa-eval/labels/calibration.json'), 'utf8')
  expect(await host.run(f.published.id)).toMatchObject({ kind: 'receipt', recorded: 'appended' })
  const input = recordGateReceipt.mock.calls[0]![0] as Parameters<typeof LOCAL_CURATION_CAPABILITIES.recordGateReceipt>[0]
  expect(input.resolveTrustPriors?.()).toEqual(fixture().priors)
  expect(input.resolveTrustPriors).toBe(vi.mocked(createKnowledgeReader).mock.calls.at(-1)![3])
  expect(readLabelCalibration).toHaveBeenCalledTimes(1)
  expect(readFileSync(join(root, 'agent-qa-eval/labels/calibration.json'), 'utf8')).toBe(before)
})

it('lazy replay port passes its original snapshot into the later eval verb', async () => {
  const f = markFixture()
  rmSync(root, { recursive: true, force: true }); root = f.root
  writeArtifact(fixture())
  const session = await import('../../eval-session-composition.js')
  const verb = vi.spyOn(session, 'runReplayGateVerb').mockRejectedValue(new Error('captured replay boundary'))
  const port = createReplayGatePortForHost(f.deps)
  writeArtifact(fixture(0.25))
  await expect(port.runReplayGate(f.published.id)).rejects.toThrow('captured replay boundary')
  expect(verb.mock.calls[0]![2]?.resolveTrustPriors?.()).toEqual(fixture().priors)
  expect(readLabelCalibration).toHaveBeenCalledTimes(1)
})

it('composed local run forwards its snapshot through the in-process producer dispatch', async () => {
  const { createInProcessFixture } = await import('../../composition/__tests__/in-process-run-fixture.js')
  const run = await import('../../commands/run.js')
  const f = createInProcessFixture({ origin: 'http://127.0.0.1:1', environment: 'local' })
  rmSync(root, { recursive: true, force: true }); root = f.project
  writeArtifact(fixture())
  const produce = vi.spyOn(run, 'produceMembersFromPatterns').mockRejectedValue(new Error('captured producer boundary'))
  const host = composeCliLocalAgent({ configPath: f.configPath, agentQaRoot: join(root, '.agent-qa') })
  try {
    const input = vi.mocked(composeLocalAgent).mock.calls.at(-1)![0]
    writeArtifact(fixture(0.25))
    await expect(input.runExecution!.execute({ patterns: [f.testPattern] })).rejects.toThrow('captured producer boundary')
    expect(produce.mock.calls[0]![0].resolveTrustPriors).toBe(input.resolveTrustPriors)
    expect(produce.mock.calls[0]![0].resolveTrustPriors?.()).toEqual(fixture().priors)
    expect(readLabelCalibration).toHaveBeenCalledTimes(1)
  } finally { await host.close() }
})

it('production direct member retains composition priors until its serving reader opens', async () => {
  const { createInProcessFixture } = await import('../../composition/__tests__/in-process-run-fixture.js')
  const { produceMembersFromPatterns, resolveRunInvocationInputs } = await import('../../commands/run.js')
  const { WebPlatformAdapter } = await import('@vostride/agent-qa-web')
  vi.spyOn(WebPlatformAdapter.prototype, 'setup').mockResolvedValue(undefined)
  const f = createInProcessFixture({ origin: 'http://127.0.0.1:1', environment: 'local' })
  rmSync(root, { recursive: true, force: true }); root = f.project
  writeArtifact(fixture())
  const inputs = await resolveRunInvocationInputs({ configPath: f.configPath, patterns: [f.testPattern] })
  const produced = await produceMembersFromPatterns({ inputs, runId: 'fixture-run' })
  writeArtifact(fixture(0.25))
  // Stop at the real reader boundary, before any planner/provider call or browser activity.
  vi.mocked(openRunKnowledgeComposition).mockImplementationOnce(() => { throw new Error('captured serving boundary') })
  const result = await produced.executor(produced.members[0]!, { testIndex: 0 } as never)
  expect(result.failureSummary).toContain('captured serving boundary')
  expect(vi.mocked(openRunKnowledgeComposition).mock.calls.at(-1)![0].resolveTrustPriors?.()).toEqual(fixture().priors)
  expect(readLabelCalibration).toHaveBeenCalledTimes(1)
})

it.each([false, true])('local host selects request B priors before the producer (malformed=%s)', async malformed => {
  const { createInProcessFixture } = await import('../../composition/__tests__/in-process-run-fixture.js')
  const run = await import('../../commands/run.js')
  const a = createInProcessFixture({ origin: 'http://127.0.0.1:1', environment: 'local' })
  const b = createInProcessFixture({ origin: 'http://127.0.0.1:1', environment: 'local' })
  writeArtifact(fixture(), a.project)
  writeArtifact(malformed ? { privateCorrection: 'invalid B' } : fixture(0.25), b.project)
  const producer = vi.spyOn(run, 'produceMembersFromPatterns').mockRejectedValue(new Error('captured producer boundary'))
  const host = composeCliLocalAgent({ configPath: a.configPath, agentQaRoot: a.agentQaRoot })
  try {
    const local = vi.mocked(composeLocalAgent).mock.calls.at(-1)![0]
    writeArtifact(fixture(0.5), a.project)
    await expect(local.runExecution!.execute({ configPath: b.configPath, patterns: [b.testPattern] }))
      .rejects.toThrow(malformed ? 'Trust prior calibration is invalid or unavailable' : 'captured producer boundary')
    expect(readLabelCalibration).toHaveBeenCalledTimes(2)
    if (malformed) expect(producer).not.toHaveBeenCalled()
    else {
      expect(producer.mock.calls[0]![0].inputs.configFilePath).toBe(b.configPath)
      expect(producer.mock.calls[0]![0].resolveTrustPriors?.()).toEqual(fixture(0.25).priors)
      expect(producer.mock.calls[0]![0].resolveTrustPriors).not.toBe(local.resolveTrustPriors)
    }
    expect(local.resolveTrustPriors?.()).toEqual(fixture().priors)
    expect(host.trustPriorDisclosure.digest).toBe(fixture().generationId)
    await expect(local.runExecution!.execute({ configPath: join(a.project, '.', 'agent-qa.config.yaml'), patterns: [a.testPattern] }))
      .rejects.toThrow('captured producer boundary')
    expect(producer.mock.calls.at(-1)![0].resolveTrustPriors).toBe(local.resolveTrustPriors)
    expect(readLabelCalibration).toHaveBeenCalledTimes(2)
  } finally {
    await host.close()
    rmSync(a.project, { recursive: true, force: true }); rmSync(b.project, { recursive: true, force: true })
  }
})
