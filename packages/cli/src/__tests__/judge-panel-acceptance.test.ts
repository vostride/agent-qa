import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Command } from 'commander'
import * as core from '@vostride/agent-qa-eval'
import * as local from '@vostride/agent-qa-eval-local'
import * as llm from '../llm-utils.js'
import { FsEvidenceArtifactStore } from '@vostride/agent-qa-runner-local'
import {
  MARK_RECEIPT_SCHEMA_VERSION,
  asRunId,
  sha256hex,
  slugBranch,
  type MarkReceipt,
} from '@vostride/agent-qa-schema'
const { makeLocalV2Handoff, LOCAL_FIXTURE_BLOB_BYTES } = await import(new URL('../../../eval-local/src/__tests__/fixtures/local-handoff-fixture.js', import.meta.url).href)
const { capturingStub, judgeGenerateResult } = await import(new URL('../../../eval-local/src/__tests__/fixtures/replay-fixtures.js', import.meta.url).href)
const { actionGenerateResult } = await import(new URL('../../../eval-local/src/__tests__/fixtures/replay-fixtures.js', import.meta.url).href)
const { writeCommittedFloorFixture } = await import(new URL('../../../eval-local/src/__tests__/fixtures/floor-fixtures.js', import.meta.url).href)
import { files as filesUnder } from '../gates/__tests__/feedback-fixture.js'
import { runJudgeCalibrateVerb, resolveEvalSession } from '../eval-session-composition.js'

const boundary = vi.hoisted(() => ({ calls: 0, binds: 0, comparisons: 0, masks: [] as ((text: string) => string)[],
  overrides: {} as import('@vostride/agent-qa-model').ModelProviderOverrides }))
vi.mock('@vostride/agent-qa-model', async original => {
  const actual = await original<typeof import('@vostride/agent-qa-model')>()
  return { ...actual, createModel: (...args: Parameters<typeof actual.createModel>) => {
    boundary.binds++
    boundary.masks.push(args[2])
    return actual.createModel(args[0], args[1], args[2], boundary.overrides, args[4])
  } }
})
vi.mock('@vostride/agent-qa-eval', async original => {
  const actual = await original<typeof import('@vostride/agent-qa-eval')>()
  return { ...actual, adjudicatePanelComparison: (...args: Parameters<typeof actual.adjudicatePanelComparison>) => {
    boundary.comparisons++
    return actual.adjudicatePanelComparison(...args)
  } }
})
const NO_DECLARED_SECRETS = (text: string) => text
const roots: string[] = []
const secret = 'fixture-judge-secret-42111'
const digest = (value: unknown) => sha256hex(core.canonicalJson(value))
const bytes = (root: string) => filesUnder(root).map(path => [path, readFileSync(path).toString('hex')])
beforeEach(() => {
  boundary.calls = boundary.binds = boundary.comparisons = 0
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('network forbidden') })
  vi.spyOn(llm, 'resolveModelAuth').mockImplementation(async name => ({ kind: 'api-key', credentialKey: name, provider: 'openai-compatible', apiKey: secret }))
})
afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled()
  vi.restoreAllMocks(); process.exitCode = 0
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(models: core.CassetteModelReceipt[] = [{}], members = ['claude-sonnet-4', 'gemini-2.5']) {
  const project = mkdtempSync(join(tmpdir(), 'judge-operator-')); roots.push(project)
  const configPath = join(project, 'agent-qa.config.yaml')
  writeFileSync(join(project, 'fixture.secrets'), `JUDGE_KEY=${secret}\n`)
  writeFileSync(configPath, JSON.stringify({ workspace: { testMatch: ['tests/*.yaml'], suiteMatch: ['suites/*.yaml'], hooksFile: 'hooks.yaml', envFile: '.env', secretsFile: 'fixture.secrets' },
    registry: { llms: ['gpt-5', ...members].map((model, i) => ({ name: `model${i}`, provider: 'openai-compatible', model, baseURL: 'http://127.0.0.1:1/v1', vision: false })) },
    use: { llm: 'model0', mobile: { appState: 'preserve' } }, eval: { judges: members.map((_, i) => `model${i + 1}`) } }))
  const rows = models.map((model, index) => addEvidence(project, index, model, members))
  if (rows.length > 0) {
    const historical = readFileSync(new URL('../../../../test-fixtures/eval-workspace/agent-qa-eval/contracts/judge-config.v1.json', import.meta.url), 'utf8')
    expect(sha256hex(historical)).toBe('106807bef1934ad439eda53929c06a783ae7cab45dde0bebc8d09a528ad60024')
    writeFileSync(join(project, 'agent-qa-eval/contracts/judge-config.v1.json'), historical)
  }
  for (const row of rows) {
    row.report.runIdentity!.corpusDigest = core.computeCorpusDigest(local.readActiveCommittedCorpus(row.committedRoot, row.root).snapshot.entries)
    row.saveReport()
  }
  const stubs = members.map(model => capturingStub(() => {
    expect(boundary.masks.at(-1)!(secret)).toBe('[secret:JUDGE_KEY]')
    boundary.calls++; return judgeGenerateResult('equivalent', 'high')
  }, model))
  boundary.overrides = { languageModels: Object.assign({}, ...stubs.map(stub => stub.languageModels)) }
  return { project, configPath, rows, stubs, committedRoot: join(project, 'agent-qa-eval') }
}

