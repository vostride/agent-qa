import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as core from '@vostride/agent-qa-eval'
import * as local from '../index.js'
import { FsEvidenceArtifactStore } from '@vostride/agent-qa-runner-local'
import {
  MARK_RECEIPT_SCHEMA_VERSION,
  asRunId,
  asRef,
  sha256hex,
  slugBranch,
} from '@vostride/agent-qa-schema'
import { SecretRedactor, SecretStore } from '@vostride/agent-qa-runner'
import { runJudgePanelCalibration, runJudgeCalibration } from '../judge-calibration-composition.js'
import * as publication from '../judge-calibration-source.js'
import { makeLocalV2Handoff, LOCAL_FIXTURE_BLOB_BYTES } from './fixtures/local-handoff-fixture.js'
import { capturingStub, judgeGenerateResult } from './fixtures/replay-fixtures.js'

const NO_DECLARED_SECRETS = (text: string) => text
const binds = vi.hoisted(() => ({ count: 0, fail: false }))
const redactor = new SecretRedactor(SecretStore.fromEnvContent('JUDGE_API_KEY=fixture-private-api-key'))
vi.mock('../judge-binding.js', async original => {
  const actual = await original<typeof import('../judge-binding.js')>()
  return { ...actual, bindJudgePanel: (...args: Parameters<typeof actual.bindJudgePanel>) => {
    binds.count++
    for (const member of args[0]) expect(member.mask('fixture-private-api-key')).toBe('[secret:JUDGE_API_KEY]')
    if (binds.fail) throw new Error('fixture-private-binding-error')
    return actual.bindJudgePanel(...args)
  } }
})
const roots: string[] = []
const digest = (value: unknown) => sha256hex(core.canonicalJson(value))
afterEach(() => { binds.count = 0; binds.fail = false; vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture(models: core.CassetteModelReceipt[] = [{}], verdicts: ('equivalent' | 'different' | 'error' | 'unsure')[] = ['equivalent', 'equivalent'], ambiguous = false, excluded: readonly number[] = [], stepText?: string) {
  const project = mkdtempSync(join(tmpdir(), 'judge-probe-')); roots.push(project)
  const memberIds = ['claude-sonnet-4', 'gemini-2.5', 'llama-3'].slice(0, verdicts.length)
  const rows = models.map((model, index) => addEvidence(project, index, model, memberIds, ambiguous, excluded.includes(index), stepText))
  for (const row of rows) { row.report.runIdentity!.corpusDigest = core.computeCorpusDigest(local.readActiveCommittedCorpus(row.committedRoot, row.root).snapshot.entries); row.saveReport() }
  let calls = 0
  const stubs: ReturnType<typeof capturingStub>[] = []
  const members = memberIds.map((model, index) => {
    const stub = capturingStub(() => {
      calls++
      if (verdicts[index] === 'error') throw new Error('fixture-private-provider-error')
      return judgeGenerateResult(verdicts[index] === 'unsure' ? 'unsure' : verdicts[index]!, 'high')
    }, model)
    stubs.push(stub)
    return { profile: { provider: 'openai-compatible' as const, model, baseURL: 'http://127.0.0.1:1/v1', auth: { mode: 'none' as const } },
      auth: { kind: 'api-key' as const, apiKey: 'fixture-private-api-key' }, modelOverrides: { languageModels: stub.languageModels } }
  })
  const input = { ...rows[0]!.input, members, replayProfile: { provider: 'openai-compatible' as const, model: 'gpt-5', auth: { mode: 'none' as const } },
    mask: (text: string) => redactor.redactString(text) }
  return { input, rows, stubs, calls: () => calls }
}
it('refuses credential-bearing canonical member identity without inventing or binding one', async () => {
  const f = fixture()
  f.input.members[0]!.profile.model = 'claude-sonnet-4/fixture-private-api-key'
  await expect(runJudgePanelCalibration(f.input)).rejects.toThrow('Judge calibration probe failed; retry.')
  expect(binds.count).toBe(0); expect(f.calls()).toBe(0)
})
it('requires an explicit composite at the direct operator boundary', async () => {
  const f = fixture(); f.input.members.pop()
  await expect(runJudgePanelCalibration(f.input)).rejects.toThrow('Judge calibration probe failed')
  expect(binds.count).toBe(0); expect(f.calls()).toBe(0)
})
it('rejects a foreign panel profile before admitting or binding evidence', async () => {
  const f = fixture(); f.input.profile.judgeModelId = 'foreign-panel'
  await expect(runJudgePanelCalibration(f.input)).rejects.toThrow('Judge calibration probe failed')
  expect(binds.count).toBe(0); expect(f.calls()).toBe(0)
})

function committedBytes(root: string): [string, string][] {
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const path = join(root, entry.name)
    return entry.isDirectory() ? committedBytes(path) : [[path, readFileSync(path).toString('hex')]] as [string, string][]
  })
}
it.each([false, true])('bypasses the writer entirely for no-composite gaps with replace=%s', async replace => {
  const f = fixture(), before = committedBytes(f.input.committedRoot)
  const writer = vi.spyOn(publication, 'publishJudgeCalibration')
  const result = await runJudgeCalibration({ kind: 'capability-gap', reason: 'panel-not-configured',
    minN: core.resolveJudgeCalibrationMinimum(), commit: true, replace })
  expect(result).toMatchObject({ kind: 'capability-gap', reason: 'panel-not-configured', artifactDisposition: 'not-created' })
  expect(result).not.toHaveProperty('profileKey'); expect(result).not.toHaveProperty('path'); expect(result).not.toHaveProperty('identity')
  expect(writer).not.toHaveBeenCalled(); expect(binds.count).toBe(0); expect(f.calls()).toBe(0)
  expect(committedBytes(f.input.committedRoot)).toEqual(before)
  expect(existsSync(join(f.input.committedRoot, 'reports/judge-calibration'))).toBe(false)
})

