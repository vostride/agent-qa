import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as core from '@vostride/agent-qa-eval'
import { FsEvidenceArtifactStore, FsHandoffStore, RUNS_SUBDIR } from '@vostride/agent-qa-runner-local'
import {
  MARK_RECEIPT_SCHEMA_VERSION,
  SERVED_BRIEF_PROOF_SCHEMA_VERSION,
  asRunId,
  computeBriefDigest,
  distilledScreenStateDigest,
  sha256hex,
  slugBranch,
  type CompletedRunHandoff,
  type MarkReceipt,
} from '@vostride/agent-qa-schema'
import { z } from 'zod'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as local from '../index.js'
import { acquireMarkLock } from '../mark-lock.js'
import { writeGate1Fixture } from './fixtures/gate1-fixtures.js'
import { LOCAL_FIXTURE_BLOB_BYTES, LOCAL_FIXTURE_BLOB_SHA, makeLocalV2Handoff } from './fixtures/local-handoff-fixture.js'

const NO_DECLARED_SECRETS = (text: string) => text
const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const digest = (value: unknown) => sha256hex(core.canonicalJson(value))
const tempRoot = (prefix: string) => { const root = mkdtempSync(join(tmpdir(), prefix)); roots.push(root); return root }
const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8'))
const filesUnder = (dir: string, suffix: string) => readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter(entry => entry.isFile() && !entry.name.startsWith('.') && entry.name.endsWith(suffix))
  .map(entry => join(entry.parentPath, entry.name)).sort()

const SERIALIZATIONS: ((value: unknown) => string)[] = [
  value => JSON.stringify(value), value => `${JSON.stringify(value)}\n`, value => `${JSON.stringify(value, null, 2)}\n`,
  value => `${core.canonicalJson(value)}\n`, value => core.committedFileText(value),
]

function restamp(file: string, stamp: number, holder: (value: any) => { schemaVersion: number } = value => value): void {
  const text = readFileSync(file, 'utf8')
  const value = JSON.parse(text)
  const serialize = SERIALIZATIONS.find(candidate => candidate(value) === text)
  expect(serialize).toBeDefined()
  holder(value).schemaVersion = stamp
  writeFileSync(file, serialize!(value))
}