async function invoke(configPath: string, args: string[], json = true) {
  const program = new Command('agent-qa').option('--config <path>').addCommand(createEvalCommand()).exitOverride()
  vi.mocked(console.log).mockClear(); vi.mocked(console.error).mockClear(); process.exitCode = 0
  await program.parseAsync(['--config', configPath, 'eval', ...args, ...(json ? ['--json'] : [])], { from: 'user' })
  const stdout = vi.mocked(console.log).mock.calls.map(row => row.join(' ')).join('\n')
  return { stdout, result: json ? JSON.parse(stdout) : undefined, exit: process.exitCode }
}


import { createEvalCommand } from '../commands/eval.js'

// The replay, calibrate and drift cells drive whole eval commands in process (n=20 is 80 stubbed
// judge calls, then a report read). Nothing in them waits on a condition, so the budget is a hang
// ceiling: under load these cells outrun the 30 s package default.
const JUDGE_DRIVE_TIMEOUT_MS = 120_000

it.each([false, true])('public explicit replay, score/report, floor, baseline and saved gate: singleton=%s', async singleton => {
  const f = fixture([], singleton ? ['claude-sonnet-4'] : undefined)
  const corpus = writeCommittedFloorFixture(join(f.project, 'floor-input'), (handoff: import('@vostride/agent-qa-schema').CompletedRunHandoff) => {
    for (const step of handoff.tests[0]!.steps) {
      step.modelProfile!.modelId = 'gpt-5'
      for (const action of step.subActions) action.callRecord!.resolvedModelId = 'gpt-5'
    }
  })
  cpSync(corpus.committedRoot, f.committedRoot, { recursive: true })
  const config = JSON.parse(readFileSync(f.configPath, 'utf8')); config.eval.seed = 17
  writeFileSync(f.configPath, JSON.stringify(config))
  const planner = capturingStub(() => actionGenerateResult(), 'gpt-5')
  boundary.overrides = { languageModels: { ...boundary.overrides.languageModels, ...planner.languageModels } }
  const cold = await invoke(f.configPath, ['gate'])
  expect(cold.exit).toBe(2)
  const replay = await invoke(f.configPath, ['replay', '--source', 'committed', '--judge', 'model1', ...(singleton ? [] : ['--judge', 'model2'])])
  expect(replay.exit).toBe(0); expect(replay.result.replayed).toBeGreaterThan(0); expect(replay.result.scored).toBeGreaterThan(0)
  const report = await invoke(f.configPath, ['report', '--source', 'committed', '--commit', '--baseline'])
  expect(report.exit).toBe(0); expect(report.result.committed.kind).toBe('committed')
  if (singleton) expect(report.result.report.judge).not.toHaveProperty('panelSize')
  else expect(report.result.report.judge.panelSize).toBe(2)
  const floor = await invoke(f.configPath, ['floor', '--commit', '--explanation', 'Deterministic fake fixture measurement'])
  expect(floor.exit).toBe(0)
  expect(floor.result.committed.kind).toBe('written')
  const beforeCalls = planner.captured.length
  const saved = await invoke(f.configPath, ['gate', '--report', report.result.report.batchKey])
  expect(saved.exit).toBe(0)
  expect(saved.result).toMatchObject({ kind: 'verdict', modelCalls: 0 })
  expect(planner.captured).toHaveLength(beforeCalls)
}, JUDGE_DRIVE_TIMEOUT_MS)
it('public report refuses a mixed panel and singleton baseline without rewriting either score', async () => {
  const f = fixture([{}, {}]), row = f.rows[1]!, judge = core.createPanelIdentity(['claude-sonnet-4'])
  const record = { ...row.record, judge, scoringContext: core.createScoringContext({ cassette: row.cassette,
    outcome: row.outcome, labelRecord: row.labelRecord, score: row.record.score, judge,
    judgeRequest: { judgeModelId: judge.judgeModelId, allowSameFamily: false } }) }
  new local.FsScoreStore({ root: row.root, outputDir: row.replaysRoot }).save(record)
  stageReports(f)
  const before = f.rows.map(item => readFileSync(item.scoreFile, 'utf8'))
  const output = await invoke(f.configPath, ['report', '--source', 'committed', '--commit', '--baseline'])
  expect(output.result.report.judgeIdentity).toBe('mixed')
  expect(output.result.report).not.toHaveProperty('judge')
  expect(core.assertBaselineComparator(output.result.report)).toMatchObject({ ok: false, refusal: { kind: 'mixed-judge-identity' } })
  expect(f.rows.map(item => readFileSync(item.scoreFile, 'utf8'))).toEqual(before)
  expect(boundary).toMatchObject({ calls: 0, binds: 0, comparisons: 0 })
})
function stageReports(f: ReturnType<typeof fixture>, proveProfile = false) {
  for (const [i, row] of f.rows.entries()) cpSync(row.replaysRoot, join(f.project, '.agent-qa/eval/replays', String(i)), { recursive: true })
  if (proveProfile) {
    const first = f.rows[0]!
    const config = JSON.parse(readFileSync(f.configPath, 'utf8')); config.eval.seed = 17
    writeFileSync(f.configPath, JSON.stringify(config))
    const report = core.buildEvalReport(f.rows.map(row => ({ cassetteId: row.cassette.id,
      outcome: row.outcome, score: row.record.score })), first.record.judge)
    report.runIdentity = first.report.runIdentity
    new local.FsReportStore({ root: first.root }).save(report, undefined, { seed: 17,
      records: f.rows.map(row => ({ cassetteId: row.cassette.id,
        replayDigest: digest(JSON.parse(readFileSync(row.written.file, 'utf8'))),
        scoreDigest: digest(JSON.parse(readFileSync(row.scoreFile, 'utf8'))) })) })
  }
}
it.each([19, 20])('public calibrate/commit/read/report copies independent fake n=%s', async n => {
  const f = fixture(Array.from({ length: n }, () => ({})))
  const before = bytes(f.committedRoot)
  const output = await invoke(f.configPath, ['calibrate', '--judge-panel', '--commit', '--min-n', '20'])
  expect(output.exit).toBe(0)
  const artifact = output.result.artifact
  expect(artifact).toMatchObject({ status: n === 20 ? 'calibrated' : 'uncalibrated', n, minN: 20, minNSource: 'flag',
    counts: { selected: n, truthComparable: n, attempted: n }, cost: { usage: { calls: n * 4 } } })
  expect(boundary.calls).toBe(n * 4)
  expect(new Set(f.rows.map(row => row.cassette.id)).size).toBe(n)
  expect(local.readJudgeCalibration({ ...f.rows[0]!.input, identity: artifact.identity })).toEqual({ kind: 'loaded', artifact })
  stageReports(f, true)
  boundary.calls = boundary.binds = boundary.comparisons = 0
  const reported = await invoke(f.configPath, ['report', '--source', 'committed'])
  expect(reported.exit).toBe(0)
  expect(reported.result.report.judge.calibration).toMatchObject({ status: artifact.status, n })
  if (n === 20) {
    expect(reported.result.report.judge.calibration.pooledAgreement).toBe(artifact.pooledAgreement)
    expect(reported.result.report.judge.calibration.wilson95).toEqual(artifact.wilson95)
  }
  expect(boundary).toMatchObject({ calls: 0, binds: 0, comparisons: 0 })
  for (const [path, content] of before) expect(readFileSync(path!).toString('hex')).toBe(content)
}, JUDGE_DRIVE_TIMEOUT_MS)
it.each(['profile', 'gold', 'corpus'])('public saved calibration is unavailable after actual %s drift', async drift => {
  const f = fixture([{}, {}])
  const saved = await invoke(f.configPath, ['calibrate', '--judge-panel', '--commit', '--min-n', '2'])
  expect(saved.result.artifact.status).toBe('calibrated')
  const artifactPath = join(f.committedRoot, saved.result.path), original = readFileSync(artifactPath, 'utf8')
  stageReports(f)
  if (drift === 'profile') {
    const config = JSON.parse(readFileSync(f.configPath, 'utf8')); config.registry.llms[0].model = 'gpt-changed'
    writeFileSync(f.configPath, JSON.stringify(config))
  } else if (drift === 'gold') {
    f.rows[0]!.marks[0]!.ordinal++
    f.rows[0]!.saveMarks()
  } else {
    const entry = local.readActiveCommittedCorpus(f.committedRoot, join(f.project, '.agent-qa')).snapshot.entries[0]!
    writeFileSync(join(f.committedRoot, local.committedCorpusPath(entry.product, entry.cassetteId)), '{invalid')
  }
  boundary.calls = boundary.binds = boundary.comparisons = 0
  const reported = await invoke(f.configPath, ['report', '--source', 'committed'])
  expect(reported.result.report.judge.calibration).toEqual({ status: 'uncalibrated', n: 0, provenance: 'unavailable' })
  expect(readFileSync(artifactPath, 'utf8')).toBe(original)
  expect(boundary).toMatchObject({ calls: 0, binds: 0, comparisons: 0 })
}, JUDGE_DRIVE_TIMEOUT_MS)
it.each(['panel-not-configured', 'no-credential', 'single-family-host'])('public preview discloses zero-call %s', async reason => {
  const f = fixture()
  const config = JSON.parse(readFileSync(f.configPath, 'utf8'))
  if (reason === 'panel-not-configured') config.eval = {}
  if (reason === 'single-family-host') config.registry.llms[2].model = 'gpt-judge'
  writeFileSync(f.configPath, JSON.stringify(config))
  if (reason === 'no-credential') vi.mocked(llm.resolveModelAuth).mockImplementation(async name => ({ kind: 'missing', credentialKey: name, provider: 'openai-compatible', required: true, message: secret }))
  const before = bytes(f.committedRoot)
  const json = await invoke(f.configPath, ['calibrate', '--judge-panel'])
  expect(json.exit).toBe(0); expect(json.result).toMatchObject({ status: 'capability-gap', reason })
  const human = await invoke(f.configPath, ['calibrate', '--judge-panel'], false)
  expect(human.exit).toBe(0); expect(human.stdout).toContain(reason)
  expect(boundary).toMatchObject({ calls: 0, binds: 0, comparisons: 0 })
  expect(bytes(f.committedRoot)).toEqual(before)
  expect(json.stdout + human.stdout).not.toContain(secret)
})