describe('C441-GAP2-JUDGE', () => {

  it('keeps a value raw only at a closed-vocabulary path of its arm, never by a bare key name', () => {
    const declared = new SecretRedactor(SecretStore.fromEnvContent(
      'INSPECT_441=inspect\nCRED_441=credential'))
    const mask = (text: string) => declared.redactString(text)

    const refused = local.maskJudgeCalibrationText({ kind: 'refused', reason:
      'Judge calibration evidence unavailable or invalid; inspect the selected corpus and saved replays.' }, mask)
    expect(refused.kind).toBe('refused')
    expect(refused.reason).toContain('[secret:INSPECT_441]')
    expect(refused.reason).not.toContain('inspect')

    const gap = { kind: 'capability-gap' as const, status: 'capability-gap' as const, reason: 'no-credential' as const,
      minN: 20, minNSource: 'default' as const, n: 0, artifactDisposition: 'not-created' as const,
      cost: { callBound: 0, usage: { calls: 0 } },
      judgeTargeted: { basis: 'raw' as const, source: 'unavailable' as const, reason: 'not-read' as const },
      entries: [{ index: 0, name: 'inspect-judge', families: [], credential: 'resolution-failed' as const,
        failures: ['config-unresolved', 'no-credential'] as const }] }
    const masked = local.maskJudgeCalibrationText(gap, mask)
    expect(masked).toEqual({ ...gap, entries: [{ ...gap.entries[0], name: '[secret:INSPECT_441]-judge' }] })
  })
})