function calibrationFixture() {
  const root = tempRoot('eval-runtime-stamps-')
  const committedRoot = join(root, 'committed')
  const handoff = makeLocalV2Handoff({ runId: asRunId('eval-runtime-stamps'), scope: { tier: 'product', key: 'shop' } })
  handoff.tests[0]!.steps = [handoff.tests[0]!.steps[0]!]
  for (const sub of handoff.tests[0]!.steps[0]!.subActions) sub.stateBefore.timestamp = 1_725_000_000
  const run = join(root, 'runs', core.deriveRunSlug(handoff.runId)); mkdirSync(run, { recursive: true })
  writeFileSync(join(run, 'handoff.json'), JSON.stringify(handoff))
  new FsEvidenceArtifactStore({ root, runId: handoff.runId }).persistDecisionScreenshot(LOCAL_FIXTURE_BLOB_BYTES)
  const cassettes = core.extractRunCassettes({ handoff, artifacts: new local.FsRunArtifactSource({ root, runId: handoff.runId }) }).cassettes
  const source = cassettes.find(row => row.cassette.granularity === 'leaf')!.cassette as core.LeafCassette
  source.receipt.model = { declared: { provider: 'openai', modelId: 'gpt-5' } }
  const plan = core.buildSeedingPlan({ handoff, cassettes, partition: { saltHex: 'a'.repeat(64), heldOutFraction: 0.000001, privateFraction: 0.5 } })
  if (local.seedCommittedCorpus({ plan, cassettes, committedRoot, mask: NO_DECLARED_SECRETS }).refusals.length) throw new Error('Fixture seed refused')
  const mark: core.GoldMark = { schemaVersion: MARK_RECEIPT_SCHEMA_VERSION, markId: 'mark_abcdef012345', runId: handoff.runId,
    runSlug: core.deriveRunSlug(handoff.runId), testIndex: 0, stepIndex: 0, kind: 'confirmed-bug', origin: 'user', ordinal: 1,
    markedAt: 0, disposition: { kind: 'confirmed-bug', confirmedRecords: 0 }, gold: [], evidence: { confirmed: 0, overturned: 0 } }
  const frozen = core.buildGoldenTrajectoryPlan({ handoff, cassettes, mark, product: 'shop' })
  if (local.seedCommittedCorpus({ plan: { ...plan, cases: frozen.cases }, cassettes: frozen.goldCassettes, committedRoot,
    mask: NO_DECLARED_SECRETS }).refusals.length) throw new Error('Fixture gold refused')
  const cassette = frozen.goldCassettes[0]!.cassette as core.LeafCassette, labelRecord = frozen.cases[0]!.labelRecord
  const identity = core.computeDecisionIdentity(cassette.sidecar.goldAction, cassette.input.stateBefore.elements)
  const outcome: core.LeafReplayResult = { granularity: 'leaf', cassetteId: cassette.id,
    samples: [{ sampleIndex: 0, durationMs: 1, outcome: { kind: 'decision', action: cassette.sidecar.goldAction, identity } }],
    agreement: { k: 1, agreementRate: 1, noConsensus: false, harnessErrorCount: 0, modal: { identity, count: 1 } },
    modalDecision: identity, promptDrift: core.computeReplayDrift(cassette.input, cassette.receipt.promptInputHash),
    briefSource: 'proof', replayedModel: { provider: 'anthropic', modelId: 'claude-sonnet-4-5' }, unconsumedExchanges: [], totalDurationMs: 1 }
  const score = core.scoreCassetteReplay(cassette, outcome, labelRecord)
  const record: local.ScoreRecord = { cassetteId: cassette.id, matcherVersion: 1, score, diffs: [],
    scoringContext: core.createScoringContext({ cassette, outcome, labelRecord, score, judgeRequest: null }) }
  const profile = { plannerModelId: outcome.replayedModel.modelId, fingerprint: 'a'.repeat(64), matcherVersion: 1 }
  const runRoot = join(root, 'eval/gate', slugBranch(core.composeBaselineProfileKey(profile)))
  const replaysRoot = join(runRoot, 'replays')
  const written = new local.FsReplayRecordStore({ root, outputDir: replaysRoot, executionSeed: 17 }).save(outcome)
  const scoreFile = new local.FsScoreStore({ root, outputDir: replaysRoot }).save(record).file
  const report = core.buildEvalReport([{ cassetteId: cassette.id, outcome, score }])
  report.runIdentity = { fingerprint: profile.fingerprint, corpusDigest: core.computeCorpusDigest(local.readActiveCommittedCorpus(committedRoot, root).snapshot.entries) }
  const saveReport = () => new local.FsReportStore({ root, outputDir: join(runRoot, 'reports') }).save(report, undefined, {
    seed: 17, records: [{ cassetteId: cassette.id, replayDigest: digest(readJson(written.file)), scoreDigest: digest(readJson(scoreFile)) }],
  })
  const publication = saveReport().file.replace(/\.json$/, '.publication.json')
  const read = () => local.loadJudgeCalibrationEvidence({ agentQaRoot: root, committedRoot, profile })
  return { publication, read }
}