function addEvidence(project: string, index: number, model: core.CassetteModelReceipt, members: readonly string[]) {
  const root = join(project, '.agent-qa')
  const committedRoot = join(project, 'agent-qa-eval')
  const handoff = makeLocalV2Handoff({ runId: asRunId(`judge-calibration-local-${index}`), scope: { tier: 'product', key: 'shop' } })
  handoff.tests[0]!.steps = [handoff.tests[0]!.steps[0]!]
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
  const mark: MarkReceipt = { schemaVersion: MARK_RECEIPT_SCHEMA_VERSION, markId: 'mark_abcdef012345', runId: handoff.runId,
    runSlug: core.deriveRunSlug(handoff.runId), testIndex: 0, stepIndex: 0, kind: 'confirmed-bug', origin: 'user', ordinal: 1,
    markedAt: 0, disposition: { kind: 'confirmed-bug', confirmedRecords: 0 }, gold: [], evidence: { confirmed: 0, overturned: 0 } }
  const frozen = core.buildGoldenTrajectoryPlan({ handoff, cassettes, mark, product: 'shop' })
  const freeze = local.seedCommittedCorpus({ plan: { ...plan, cases: frozen.cases }, cassettes: frozen.goldCassettes, committedRoot,
    mask: NO_DECLARED_SECRETS })
  if (freeze.refusals.length) throw new Error('Fixture gold refused')
  mark.gold = frozen.cases.map(row => ({ cassetteId: row.cassetteId, sourceCassetteId: source.id, channel: 'user-mark' }))
  const marks = [mark]
  const saveMarks = () => writeFileSync(join(run, 'marks.jsonl'), marks.map(value => JSON.stringify(value)).join('\n') + '\n')
  saveMarks()
  const cassette = frozen.goldCassettes[0]!.cassette as core.LeafCassette, labelRecord = frozen.cases[0]!.labelRecord
  const identity = core.computeDecisionIdentity(cassette.sidecar.goldAction, cassette.input.stateBefore.elements)
  const outcome: core.LeafReplayResult = { granularity: 'leaf', cassetteId: cassette.id,
    samples: [{ sampleIndex: 0, durationMs: 1, outcome: { kind: 'decision', action: cassette.sidecar.goldAction, identity } }],
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
  return { root, run, runRoot, replaysRoot, committedRoot, source, cassette, labelRecord, marks, handoff, outcome, record,
    written, scoreFile, report, publication, saveReport, saveMarks, input, read }
}
