import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createPanelIdentity, resolveJudgeCalibrationMinimum, wilsonInterval } from '@vostride/agent-qa-eval'
import { sha256hex } from '@vostride/agent-qa-schema'
import * as evidenceSource from '../judge-calibration-evidence-source.js'
import { createJudgeCalibrationArtifact, guardJudgeCalibration, judgeCalibrationGenerationId,
  judgeCalibrationPath, publishJudgeCalibration, readJudgeCalibration, type JudgeCalibrationArtifact } from '../judge-calibration-source.js'

const roots: string[] = []
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'judge-publication-')); roots.push(root)
  const committedRoot = join(root, 'committed'), agentQaRoot = join(root, 'runtime')
  mkdirSync(committedRoot); mkdirSync(agentQaRoot)
  const identity = createPanelIdentity(['claude-sonnet-4', 'gemini-2.5'])
  const input = { committedRoot, agentQaRoot, identity, minN: resolveJudgeCalibrationMinimum(),
    profile: { plannerModelId: 'gpt-5', fingerprint: sha256hex('fixture'), matcherVersion: 1,
      judgeModelId: identity.judgeModelId, judgeVersion: identity.judgeVersion } }
  const artifact = createJudgeCalibrationArtifact(input, { status: 'capability-gap', reason: 'no-credential' })
  const path = join(committedRoot, judgeCalibrationPath(artifact.profileKey))
  return { root, input, artifact, path, publish: (overrides = {}) => publishJudgeCalibration({ ...input,
    artifact, ...overrides }) }
}
function resign(a: JudgeCalibrationArtifact) {
  const { generationId: _generationId, ...body } = a
  a.generationId = judgeCalibrationGenerationId(body)
  return a
}
function put(path: string, value: unknown) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value)) }

it.each(['publication', 'reread'] as const)('rejects invented exclusions against actual zero evidence at %s', async boundary => {
  const f = fixture()
  expect(evidenceSource.loadJudgeCalibrationEvidence(f.input).skippedCounts).toEqual({})
  expect(f.artifact).not.toHaveProperty('skippedCounts')
  const artifact = resign({ ...f.artifact, skippedCounts: { 'missing-executable-correction': 999 } })
  expect(guardJudgeCalibration(artifact)).toEqual(artifact)
  if (boundary === 'publication') {
    expect(await f.publish({ artifact })).toMatchObject({ kind: 'refused' })
    expect(existsSync(f.path)).toBe(false)
  } else {
    put(f.path, artifact)
    const before = readFileSync(f.path, 'utf8')
    expect(readJudgeCalibration(f.input).kind).toBe('refused')
    expect(readFileSync(f.path, 'utf8')).toBe(before)
  }
})

it.each(['invalid-gold', 'missing-source', 'conflicting-gold', 'invalid-executable-correction',
  'invalid-recorded-model', 'corpus-refused', 'path-refused', 'handoff-refused',
  'missing-replay', 'malformed-replay', 'foreign-replay', 'stale-replay', 'ambiguous-replay',
  'missing-profile-proof', 'foreign-profile', 'missing-candidate'] as const)(
  'still refuses %s alongside a legitimate semantic exclusion', async reason => {
    const f = fixture()
    await f.publish()
    const before = readFileSync(f.path, 'utf8')
    const read = evidenceSource.loadJudgeCalibrationEvidence(f.input)
    vi.spyOn(evidenceSource, 'loadJudgeCalibrationEvidence').mockReturnValue({ ...read,
      skippedCounts: { 'missing-executable-correction': 2, [reason]: 1 } })
    expect(() => createJudgeCalibrationArtifact(f.input, { status: 'capability-gap', reason: 'no-credential' })).toThrow()
    expect(readJudgeCalibration(f.input).kind).toBe('refused')
    expect((await f.publish()).kind).toBe('publication-failed')
    expect(readFileSync(f.path, 'utf8')).toBe(before)
  },
)