describe('C441-GAP3-JUDGE', () => {
  const shortValueMask = () => {
    const declared = new SecretRedactor(SecretStore.fromEnvContent(
      'JUDGE_API_KEY=fixture-private-api-key\nPIN=0'))
    return (text: string) => declared.redactString(text)
  }

  it('a judge calibration commit under a one-character declared value is committed and returns only masked text', async () => {
    const f = fixture([{}, {}], undefined, false, [1])
    const mask = shortValueMask()
    f.input.mask = mask

    const result = await runJudgeCalibration({ kind: 'probe', probe: f.input, commit: true })

    expect(result.kind).toBe('committed')
    if (result.kind !== 'committed') throw new Error('expected publication')
    expect(local.maskJudgeCalibrationText(result, mask)).toEqual(result)
    const identity = core.createPanelIdentity(f.input.members.map(m => m.profile.model))
    const reread = publication.readJudgeCalibration({ ...f.input, identity })
    expect(reread.kind).toBe('loaded')
    expect(local.maskJudgeCalibrationText(reread, mask)).toEqual({ kind: 'loaded', artifact: result.artifact })
  })

  it('the dry-run preview under the same mask is still masked', async () => {
    const f = fixture([{}, {}], undefined, false, [1])
    const mask = shortValueMask()
    f.input.mask = mask

    const preview = await runJudgeCalibration({ kind: 'probe', probe: f.input })

    expect(preview.kind).toBe('dry-run')
    expect(JSON.stringify(preview)).toContain('[secret:PIN]')
    expect(local.maskJudgeCalibrationText(preview, mask)).toEqual(preview)
  })
})
function addEvidence(project: string, index: number, model: core.CassetteModelReceipt, members: readonly string[], ambiguous = false, excluded = false, stepText?: string) {
  const root = join(project, '.agent-qa')
  const committedRoot = join(project, 'agent-qa-eval')
  const handoff = makeLocalV2Handoff({ runId: asRunId(`judge-calibration-local-${index}`), scope: { tier: 'product', key: 'shop' } })
  handoff.tests[0]!.steps = [handoff.tests[0]!.steps[0]!]
  if (stepText !== undefined) handoff.tests[0]!.steps[0]!.stepText = stepText
  if (ambiguous) for (const sub of handoff.tests[0]!.steps[0]!.subActions) {
    const ref = asRef('e-alternative')
    sub.stateBefore.elements.push({ ...structuredClone(sub.stateBefore.elements[0]!), ref })
    sub.stateBefore.refMap[ref] = structuredClone(sub.stateBefore.refMap[sub.stateBefore.elements[0]!.ref]!)
  }
  for (const sub of handoff.tests[0]!.steps[0]!.subActions) sub.stateBefore.timestamp = 1_725_000_000
  const run = join(root, 'runs', core.deriveRunSlug(handoff.runId)); mkdirSync(run, { recursive: true })
  writeFileSync(join(run, 'handoff.json'), JSON.stringify(handoff))
  new FsEvidenceArtifactStore({ root, runId: handoff.runId }).persistDecisionScreenshot(LOCAL_FIXTURE_BLOB_BYTES)
  const cassettes = core.extractRunCassettes({ handoff, artifacts: new local.FsRunArtifactSource({ root, runId: handoff.runId }) }).cassettes
  const source = cassettes.find(row => row.cassette.granularity === 'leaf')!.cassette as core.LeafCassette
  source.receipt.model = model
  const plan = core.buildSeedingPlan({ handoff, cassettes, partition: { saltHex: 'a'.repeat(64), heldOutFraction: 0.000001, privateFraction: 0.5 } })
  const seeded = local.seedCommittedCorpus({ plan, cassettes, committedRoot, mask: NO_DECLARED_SECRETS })
  if (seeded.refusals.length) throw new Error('Fixture seed refused')
  const mark: core.GoldMark = { schemaVersion: MARK_RECEIPT_SCHEMA_VERSION, markId: 'mark_abcdef012345', runId: handoff.runId,
    runSlug: core.deriveRunSlug(handoff.runId), testIndex: 0, stepIndex: 0, kind: excluded ? 'false-pass' : 'confirmed-bug', origin: 'user', ordinal: 1,
    markedAt: 0, disposition: { kind: 'confirmed-bug', confirmedRecords: 0 }, gold: [], evidence: { confirmed: 0, overturned: 0 } }
  const frozen = core.buildGoldenTrajectoryPlan({ handoff, cassettes, mark, product: 'shop' })
  const freeze = local.seedCommittedCorpus({ plan: { ...plan, cases: frozen.cases }, cassettes: frozen.goldCassettes, committedRoot,
    mask: NO_DECLARED_SECRETS })
  if (freeze.refusals.length) throw new Error('Fixture gold refused')
  const cassette = frozen.goldCassettes[0]!.cassette as core.LeafCassette, labelRecord = frozen.cases[0]!.labelRecord
  const action = ambiguous ? { type: 'click' as const, ref: asRef('e-alternative') } : cassette.sidecar.goldAction
  const identity = core.computeDecisionIdentity(action, cassette.input.stateBefore.elements)
  const outcome: core.LeafReplayResult = { granularity: 'leaf', cassetteId: cassette.id,
    samples: [{ sampleIndex: 0, durationMs: 1, outcome: { kind: 'decision', action, identity } }],
    agreement: { k: 1, agreementRate: 1, noConsensus: false, harnessErrorCount: 0, modal: { identity, count: 1 } },
    modalDecision: identity, promptDrift: core.computeReplayDrift(cassette.input, cassette.receipt.promptInputHash),
    briefSource: 'proof', replayedModel: { provider: 'openai-compatible', modelId: 'gpt-5' }, unconsumedExchanges: [], totalDurationMs: 1 }
  const judge = core.createPanelIdentity(members)
  const score = core.scoreCassetteReplay(cassette, outcome, labelRecord)
  const record: local.ScoreRecord = { cassetteId: cassette.id, matcherVersion: 1, score, judge, diffs: [],
    scoringContext: core.createScoringContext({ cassette, outcome, labelRecord, score, judge, judgeRequest: { judgeModelId: judge.judgeModelId, allowSameFamily: false } }) }
  const profile = { plannerModelId: outcome.replayedModel.modelId, fingerprint: local.computeReplayProfileFingerprintFor({ profile: { provider: 'openai-compatible', model: 'gpt-5', baseURL: 'http://127.0.0.1:1/v1', auth: { mode: 'none' } }, seedPolicy: 'declared' }), matcherVersion: 1, judgeModelId: judge.judgeModelId, judgeVersion: judge.judgeVersion }
  const profileKey = core.composeBaselineProfileKey(profile)
  const runRoot = join(root, 'eval/floor', slugBranch(profileKey), `r${index}-seed17`)
  const replaysRoot = join(runRoot, 'replays')
  const written = new local.FsReplayRecordStore({ root, outputDir: replaysRoot, executionSeed: 17 }).save(outcome)
  const scoreFile = new local.FsScoreStore({ root, outputDir: replaysRoot }).save(record).file
  const report = core.buildEvalReport([{ cassetteId: cassette.id, outcome, score }], judge)
  report.runIdentity = { fingerprint: profile.fingerprint, corpusDigest: core.computeCorpusDigest(local.readActiveCommittedCorpus(committedRoot, root).snapshot.entries) }
  const saveReport = () => new local.FsReportStore({ root, outputDir: join(runRoot, 'reports') }).save(report, undefined, {
    seed: 17, records: [{ cassetteId: cassette.id, replayDigest: digest(JSON.parse(readFileSync(written.file, 'utf8'))), scoreDigest: digest(JSON.parse(readFileSync(scoreFile, 'utf8'))) }],
  })
  const publication = saveReport()
  const input = { agentQaRoot: root, committedRoot, profile }
  const read = (overrides = {}) => Reflect.get(local, 'loadJudgeCalibrationEvidence')?.({ ...input, ...overrides })
  return { root, run, runRoot, replaysRoot, committedRoot, source, cassette, labelRecord, handoff, outcome, record,
    written, scoreFile, report, publication, saveReport, input, read }
}