function adversarialFixture() {
  const root = tempRoot('eval-runtime-stamps-adversarial-')
  const committedRoot = join(root, 'committed'), agentQaRoot = join(root, '.agent-qa')
  mkdirSync(agentQaRoot, { recursive: true })
  const handoff = makeLocalV2Handoff({ runId: asRunId('run / eval-runtime-stamps adversarial') })
  const member = handoff.tests[0]!
  member.steps = [member.steps[0]!]
  const brief = member.steps[0]!.servedBrief
  brief.proof = { schemaVersion: SERVED_BRIEF_PROOF_SCHEMA_VERSION, completeness: 'lossless', recordCap: 8,
    combinedBudget: 2048, admissionEvents: [], promptTurns: [{ ordinal: 0, turnOrdinal: 0,
      runDate: new Date(0).toISOString().slice(0, 10), policyL0: 'policy', learnedL1: 'learned one',
      learnedL2: 'learned two', contextTier: 'context', volatileTier: 'volatile', policyDigest: '1'.repeat(64),
      contextTierDigest: '2'.repeat(64), volatileTierDigest: '3'.repeat(64) }] }
  brief.channel3 = [{ id: 'eval-runtime-stamps-caution' as never, anchors: [], summary: 'served caution' }]
  brief.briefDigest = computeBriefDigest(brief)
  const extracted = core.extractRunCassettes({ handoff,
    artifacts: { getBlob: sha => (sha === LOCAL_FIXTURE_BLOB_SHA ? LOCAL_FIXTURE_BLOB_BYTES : undefined) } })
    .cassettes.find(row => row.cassette.granularity === 'leaf')!
  const seed = extracted.cassette as core.LeafCassette
  const plan: core.SeedingPlan = { product: 'default', runId: handoff.runId, runSlug: 'eval-runtime-stamps-adversarial',
    cases: [{ cassetteId: seed.id, labelRecord: core.projectSilverLabelRecord({ cassette: seed, runId: handoff.runId }),
      corpusEntry: core.projectCorpusEntry({ cassette: seed, product: 'default', runId: handoff.runId,
        assignment: { split: 'natural' } }) }],
    pairSkips: [], silverExclusions: [], pairCounts: { total: 0, sameState: 0, differingState: 0 }, proceduresExcludedCount: 0 }
  if (local.seedCommittedCorpus({ plan, cassettes: [{ cassette: seed, blobs: extracted.blobs }], committedRoot,
    mask: NO_DECLARED_SECRETS }).refusals.length) throw new Error('Fixture seed refused')
  const scope = { agentQaRoot, committedRoot, product: 'default' }
  const stage = async () => {
    const staged = await local.stageAdversarialProposal({ ...scope, mutators: ['confusable'],
      probeAuthor: { author: async () => ({ text: 'Continue to the reviewed control', usage: { promptTokens: 101, completionTokens: 11 } }) },
      authoringModel: { id: 'eval-runtime-stamps-author', family: 'fixture-family' } })
    expect(staged.kind).toBe('staged')
    const [batch] = local.listStagedAdversarial(scope)
    return { batchDigest: staged.batchDigest!, dir: batch!.dir,
      lock: join(batch!.dir, '..', `.pending-lifecycle-${staged.batchDigest!}`) }
  }
  return { scope, stage }
}

function feedbackFixture() {
  const root = tempRoot('eval-runtime-stamps-feedback-')
  const f = writeGate1Fixture(root, { targetInCorpus: false, handoffForTarget: true, proofBrief: true })
  const handoffPath = join(f.agentQaRoot, 'runs', slugBranch(f.injection.target!.runId), 'handoff.json')
  const handoff = readJson(handoffPath) as CompletedRunHandoff
  const step = handoff.tests[0]!.steps[0]!
  const line = step.servedBrief!.channel1[0]!
  line.status = 'candidate'
  line.servedAsCanary = true
  step.servedBrief!.briefDigest = computeBriefDigest(step.servedBrief!)
  step.subActions[0]!.stateBefore.url = 'https://feedback.example/novel'
  step.subActions[0]!.stateBefore.timestamp = 1_725_000_000
  writeFileSync(handoffPath, JSON.stringify(handoff))
  return { agentQaRoot: f.agentQaRoot, committedRoot: f.committedRoot, product: handoff.scope.key,
    target: { runId: String(handoff.runId), testId: handoff.tests[0]!.testId, stepIndex: 0 },
    attributedObservationId: 'fixture-feedback-observation', benefit: 'rode-along' as const,
    candidateId: line.id, stateDigest: distilledScreenStateDigest(step.subActions[0]!.stateBefore),
    mask: NO_DECLARED_SECRETS }
}

function markLedgerFixture() {
  const root = tempRoot('eval-runtime-stamps-marks-')
  const runId = asRunId('run-eval-runtime-stamps')
  new FsHandoffStore({ root, runId }).save({ ...makeLocalV2Handoff(), runId })
  const record: Omit<MarkReceipt, 'ordinal'> = { schemaVersion: MARK_RECEIPT_SCHEMA_VERSION, markId: 'mark_0123456789ab',
    runId, runSlug: slugBranch(runId), testIndex: 0, kind: 'false-fail', origin: 'user', markedAt: 0, gold: [],
    disposition: { kind: 'confirmed-bug', confirmedRecords: 0 }, evidence: { confirmed: 0, overturned: 0 } }
  return { ledger: new local.FsMarkLedger({ root, runId }), record,
    intentPath: join(root, RUNS_SUBDIR, slugBranch(runId), local.MARK_INTENT_FILE) }
}