it('reads absent without creating an artifact or report directory', () => {
  const f = fixture()
  expect(readJudgeCalibration(f.input)).toEqual({ kind: 'absent' })
  expect(existsSync(dirname(f.path))).toBe(false)
})
it('publishes exact identity-bearing gap bytes, reads them and regenerates unchanged', async () => {
  const f = fixture()
  expect(await f.publish()).toMatchObject({ kind: 'committed', artifact: f.artifact })
  const before = readFileSync(f.path)
  expect(readJudgeCalibration(f.input)).toEqual({ kind: 'loaded', artifact: f.artifact })
  expect(await f.publish()).toMatchObject({ kind: 'unchanged' })
  expect(readFileSync(f.path)).toEqual(before)
  expect(createJudgeCalibrationArtifact(f.input, { status: 'capability-gap', reason: 'no-credential' })).toEqual(f.artifact)
  expect(f.artifact).not.toHaveProperty('skippedCounts')
  expect(f.artifact).not.toHaveProperty('pooledAgreement')
  expect(f.artifact).not.toHaveProperty(['audit', 'Directory'].join(''))
  expect(f.artifact.cost).toEqual({ callBound: 0, usage: { calls: 0 } })
})
it('conflicts on divergent bytes and atomically replaces only on explicit request', async () => {
  const f = fixture(); await f.publish()
  const before = readFileSync(f.path)
  const next = createJudgeCalibrationArtifact(f.input, { status: 'capability-gap', reason: 'single-family-host' })
  expect(await f.publish({ artifact: next })).toMatchObject({ kind: 'write-conflict' })
  expect(readFileSync(f.path)).toEqual(before)
  expect(await f.publish({ artifact: next, replace: true })).toMatchObject({ kind: 'committed' })
  expect(readJudgeCalibration(f.input)).toEqual({ kind: 'loaded', artifact: next })
})
it.each(['corpusDigest', 'goldSetDigest', 'replayEvidenceDigest', 'evidenceDigest'] as const)('refuses stale %s even with a valid payload hash', async field => {
  const f = fixture(), artifact = resign({ ...f.artifact, [field]: sha256hex('stale') })
  put(f.path, artifact)
  expect(readJudgeCalibration(f.input).kind).toBe('refused')
  expect(await f.publish({ artifact, replace: true })).toMatchObject({ kind: 'refused' })
  expect(JSON.parse(readFileSync(f.path, 'utf8'))).toEqual(artifact)
})
it.each(['profile', 'identity', 'constitutionDigest', 'minN', 'minNSource', 'generationId', 'cost', 'reason', 'providerError', ['audit', 'Directory'].join('')])('refuses malformed %s', async field => {
  const f = fixture(), artifact = structuredClone(f.artifact) as unknown as Record<string, unknown>
  artifact[field] = field === 'generationId' ? '0'.repeat(64) : 'unsafe-value'
  if (field !== 'generationId') { const { generationId: _generationId, ...body } = artifact; artifact.generationId = judgeCalibrationGenerationId(body) }
  expect(guardJudgeCalibration(artifact)).toBeUndefined()
  put(f.path, artifact)
  expect(readJudgeCalibration(f.input).kind).toBe('refused')
  expect(await f.publish({ replace: true })).toMatchObject({ kind: 'refused' })
})
it('refuses a slug-colliding foreign full key even during replacement', async () => {
  const f = fixture()
  const foreignInput = { ...f.input, profile: { ...f.input.profile, plannerModelId: 'gpt/5' } }
  const foreign = createJudgeCalibrationArtifact(foreignInput, { status: 'capability-gap', reason: 'no-credential' })
  expect(judgeCalibrationPath(foreign.profileKey)).toBe(judgeCalibrationPath(f.artifact.profileKey))
  put(f.path, foreign)
  expect(readJudgeCalibration(f.input).kind).toBe('refused')
  expect(await f.publish({ replace: true })).toMatchObject({ kind: 'refused' })
  expect(JSON.parse(readFileSync(f.path, 'utf8'))).toEqual(foreign)
})
it.each(['reports', 'directory', 'leaf', 'dangling'])('refuses %s symlink without following it', async where => {
  const f = fixture(), external = join(f.root, 'outside')
  mkdirSync(external)
  const target = where === 'reports' ? join(f.input.committedRoot, 'reports') : where === 'directory' ? dirname(f.path) : f.path
  mkdirSync(dirname(target), { recursive: true })
  symlinkSync(where === 'dangling' ? join(external, 'missing') : external, target)
  expect(readJudgeCalibration(f.input).kind).toBe('refused')
  expect(['refused', 'publication-failed']).toContain((await f.publish()).kind)
  expect(readdirSync(external)).toEqual([])
})
it.each(['after-lock', 'before-rename'])('refuses input drift at %s and cleans temporary bytes', async stage => {
  const f = fixture()
  const result = await f.publish({ onBoundary: (at: string) => { if (at === stage) {
    mkdirSync(join(f.input.committedRoot, 'corpus/shop'), { recursive: true })
    writeFileSync(join(f.input.committedRoot, 'corpus/shop', 'bad.json'), '{}')
  } } })
  expect(result.kind).toBe('input-drift')
  expect(existsSync(f.path)).toBe(false)
  expect(existsSync(join(f.input.committedRoot, '.judge-calibration.lock'))).toBe(false)
  if (existsSync(dirname(f.path))) expect(readdirSync(dirname(f.path))).toEqual([])
})

