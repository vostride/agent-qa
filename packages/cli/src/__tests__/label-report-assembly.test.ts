import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { calibrateLabels, canonicalJson, createLabelRevision, projectSilverLabelRecord } from '@vostride/agent-qa-eval'
import { FsReplayRecordStore, FsScoreStore, LABEL_CALIBRATION_SCHEMA_VERSION, committedLabelPath, readCommittedCorpus } from '@vostride/agent-qa-eval-local'
import { sha256hex } from '@vostride/agent-qa-schema'
import { resolveEvalSession, runReportVerb } from '../eval-session-composition.js'

const { writeCommittedFloorFixture } = await import(new URL('../../../eval-local/src/__tests__/fixtures/floor-fixtures.js', import.meta.url).href)
const { metricEntry, weight } = await import(new URL('../../../eval/src/match/__tests__/fixtures/label-metric-fixtures.js', import.meta.url).href)
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function write(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value))
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agent-qa-label-report-')); roots.push(root)
  const corpus = writeCommittedFloorFixture(root)
  const committedRoot = join(root, 'agent-qa-eval')
  cpSync(corpus.committedRoot, committedRoot, { recursive: true })
  const agentQaRoot = join(root, '.agent-qa')
  for (const { cassette } of corpus.selected) {
    const entry = metricEntry(cassette.id)
    new FsReplayRecordStore({ root: agentQaRoot }).save(entry.outcome)
    new FsScoreStore({ root: agentQaRoot }).save({ cassetteId: cassette.id,
      matcherVersion: 1, score: entry.score, diffs: [] })
    write(join(committedRoot, committedLabelPath(cassette.input.servedBrief.scope.key, cassette.id)),
      projectSilverLabelRecord({ cassette, runId: cassette.runId }))
  }
  const configPath = join(root, 'agent-qa.config.yaml')
  writeFileSync(configPath, 'workspace:\n  testMatch: [tests/**/*.yaml]\n  suiteMatch: [suites/**/*.suite.yaml]\n  hooksFile: hooks.yaml\n  envFile: .env\n  secretsFile: .env.secrets.local\nuse:\n  mobile:\n    appState: preserve\n')
  writeFileSync(join(root, '.env.secrets.local'), '')
  const session = await resolveEvalSession({ configPath })
  return { root, committedRoot, agentQaRoot, session, corpus }
}

it('joins exact committed split ownership through the actual report command', async () => {
  const f = await fixture()
  const { report } = await runReportVerb(f.session, {}, { source: 'committed' })
  expect(report.perSplit.natural.firstAttemptDecisionAccuracy.denominator).toBe(1)
  expect(report.perSplit['held-out'].shared.firstAttemptDecisionAccuracy.denominator).toBe(1)
  expect(report.perSplit['held-out'].private.firstAttemptDecisionAccuracy.denominator).toBe(1)
  expect(report.perSplit.unassignedCount).toBe(0)
  expect(report.calibration).toEqual({ status: 'uncalibrated' })
})

it('suppresses a quarantined cached score but retains its incurred planner and judge costs', async () => {
  const f = await fixture()
  const read = readCommittedCorpus(f.committedRoot)
  const label = [...read.snapshot.labelsById.values()][0]!
  const cached = metricEntry(label.cassetteId)
  cached.score.entry.score.judgeSettled = { cause: 'partial-identity', axis: 'element-identity',
    resolution: 'equivalent', judgeId: 'fixture', judgeVersion: 1, confidence: 'high',
    usage: { calls: 1, inputTokens: 7, outputTokens: 3 } }
  new FsScoreStore({ root: f.agentQaRoot }).save({ cassetteId: label.cassetteId,
    matcherVersion: 1, score: cached.score, diffs: [] })
  const product = read.snapshot.entries.find(entry => entry.cassetteId === label.cassetteId)!.product
  const revision = createLabelRevision(label, { quarantine: 'rerun-overturned' })
  write(join(f.committedRoot, committedLabelPath(product, label.cassetteId)).replace(/\.json$/, `--revision-${revision.revision!.id}.json`), revision)
  const { entries, report } = await runReportVerb(f.session, {}, { source: 'committed' })
  expect(entries).toBe(3)
  expect(report.headline.firstAttemptDecisionAccuracy.denominator).toBe(2)
  expect(report.totalCost.totalTokens).toBe(45)
  expect(report.honesty.judge.cost).toMatchObject({ calls: 1, inputTokens: 7, outputTokens: 3 })
  expect(report.honesty.judge.settled['partial-identity']).toBe(0)
})