describe('eval runtime stamps', () => {
  it('writes adversarial refresh state at 2 and reads a refresh record stamped 1 as absent', async () => {
    const f = adversarialFixture()
    await f.stage()
    const files = filesUnder(join(f.scope.agentQaRoot, local.ADVERSARIAL_STATE_SUBDIR), '.json')
    expect(files).toHaveLength(1)
    expect(readJson(files[0]!).schemaVersion).toBe(2)
    expect(local.readAdversarialRefreshRecords(f.scope)).toHaveLength(1)
    restamp(files[0]!, 1)
    expect(local.readAdversarialRefreshRecords(f.scope)).toEqual([])
  })

  it('writes probe reservations and completions at 2 and refuses either stamped 1', async () => {
    const f = adversarialFixture()
    await f.stage()
    const dir = join(f.scope.agentQaRoot, local.ADVERSARIAL_PROBE_SUBDIR)
    const reservations = filesUnder(dir, '.reservation.json'), completions = filesUnder(dir, '.completion.json')
    expect(reservations.length).toBeGreaterThan(0)
    expect(completions).toHaveLength(reservations.length)
    for (const file of [...reservations, ...completions]) expect(readJson(file).schemaVersion).toBe(2)
    expect(local.readProbeAttempts(f.scope).map(attempt => attempt.kind)).toEqual(reservations.map(() => 'completed'))
    const reservation = readFileSync(reservations[0]!, 'utf8')
    restamp(reservations[0]!, 1)
    expect(() => local.readProbeAttempts(f.scope)).toThrow(z.ZodError)
    writeFileSync(reservations[0]!, reservation)
    restamp(completions[0]!, 1)
    expect(() => local.readProbeAttempts(f.scope)).toThrow(z.ZodError)
  })

  it('stages a batch manifest at 2 and refuses to list a batch whose manifest is stamped 1', async () => {
    const f = adversarialFixture()
    const batch = await f.stage()
    const manifest = join(batch.dir, local.ADVERSARIAL_MANIFEST_FILE)
    expect(readJson(manifest).schemaVersion).toBe(2)
    restamp(manifest, 1)
    expect(() => local.listStagedAdversarial(f.scope)).toThrow(z.ZodError)
  })

  it('records a retirement at 2 and refuses a retained batch whose retirement is stamped 1', async () => {
    const f = adversarialFixture()
    const batch = await f.stage()
    const retired = local.retireStagedAdversarialBatch({ ...f.scope, batchDigest: batch.batchDigest })
    expect(readJson(retired.retirementRecordPath).schemaVersion).toBe(2)
    expect(local.listStagedAdversarial({ ...f.scope, includeRetired: true })).toHaveLength(1)
    restamp(retired.retirementRecordPath, 1)
    expect(() => local.listStagedAdversarial({ ...f.scope, includeRetired: true })).toThrow(z.ZodError)
  })

  it('takes the lifecycle lock with an owner at 2 while admitting', async () => {
    const f = adversarialFixture()
    const batch = await f.stage()
    const owners: unknown[] = []
    const admitted = local.refreshAdversarialSplit({ ...f.scope, batchDigest: batch.batchDigest, mask: NO_DECLARED_SECRETS,
      afterCaseCommitted: () => { owners.push(readJson(join(batch.lock, 'owner.json'))) } })
    expect(admitted.admitted.length).toBeGreaterThan(0)
    expect(owners).toHaveLength(admitted.admitted.length)
    for (const owner of owners) {
      expect(owner).toMatchObject({ schemaVersion: 2, product: 'default', batchDigest: batch.batchDigest, pid: process.pid })
    }
    expect(existsSync(batch.lock)).toBe(false)
  })

  it('keeps a dead lifecycle owner stamped 1 busy, and reaps the same owner at 2', async () => {
    const f = adversarialFixture()
    const batch = await f.stage()
    vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }) })
    const ownerFile = join(batch.lock, 'owner.json')
    mkdirSync(batch.lock)
    writeFileSync(ownerFile, core.committedFileText({ schemaVersion: 2, product: 'default', batchDigest: batch.batchDigest,
      pid: process.pid, token: '11111111-1111-4111-8111-111111111111' }))
    restamp(ownerFile, 1)
    const planted = readFileSync(ownerFile, 'utf8')
    expect(() => local.retireStagedAdversarialBatch({ ...f.scope, batchDigest: batch.batchDigest }))
      .toThrow(local.AdversarialLifecycleBusyError)
    expect(readFileSync(ownerFile, 'utf8')).toBe(planted)
    restamp(ownerFile, 2)
    expect(local.retireStagedAdversarialBatch({ ...f.scope, batchDigest: batch.batchDigest }).retired).toBe(true)
    expect(existsSync(`${batch.lock}.dead-11111111-1111-4111-8111-111111111111`)).toBe(true)
  })

  it('stages gate-2 feedback at 2 and refuses to list feedback stamped 1', async () => {
    const input = feedbackFixture()
    expect(await local.stageFeedbackEntry(input)).toMatchObject({ kind: 'staged' })
    const [entry] = local.listStagedFeedback(input)
    const feedback = join(entry!.dir, 'feedback.json')
    expect(readJson(feedback).schemaVersion).toBe(2)
    restamp(feedback, 1)
    expect(() => local.listStagedFeedback(input)).toThrow(z.ZodError)
  })

  it('checkpoints a mark intent at 2 and refuses one stamped 1 by naming the file to remove', async () => {
    const f = markLedgerFixture()
    const operationId = '11111111-2222-4333-8444-555555555555'
    await expect(f.ledger.transact(async ordinal => {
      f.ledger.prepareIntent({ ...f.record, ordinal }, operationId)
      throw new Error('crash before the receipt')
    })).rejects.toThrow('crash before the receipt')
    expect(readJson(f.intentPath).schemaVersion).toBe(2)
    restamp(f.intentPath, 1)
    const fn = vi.fn(async () => f.record)
    const refusal = await f.ledger.transact(fn).then(() => undefined, (error: unknown) => error as Error)
    expect(refusal).toBeInstanceOf(local.MarkIntentUnusableError)
    expect(refusal).toMatchObject({ intentPath: f.intentPath, reason: 'unreadable' })
    expect(refusal?.message).toContain(`${f.intentPath} is unreadable`)
    expect(refusal?.message).toContain('Remove that file, then mark again.')
    expect(fn).not.toHaveBeenCalled()
    expect(f.ledger.read()).toEqual([])
  })

  it('publishes a mark lock owner at 2 and keeps a dead owner stamped 1 busy until it reads 2', async () => {
    const lock = join(tempRoot('eval-runtime-stamps-lock-'), 'marks.jsonl.lock')
    const release = await acquireMarkLock(lock, 'run', () => new Error('busy'))
    const ownerFile = join(lock, 'owner.json')
    const written = readFileSync(ownerFile, 'utf8')
    expect(JSON.parse(written)).toMatchObject({ schemaVersion: 2, kind: 'mark-ledger-lock', pid: process.pid, runId: 'run' })
    release()
    mkdirSync(lock)
    writeFileSync(ownerFile, written)
    restamp(ownerFile, 1)
    const planted = readFileSync(ownerFile, 'utf8')
    vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }) })
    vi.useFakeTimers()
    const rejected = expect(acquireMarkLock(lock, 'run', () => new Error('busy'))).rejects.toThrow('busy')
    await vi.advanceTimersByTimeAsync(10_000); await rejected
    vi.useRealTimers()
    expect(readFileSync(ownerFile, 'utf8')).toBe(planted)
    writeFileSync(ownerFile, written)
    const reaped = await acquireMarkLock(lock, 'run', () => new Error('busy'))
    expect(readJson(ownerFile).token).not.toBe(JSON.parse(written).token)
    reaped()
  })

  it('publishes a report at 2 and reads a publication stamped 1 as missing-profile-proof', () => {
    const f = calibrationFixture()
    expect(readJson(f.publication).schemaVersion).toBe(2)
    restamp(f.publication, 1)
    const result = f.read()
    expect(result.evidence).toEqual([])
    expect(result.skippedCounts).toEqual({ 'missing-profile-proof': 1 })
  })
})