it('validates measured counts, rates and Wilson intervals independently of the payload hash', () => {
  const f = fixture(), { status: _status, ...common } = f.artifact
  const t = { settled: 2, abstained: 0, errors: 0, n: 2, numerator: 1, denominator: 2,
    agreement: 0.5, wilson95: wilsonInterval(1, 2)! }
  const artifact = resign({ ...common, status: 'calibrated', minN: 2, minNSource: 'flag', n: 2, selected: 2, admitted: 2,
    counts: { selected: 2, admitted: 2, eligible: 2, attempted: 2, eligibilityRefused: 0,
      evidenceSkipped: 0, truthComparable: 2, unresolvedTruth: 0 }, pooled: t,
    perMember: f.artifact.identity.members.map(member => ({ judgeModelId: member.judgeModelId, ...t })),
    pooledAgreement: 0.5, wilson95: t.wilson95, abstention: { numerator: 0, denominator: 2, rate: 0 },
    disagreement: { numerator: 0, denominator: 2, rate: 0, pairs: [{ memberModelIds: f.artifact.identity.members.map(m => m.judgeModelId) as [string, string], numerator: 0, denominator: 2, rate: 0 }] },
    cost: { callBound: 8, usage: { calls: 8 } } } as JudgeCalibrationArtifact)
  Reflect.deleteProperty(artifact, 'reason'); resign(artifact)
  expect(guardJudgeCalibration(artifact)).toEqual(artifact)
  if (artifact.status === 'capability-gap') throw new Error('fixture arm')
  const mutations = [
    (a: typeof artifact) => { a.n = 3 },
    (a: typeof artifact) => { a.counts.attempted = 3 },
    (a: typeof artifact) => { a.counts.truthComparable = 1 },
    (a: typeof artifact) => { a.pooled.numerator = 3 },
    (a: typeof artifact) => { a.pooled.wilson95!.lower = 0.2 },
    (a: typeof artifact) => { a.wilson95!.halfWidth = 0 },
    (a: typeof artifact) => { a.perMember[0]!.settled = 3 },
    (a: typeof artifact) => { a.perMember[0]!.judgeModelId = 'foreign' },
    (a: typeof artifact) => { a.disagreement.pairs[0]!.denominator = 3 },
    (a: typeof artifact) => { a.disagreement.pairs[0]!.denominator = 0; delete a.disagreement.pairs[0]!.rate;
      a.disagreement.denominator = 0; delete a.disagreement.rate },
    (a: typeof artifact) => { a.cost.usage.calls = 9 },
    (a: typeof artifact) => { a.status = 'uncalibrated' },
  ]
  for (const mutate of mutations) { const a = structuredClone(artifact); mutate(a); expect(guardJudgeCalibration(resign(a))).toBeUndefined() }
})

it.each(['symlink', 'file'])('refuses a swapped staging %s without publishing attacker bytes', async kind => {
  const f = fixture(), outside = join(f.root, 'outside.json'); writeFileSync(outside, 'attacker')
  const result = await f.publish({ onBoundary: (at: string) => { if (at === 'before-rename') {
    const temp = readdirSync(dirname(f.path)).find(name => name.endsWith('.tmp'))!
    rmSync(join(dirname(f.path), temp))
    if (kind === 'symlink') symlinkSync(outside, join(dirname(f.path), temp))
    else writeFileSync(join(dirname(f.path), temp), 'attacker')
  } } })
  expect(result.kind).toBe('input-drift')
  expect(existsSync(f.path)).toBe(false)
  expect(readFileSync(outside, 'utf8')).toBe('attacker')
})
it('detects concurrent destination replacement without overwriting it', async () => {
  const f = fixture(); await f.publish()
  const next = createJudgeCalibrationArtifact(f.input, { status: 'capability-gap', reason: 'single-family-host' })
  expect(await f.publish({ artifact: next, replace: true, onBoundary: (at: string) => {
    if (at === 'before-rename') writeFileSync(f.path, 'foreign replacement')
  } })).toMatchObject({ kind: 'input-drift' })
  expect(readFileSync(f.path, 'utf8')).toBe('foreign replacement')
})
it('detects lost lock ownership and does not remove the replacement owner', async () => {
  const f = fixture(), lock = join(f.input.committedRoot, '.judge-calibration.lock')
  const result = await f.publish({ onBoundary: (at: string) => { if (at === 'after-lock') {
    renameSync(lock, `${lock}.old`); mkdirSync(lock); writeFileSync(join(lock, 'owner.json'), '{}')
  } } })
  expect(result.kind).toBe('input-drift')
  expect(readFileSync(join(lock, 'owner.json'), 'utf8')).toBe('{}')
  expect(existsSync(f.path)).toBe(false)
})
it('returns busy for a live concurrent publisher without an artifact', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout'] })
  const f = fixture(), lock = join(f.input.committedRoot, '.judge-calibration.lock')
  mkdirSync(lock); writeFileSync(join(lock, 'owner.json'), '{}')
  const publishing = f.publish()
  await vi.advanceTimersByTimeAsync(10_100)
  expect(await publishing).toMatchObject({ kind: 'busy' })
  expect(existsSync(f.path)).toBe(false)
})