it('rejects partial Phase420 metadata on the actual from-committed command path', async () => {
  const f = await fixture()
  const current = await runReportVerb(f.session, {}, { source: 'committed' })
  const malformed = structuredClone(current.report) as any
  delete malformed.perSplit
  write(join(f.committedRoot, 'reports', current.batchKey, 'report.json'), malformed)
  await expect(runReportVerb(f.session, {}, { baseline: true, fromCommitted: current.batchKey, seedPolicy: 'none' }))
    .rejects.toThrow('report label metadata incomplete or malformed')
})

it('copies guarded calibration once into the report and discloses unknown staged ownership', async () => {
  const f = await fixture()
  const calibration = calibrateLabels({ snapshot: readCommittedCorpus(f.committedRoot).snapshot, marks: [] })
  const body = { ...calibration, schemaVersion: LABEL_CALIBRATION_SCHEMA_VERSION, evidenceDigest: sha256hex('fixture'), targetRevisions: [] }
  write(join(f.committedRoot, 'labels/calibration.json'), { ...body, generationId: sha256hex(canonicalJson(body)) })
  const { report } = await runReportVerb(f.session, {}, { source: 'committed' })
  expect(report.calibration).toEqual({ status: 'uncalibrated', n_gold: 0,
    verifierFalsePassRate: { numerator: 0, denominator: 0 } })
  cpSync(join(f.committedRoot, 'cassettes'), join(f.agentQaRoot, 'eval/cassettes'), { recursive: true })
  const staged = await runReportVerb(f.session)
  expect(staged.report.calibration).toEqual(report.calibration)
  expect(staged.report.perSplit.unassignedCount).toBe(3)
  expect(staged.notices.some(line => line.includes('split ownership unknown'))).toBe(true)
  write(join(f.committedRoot, 'labels/calibration.json'), { invalid: true })
  const invalid = await runReportVerb(f.session)
  expect(invalid.notices.some(line => line.includes('invalid label calibration artifact'))).toBe(true)
})

it.each([undefined, 0])('distinguishes persisted recovery weight %s from legacy fallback', async value => {
  const f = await fixture()
  const read = readCommittedCorpus(f.committedRoot)
  const [positive, negative] = [...read.snapshot.labelsById.values()]
  for (const [record, partner, relation] of [[positive!, negative!, 'contrastive-positive'],
    [negative!, positive!, 'contrastive-negative']] as const) {
    const product = read.snapshot.entries.find(entry => entry.cassetteId === record.cassetteId)!.product
    const revised = { ...record, label: { ...record.label, sourceChannel: 'self-heal-pair',
      tier: 'near-gold', pairing: { relation, pairedCassetteId: partner.cassetteId } },
      pairState: { sameState: true, screenStateHash: 'a'.repeat(64), pairedScreenStateHash: 'a'.repeat(64) },
      ...(value === undefined ? {} : { weight: weight(value) }) }
    write(join(f.committedRoot, committedLabelPath(product, record.cassetteId)), revised)
  }
  expect(readCommittedCorpus(f.committedRoot).refusals).toEqual([])
  const { report } = await runReportVerb(f.session, {}, { source: 'committed' })
  expect(report.recovery.eligiblePositiveCount).toBe(1)
  expect(report.recovery.weightSum).toBe(value === undefined ? 2 / 3 : 0)
  expect(report.recovery.pairsWithoutWeight).toBe(value === undefined ? 1 : 0)
})
