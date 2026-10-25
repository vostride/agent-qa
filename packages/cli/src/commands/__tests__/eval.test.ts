// Phase 372-05 — the eval command family's first verb: extract (D-01), sweep-by-default with the
// D-02 filter vocabulary, typed per-run skips (never batch errors), D-04 DTO-faithful rendering,
// and D-08 exit semantics. Task 1 pins runExtractVerb; Task 2 pins the commander wiring.
// Phase 372-06 adds the replay verb: sweep staged cassette bundles through runCassetteReplay with
// the session's seeded masking factory (D-06), the D-03 judge bag and typed refusal counters.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Command } from 'commander'
import { APICallError } from 'ai'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile, appendFile, rename } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { generateRunId, generateTestId } from '@vostride/agent-qa-ids'
import {
  assignSplit,
  BASELINE_POINTER_SCHEMA_VERSION,
  JUDGE_CONFIG,
  buildEvalReport,
  canonicalJson,
  committedFileText,
  composeBaselineProfileKey,
  computeBatchKey,
  computeCorpusDigest,
  countGateSet,
  deriveCensus,
  foldClassifierRepeatability,
  CAMPAIGN_MANIFEST_SCHEMA_VERSION,
  DECISION_VECTORS_SCHEMA_VERSION,
  foldNoiseFloorArtefact,
  guardDecisionVectorsDocument,
  guardNoiseFloorArtefact,
  guardPartitionManifest,
  guardRunExclusionRecord,
  partitionParamsOf,
  projectRunExclusion,
} from '@vostride/agent-qa-eval'
import type {
  ClassifierRepeatability,
  CorpusCensus,
  DecisionCorrectnessVector,
  JudgeIdentityBlock,
  LeafCassette,
  SeedPolicy,
} from '@vostride/agent-qa-eval'
import type { createModel, ModelProfile, ModelProviderOverrides } from '@vostride/agent-qa-model'
import {
  FsEvidenceArtifactStore,
  FsHandoffStore,
  HANDOFF_FILE,
  RUNS_SUBDIR,
  slugBranch,
} from '@vostride/agent-qa-runner-local'
import {
  CURRENT_HANDOFF_SCHEMA_VERSION,
  asRef,
  asRunId,
  computeBriefDigest,
  distilledScreenStateDigest,
  CURRENT_ANALYSIS_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import type {
  ArtifactRef,
  CompletedRunHandoff,
  MemberTestOutcome,
  RunAnalysisArtifact,
  ScopeKey,
  ScreenState,
  ServedBrief,
  StepEvidence,
  Verdict,
} from '@vostride/agent-qa-schema'
import {
  FsReplayRecordStore,
  FsReportStore,
  commitEvalReport,
  committedCassettePath,
  committedLabelPath,
  computeReplayProfileFingerprintFor,
  loadStagedReport,
  loadCassetteBundle,
  FsScoreStore,
  runCassetteReplay,
  readCommittedCorpus,
  resolveBaselineCache,
  runReplayGate,
  COMMITTED_ROOT_SCHEMA_VERSION,
} from '@vostride/agent-qa-eval-local'
import { LOCAL_CURATION_CAPABILITIES } from '@vostride/agent-qa-agent-local'
import { appendGateReceipt } from '@vostride/agent-qa-knowledge-local'
import {
  EvalNamedInputError,
  EvalPartitionFlagsRequiredError,
  EvalPartitionManifestConflictError,
  resolveEvalSession,
  resolveReplayProfileFingerprint,
  resolveReplayPlanner,
  resolveTargetEnvironmentForProduct,
  runExtractVerb,
  runReplayVerb,
  runCensusVerb,
  runReportVerb,
  runSeedVerb,
} from '../../eval-session-composition.js'
import type {
  CensusVerbResult,
  EvalSession,
  ExtractVerbResult,
  ReplayVerbResult,
  ReportVerbResult,
  SeedVerbResult,
} from '../../eval-session-composition.js'
import { renderCensusMarkdown } from '../../eval-census-render.js'
import { createEvalCommand } from '../eval.js'
import * as evalVerbs from '../../eval-session-composition.js'
import * as evalRender from '../../eval-report-render.js'

/** Three real seeded leaves, using generated persistent identities and only provider stubs. */
async function floorVerbFixture(judged = false) {
  const plannerModelId = 'gpt-floor-stub'
  const judgeModelId = 'claude-floor-stub'
  const { dir, configPath } = await writeReplayFixture('', plannerModelId)
  if (judged) {
    const config = await readFile(configPath, 'utf8')
    await writeFile(configPath, config.replace('use:\n', [
      '    - name: judge', '      provider: openai-compatible',
      `      model: ${judgeModelId}`, '      baseURL: http://localhost:9999/v1', 'use:', '',
    ].join('\n')) + 'eval:\n  judge: judge\n')
  }
  const root = join(dir, '.agent-qa')
  for (let index = 0; index < 3; index++) {
    const runId = generateRunId()
    const screenshotRef = new FsEvidenceArtifactStore({ root, runId })
      .persistDecisionScreenshot(BLOB_BYTES)
    const handoff = buildHandoff({ runId, screenshotRef })
    handoff.tests[0]!.testId = generateTestId()
    const step = handoff.tests[0]!.steps[0]!
    step.modelProfile!.modelId = 'gemini-recorded-fixture'
    const sub = step.subActions[0]!
    sub.stateBefore = { ...sub.stateBefore, timestamp: 1_725_000_000 }
    if (judged) {
      sub.plannedAction = { type: 'fill', ref: buttonRef, text: 'hello world foo',
        clearMode: 'replace', submit: false }
    }
    new FsHandoffStore({ root, runId }).save(handoff)
  }
  const session = await sessionFor(configPath)
  const seeded = await runSeedVerb(session, {}, TEST_FRACTIONS)
  expect(seeded.seededCount).toBe(3)
  const planner = replayStub(plannerModelId, judged ? () => ({
    ...clickGenerateResult(),
    content: [{ type: 'tool-call', toolCallId: 'fill-action', toolName: 'web_fill',
      input: JSON.stringify({ ref: 'e-continue', text: 'hello world bar', reasoning: 'fill',
        confidence: 0.95, stepComplete: true, doesActionAdvanceUsTowardsGoal: true }) }],
  }) : clickGenerateResult)
  const judge = replayStub(judgeModelId, () => ({
    ...clickGenerateResult(),
    content: [{ type: 'text', text: JSON.stringify({ verdict: 'equivalent', confidence: 'high',
      rationale: 'The framed values describe equivalent content' }) }],
  }))
  return { dir, configPath, session, planner, judge, plannerModelId, judgeModelId,
    opts: { plannerOverrides: planner.overrides, ...(judged ? { judgeOverrides: judge.overrides } : {}) } }
}

function requireFloorVerb() {
  expect(evalVerbs.runFloorVerb, 'the public floor measurement verb exists').toBeTypeOf('function')
  return evalVerbs.runFloorVerb
}

function requireGateVerb() {
  expect(evalVerbs.runGateVerb, 'the public release gate verb exists').toBeTypeOf('function')
  return evalVerbs.runGateVerb
}

function requireReplayGateVerb() {
  expect(evalVerbs.runReplayGateVerb).toBeTypeOf('function')
  return evalVerbs.runReplayGateVerb
}

describe('417 replay-gate command', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    process.exitCode = 0
  })
  it('exports recorded defaults and registers the candidate argument and options', () => {
    requireReplayGateVerb()
    expect(evalVerbs.GATE1_DEFAULT_MAX_SCREENS).toBe(64)
    expect(evalVerbs.GATE1_DEFAULT_K).toBe(3)
    const verb = createEvalCommand().commands.find((command) => command.name() === 'replay-gate')!
    expect(verb.registeredArguments[0]!.name()).toBe('candidateId')
    expect(verb.options.map((option) => option.long)).toEqual([
      '--k',
      '--max-screens',
      '--judge',
      '--dry-run',
      '--json',
    ])
  })
  it.each([
    { configCap: 40, flagCap: undefined, maxScreens: 40, maxScreensSource: 'config' },
    { configCap: 40, flagCap: 12, maxScreens: 12, maxScreensSource: 'flag' },
    { configCap: undefined, flagCap: undefined, maxScreens: 64, maxScreensSource: 'default' },
  ])(
    'resolves and discloses the $maxScreensSource cap before the bridge',
    async ({ configCap, flagCap, maxScreens, maxScreensSource }) => {
      const { configPath } = await writeReplayFixture('')
      if (configCap !== undefined)
        await appendFile(configPath, `\neval:\n  gate1:\n    maxScreens: ${configCap}\n`)
      const session = await sessionFor(configPath)
      const host = await import('../../gates/replay-gate-host.js')
      const captured: Parameters<typeof host.createReplayGateHost>[0][] = []
      vi.spyOn(host, 'createReplayGateHost').mockImplementation((deps) => {
        captured.push(deps)
        return {
          port: {
            runReplayGate: async () => {
              throw new Error('unused port')
            },
          },
          run: async () => ({
            kind: 'refused',
            refusal: { path: 'fixture', reason: 'fixture boundary' },
            notices: [],
            exit: 2,
          }),
        }
      })
      const result = await requireReplayGateVerb()(session, 'candidate', { maxScreens: flagCap })
      expect(captured[0]?.composition.maxScreens).toBe(maxScreens)
      expect(result).toMatchObject({ maxScreens, maxScreensSource, k: 3, kSource: 'default' })
      expect(result.notices).toContain(`cap: maxScreens=${maxScreens} (${maxScreensSource})`)
    },
  )
  it('rejects max-screens zero before resolving a session or bridge', async () => {
    await expect(
      requireReplayGateVerb()({ evalConfig: {} } as EvalSession, 'candidate', { maxScreens: 0 }),
    ).rejects.toThrow('--max-screens must be a positive integer')
  })
  it.each([
    { configured: 7, flag: 5, k: 5, kSource: 'flag' },
    { configured: 7, flag: undefined, k: 7, kSource: 'config' },
    { configured: undefined, flag: undefined, k: 3, kSource: 'default' },
  ])(
    'resolves the cross-check k ladder from $kSource',
    async ({ configured, flag, k, kSource }) => {
      const { configPath } = await writeReplayFixture('')
      if (configured !== undefined) await appendFile(configPath, `\neval:\n  k: ${configured}\n`)
      const session = await sessionFor(configPath)
      const host = await import('../../gates/replay-gate-host.js')
      const captured: Parameters<typeof host.createReplayGateHost>[0][] = []
      vi.spyOn(host, 'createReplayGateHost').mockImplementation((deps) => {
        captured.push(deps)
        return {
          port: {
            runReplayGate: async () => {
              throw new Error('unused port')
            },
          },
          run: async () => ({
            kind: 'refused',
            refusal: { path: 'fixture', reason: 'boundary' },
            notices: [],
            exit: 2,
          }),
        }
      })
      const result = await requireReplayGateVerb()(session, 'candidate', { k: flag })
      expect(captured[0]?.composition).toMatchObject({ k, kSource })
      expect(result).toMatchObject({ k, kSource })
    },
  )
  it.each([1, 2, 4, 3.5, NaN])('rejects invalid Gate-1 k=%s before composition', async (k) => {
    await expect(
      requireReplayGateVerb()({ evalConfig: {} } as EvalSession, 'candidate', { k }),
    ).rejects.toThrow('--k must be an odd integer of at least 3')
  })
  it.each(['1', '2', '4'])('the actual replay-gate command exits 2 for --k %s', async (k) => {
    const { configPath } = await writeReplayFixture('')
    const session = await sessionFor(configPath)
    vi.spyOn(evalVerbs, 'resolveEvalSession').mockResolvedValue(session)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const host = await import('../../gates/replay-gate-host.js')
    const compose = vi.spyOn(host, 'createReplayGateHost')
    await createEvalCommand().parseAsync(['replay-gate', 'candidate', '--k', k], { from: 'user' })
    expect(process.exitCode).toBe(2)
    expect(error.mock.calls.flat().join(' ')).toContain('--k must be an odd integer of at least 3')
    expect(compose).not.toHaveBeenCalled()
  })
  it('rejects fractional --k before it can be truncated to an odd integer', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const session = vi.spyOn(evalVerbs, 'resolveEvalSession')
    await createEvalCommand().parseAsync(['replay-gate', 'candidate', '--k', '3.5'], {
      from: 'user',
    })
    expect(process.exitCode).toBe(2)
    expect(error.mock.calls.flat().join(' ')).toContain('--k')
    expect(session).not.toHaveBeenCalled()
  })
  it('selects --judge by name but never forwards the configured same-family override', async () => {
    const { configPath } = await writeReplayFixture('', 'gpt-fixture')
    const config = await readFile(configPath, 'utf8')
    await writeFile(
      configPath,
      config.replace(
        'use:\n',
        [
          '    - name: selected-judge',
          '      provider: openai-compatible',
          '      model: gpt-judge',
          '      baseURL: http://localhost:9999/v1',
          'use:',
          '',
        ].join('\n'),
      ) + 'eval:\n  judgeAllowSameFamily: true\n',
    )
    const host = await import('../../gates/replay-gate-host.js')
    const captured: Parameters<typeof host.createReplayGateHost>[0][] = []
    vi.spyOn(host, 'createReplayGateHost').mockImplementation((deps) => {
      captured.push(deps)
      return {
        port: {
          runReplayGate: async () => {
            throw new Error('unused port')
          },
        },
        run: async () => ({
          kind: 'refused',
          refusal: { path: 'fixture', reason: 'boundary' },
          notices: [],
          exit: 2,
        }),
      }
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await new Command()
      .option('--config <path>')
      .addCommand(createEvalCommand())
      .parseAsync(
        ['--config', configPath, 'eval', 'replay-gate', 'candidate', '--judge', 'selected-judge'],
        { from: 'user' },
      )
    expect(captured).toHaveLength(1)
    const input = captured[0]!.composition
    expect(input.judge?.profile.model).toBe('gpt-judge')
    expect('allowSameFamily' in input.judge!).toBe(false)
    expect(input.judgeOverrideConfigured).toBe(true)
    expect(input.baselineWarmup).toEqual({ configPath, judge: 'selected-judge' })
  })
  it('keeps ordinary eval replay k=1 valid', async () => {
    const fixture = await floorVerbFixture()
    fixture.session.evalConfig.k = 1
    const result = await runReplayVerb(
      fixture.session,
      {},
      { source: 'committed', ...fixture.opts },
    )
    expect(result.replayed).toBe(3)
    expect(result.spend.sampleCount).toBe(3)
    expect(fixture.planner.captured).toHaveLength(3)
  })
  it.each(['refused'] as const)('never emits %s content on JSON stdout', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(evalVerbs, 'resolveEvalSession').mockResolvedValue({} as EvalSession)
    vi.spyOn(evalVerbs, 'runReplayGateVerb').mockResolvedValue({
      maxScreens: 64,
      maxScreensSource: 'default',
      k: 3,
      kSource: 'default',
      kind: 'refused',
      refusal: { path: '/missing', reason: 'no-floor' },
      notices: [],
      exit: 2,
    })
    await createEvalCommand().parseAsync(['replay-gate', 'candidate', '--json'], { from: 'user' })
    expect(log).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(2)
  })
})

async function gateVerbFixture(judged = false, seeds = [11, 29]) {
  const fixture = await floorVerbFixture(judged)
  const floor = await evalVerbs.runFloorVerb(fixture.session, {
    ...fixture.opts,
    seeds,
    commit: true,
    explanation: 'measured CLI fixture',
  })
  expect(floor.committed?.kind).toBe('written')
  fixture.session.evalConfig.seed = 11
  const replay = await runReplayVerb(fixture.session, {}, { ...fixture.opts, source: 'committed' })
  expect(replay.replayed).toBe(3)
  const report = await runReportVerb(
    fixture.session,
    {},
    {
      source: 'committed',
      commit: true,
      baseline: true,
      plannerOverrides: fixture.opts.plannerOverrides,
    },
  )
  expect(report.committed?.kind).toBe('committed')
  expect(report.baseline?.kind).toBe('written')
  delete fixture.session.evalConfig.seed
  fixture.planner.captured.length = 0
  fixture.judge.captured.length = 0
  return { ...fixture, floor, report }
}

describe('runGateVerb — fresh and offline release verdicts', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(1_725_000_000)
    vi.spyOn(performance, 'now').mockReturnValue(10)
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network forbidden in gate fixture'))
  })
  afterEach(() => vi.restoreAllMocks())

  it('follows the advertised cold-cache producer command and resolves its actual seeded records', async () => {
    // Runtime fixture imports keep peer package source outside this package's TS rootDir.
    const gateFixturePath = resolve(import.meta.dirname, '../../../../eval-local/src/__tests__/fixtures/gate1-fixtures.ts')
    const replayFixturePath = resolve(import.meta.dirname, '../../../../eval-local/src/__tests__/fixtures/replay-fixtures.ts')
    const { writeGate1Fixture, gate1Responder } = await import(gateFixturePath)
    const { respondingStub, stubProfile, noneAuth } = await import(replayFixturePath)
    const { dir, configPath } = await writeReplayFixture('', stubProfile().model)
    await writeFile(
      configPath,
      (await readFile(configPath, 'utf8')).replace('localhost:9999', 'localhost:1'),
    )
    const f = writeGate1Fixture(dir)
    const committedRoot = join(dir, 'agent-qa-eval')
    await rename(f.committedRoot, committedRoot)
    const planner = respondingStub(gate1Responder(f))
    const overrides = { languageModels: planner.languageModels }
    const session = await sessionFor(configPath)
    const identity = await evalVerbs.resolveGateProfileIdentity(session, overrides)
    expect(identity).toEqual(f.identity)
    const cold = await runReplayGate({
      injection: f.injection,
      committedRoot,
      agentQaRoot: f.agentQaRoot,
      identity,
      mask: (text: string) => text,
      planner: {
        profile: stubProfile(),
        resolveAuth: async () => noneAuth,
        modelOverrides: overrides,
      },
      judgeOverrideConfigured: false,
      k: 3,
      kSource: 'default',
      maxScreens: 64,
      baselineSeed: { seed: 29, source: 'config' },
      baselineWarmup: { configPath },
      producedBy: { opId: 'eval.replay-gate' },
    })
    expect(cold.kind).toBe('receipt')
    if (cold.kind !== 'receipt') throw new Error(JSON.stringify(cold))
    expect(cold.receipt.reasons).toEqual(['baseline-uncached'])
    expect(planner.captured).toHaveLength(0)
    expect(cold.notices.join('\n')).toContain('spends planner and configured judge calls')
    const command = cold.lines.find((line) => line.startsWith('agent-qa '))!
    // Parse the actual advertised arguments (the fixture path has no embedded quotes).
    const argv = command
      .match(/'[^']*'|\S+/g)!
      .slice(1)
      .map((arg) => (arg.startsWith("'") ? arg.slice(1, -1) : arg))
    const actualGate = evalVerbs.runGateVerb
    vi.spyOn(evalVerbs, 'runGateVerb').mockImplementation((resolved, opts) =>
      actualGate(resolved, { ...opts, plannerOverrides: overrides }),
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await new Command()
      .option('--config <path>')
      .addCommand(createEvalCommand())
      .parseAsync(argv, { from: 'user' })
    expect(planner.captured).toHaveLength(6)
    expect(planner.captured.every((call: CapturedCallOptions) => call.seed === 29)).toBe(true)
    const cache = resolveBaselineCache({
      agentQaRoot: f.agentQaRoot,
      ...identity,
      gateRootSeed: 11,
      gateRootSeedSource: 'config',
      cassettes: f.selected.map(({ cassette }: { cassette: LeafCassette }) => ({
        id: cassette.id,
        promptInputHash: cassette.receipt.promptInputHash,
      })),
    })
    expect(
      cache.rows.every(
        (row) => row.kind === 'cached' && row.seed === 29 && row.seedSource === 'run-publication',
      ),
    ).toBe(true)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('shares one override fingerprint across floor, designated pointer and the fresh exit-0 gate', async () => {
    const runGateVerb = requireGateVerb()
    const fixture = await gateVerbFixture()
    const committedBefore = await snapshotTree(join(fixture.dir, 'agent-qa-eval'))
    const result = await runGateVerb(fixture.session, fixture.opts)
    expect(result.kind).toBe('verdict')
    if (result.kind !== 'verdict') throw new Error('expected comparable fixture')
    expect(result.verdict.exit).toBe(0)
    expect(result.verdict.pairing.n).toBe(3)
    expect(result.profileKey).toBe(fixture.floor.profileKey)
    expect(result.profileKey).toBe(fixture.report.profileKey)
    expect(result.fingerprint).toBe(fixture.floor.fingerprint)
    expect(result.fingerprint).toBe(await resolveReplayProfileFingerprint(
      fixture.session, 'declared', fixture.opts.plannerOverrides,
    ))
    expect(result.fingerprint).not.toBe(await resolveReplayProfileFingerprint(fixture.session, 'declared'))
    expect(result.currentReportFile).toContain(`/eval/gate/${slugBranch(result.profileKey)}/reports/`)
    expect(result).toMatchObject({ mode: 'fresh', seed: 11, seedSource: 'floor', modelCalls: 3, wallClockMs: 0 })
    expect(fixture.planner.captured).toHaveLength(3)
    expect(await snapshotTree(join(fixture.dir, 'agent-qa-eval'))).toEqual(committedBefore)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('resolves seed flag > config > profile floor > recorded default without changing the profile key', async () => {
    const runGateVerb = requireGateVerb()
    const fixture = await gateVerbFixture(false, [17, 31])
    fixture.session.evalConfig.seed = 23
    const flag = await runGateVerb(fixture.session, { ...fixture.opts, seed: 0 })
    expect(flag).toMatchObject({ seed: 0, seedSource: 'flag', profileKey: fixture.floor.profileKey })
    const config = await runGateVerb(fixture.session, fixture.opts)
    expect(config).toMatchObject({ seed: 23, seedSource: 'config' })
    delete fixture.session.evalConfig.seed
    expect(await runGateVerb(fixture.session, fixture.opts)).toMatchObject({ seed: 17, seedSource: 'floor' })
    const other = await floorVerbFixture()
    expect(await runGateVerb(other.session, other.opts)).toMatchObject({
      seed: 11, seedSource: 'default', verdict: { exit: 2 },
    })
  })

  it('returns exit 1 for a real paired regression and preserves the unchanged comparator reasons', async () => {
    const runGateVerb = requireGateVerb()
    const fixture = await gateVerbFixture()
    const regressing = replayStub(fixture.plannerModelId, () => ({
      ...clickGenerateResult(),
      content: [{ type: 'tool-call', toolCallId: 'wrong-action', toolName: 'web_fill',
        input: JSON.stringify({ ref: 'e-continue', text: 'different operation', reasoning: 'fill',
          confidence: 0.95, stepComplete: true, doesActionAdvanceUsTowardsGoal: true }) }],
    }))
    const result = await runGateVerb(fixture.session, { plannerOverrides: regressing.overrides })
    expect(result.kind).toBe('verdict')
    if (result.kind !== 'verdict') throw new Error('expected regression verdict')
    expect(result.verdict.exit).toBe(1)
    expect(result.verdict.pairing.n).toBe(3)
    expect(result.verdict.regressions.length).toBeGreaterThan(0)
    const offline = await runGateVerb(fixture.session, { plannerOverrides: regressing.overrides,
      report: result.currentReport.batchKey })
    expect(offline).toMatchObject({ kind: 'verdict', modelCalls: 0, verdict: result.verdict })
    expect(regressing.captured).toHaveLength(3)
  })

  it('prefers the gate root over a stale default-staging-root report with the same batchKey', async () => {
    const runGateVerb = requireGateVerb()
    const fixture = await gateVerbFixture()
    const fresh = await runGateVerb(fixture.session, fixture.opts)
    if (fresh.kind !== 'verdict') throw new Error('expected fresh verdict')
    const agentQaRoot = join(fixture.dir, '.agent-qa')
    const staleReport = { ...fresh.currentReport }
    delete staleReport.runIdentity
    const stale = new FsReportStore({ root: agentQaRoot }).save(staleReport)
    fixture.planner.captured.length = 0
    const read = await runGateVerb(fixture.session, { ...fixture.opts, report: fresh.currentReport.batchKey })
    expect(read).toMatchObject({ kind: 'verdict', currentReportFile: fresh.currentReportFile,
      modelCalls: 0, verdict: fresh.verdict, probedDirs: [dirname(fresh.currentReportFile)] })
    expect(read.notices).toContain(`gate --report: reading ${fresh.currentReportFile} (gate root)`)
    const explicit = await runGateVerb(fixture.session, { ...fixture.opts,
      report: fresh.currentReport.batchKey, stagedDir: dirname(stale.file) })
    expect(explicit.kind).toBe('verdict')
    if (explicit.kind !== 'verdict') throw new Error('expected historical inconclusive verdict')
    expect(explicit.currentReportFile).toBe(stale.file)
    expect(explicit.probedDirs).toEqual([dirname(stale.file)])
    expect(explicit.verdict.exit).toBe(2)
    expect(explicit.verdict.pairing.n).toBe(0)
    expect(explicit.verdict.inconclusive).toEqual([
      expect.objectContaining({ reason: 'no-decision-vector', detail: expect.stringMatching(/^current:/) }),
    ])
    expect(explicit.notices.join('\n')).toContain('no decisions sidecar')
    expect(fixture.planner.captured).toHaveLength(0)
  })

  it('resolves an exact relative --staged-dir against configDir and falls back only on absent gate data', async () => {
    const runGateVerb = requireGateVerb()
    const fixture = await gateVerbFixture()
    const fresh = await runGateVerb(fixture.session, fixture.opts)
    if (fresh.kind !== 'verdict') throw new Error('expected fresh verdict')
    const report = fresh.currentReport.batchKey
    const gateDir = dirname(fresh.currentReportFile)
    const read = await runGateVerb(fixture.session, { ...fixture.opts, report,
      stagedDir: relative(fixture.dir, gateDir) })
    expect(read).toMatchObject({ kind: 'verdict', currentReportFile: fresh.currentReportFile, verdict: fresh.verdict })
    if (read.kind !== 'verdict') throw new Error('expected offline verdict')
    expect(isAbsolute(read.currentReportFile)).toBe(true)
    expect(read.probedDirs.every(isAbsolute)).toBe(true)
    const loaded = loadStagedReport(join(fixture.dir, '.agent-qa'), report, gateDir)
    if (loaded.kind !== 'loaded') throw new Error('expected staged evidence')
    const fallback = new FsReportStore({ root: join(fixture.dir, '.agent-qa') })
      .save(loaded.report, loaded.decisions)
    await rm(fresh.currentReportFile)
    const defaultRead = await runGateVerb(fixture.session, { ...fixture.opts, report })
    expect(defaultRead).toMatchObject({ kind: 'verdict', currentReportFile: fallback.file,
      verdict: fresh.verdict, modelCalls: 0, probedDirs: [gateDir, dirname(fallback.file)] })
    expect(defaultRead.notices).toContain(`gate --report: reading ${fallback.file} (default staging root)`)
  })

  it.each(['report', 'decisions', 'identity'] as const)(
    'does not replace a refused preferred %s with valid default-root evidence', async corruption => {
      const runGateVerb = requireGateVerb()
      const fixture = await gateVerbFixture()
      const fresh = await runGateVerb(fixture.session, fixture.opts)
      if (fresh.kind !== 'verdict') throw new Error('expected fresh verdict')
      const report = fresh.currentReport.batchKey
      const root = join(fixture.dir, '.agent-qa')
      const loaded = loadStagedReport(root, report, dirname(fresh.currentReportFile))
      if (loaded.kind !== 'loaded') throw new Error('expected staged evidence')
      new FsReportStore({ root }).save(loaded.report, loaded.decisions)
      const path = corruption === 'decisions'
        ? fresh.currentReportFile.replace(/\.json$/, '.decisions.json') : fresh.currentReportFile
      const changed = { ...fresh.currentReport }
      delete changed.runIdentity
      await writeFile(path, corruption === 'identity' ? JSON.stringify(changed) : '{broken')
      fixture.planner.captured.length = 0
      const result = await runGateVerb(fixture.session, { ...fixture.opts, report })
      expect(result).toMatchObject({ kind: 'refused', refusal: { path },
        probedDirs: [dirname(fresh.currentReportFile)] })
      expect(fixture.planner.captured).toHaveLength(0)
    },
  )

  it('names every missing probe and never leaves an explicit staged directory', async () => {
    const runGateVerb = requireGateVerb()
    const fixture = await floorVerbFixture()
    const report = computeBatchKey([])
    const result = await runGateVerb(fixture.session, { ...fixture.opts, report })
    expect(result.kind).toBe('refused')
    if (result.kind !== 'refused') throw new Error('expected missing report refusal')
    expect(result.probedDirs).toHaveLength(2)
    for (const dir of result.probedDirs) expect(result.refusal.reason).toContain(join(dir, `${report}.json`))
    const explicit = await runGateVerb(fixture.session, { ...fixture.opts, report, stagedDir: 'chosen' })
    expect(explicit).toMatchObject({ kind: 'refused', probedDirs: [join(fixture.dir, 'chosen')],
      refusal: { path: join(fixture.dir, 'chosen', `${report}.json`) } })
    expect(fixture.planner.captured).toHaveLength(0)
  })

  it('forwards fresh judge overrides and reads configured-judge evidence with auth/model creation forbidden', async () => {
    const runGateVerb = requireGateVerb()
    const fixture = await gateVerbFixture(true)
    const fresh = await runGateVerb(fixture.session, fixture.opts)
    expect(fresh).toMatchObject({ kind: 'verdict', modelCalls: 9, verdict: { exit: 0 } })
    if (fresh.kind !== 'verdict') throw new Error('expected judged gate')
    expect(fixture.planner.captured).toHaveLength(3)
    expect(fixture.judge.captured).toHaveLength(6)
    expect(fresh.currentReport.judge?.judgeModelId).toBe(fixture.judgeModelId)
    expect(fresh.profileKey).toBe(fixture.floor.profileKey)
    expect(fresh.profileKey).toBe(fixture.report.profileKey)
    const auth = vi.spyOn(await import('../../llm-utils.js'), 'resolveModelAuth')
      .mockRejectedValue(new Error('credential resolution forbidden'))
    const model = vi.spyOn(await import('@vostride/agent-qa-model'), 'createModel')
      .mockImplementation(() => { throw new Error('model creation forbidden') })
    const offline = await runGateVerb(fixture.session, { ...fixture.opts, report: fresh.currentReport.batchKey })
    expect(offline).toMatchObject({ kind: 'verdict', modelCalls: 0, wallClockMs: 0,
      verdict: fresh.verdict, currentReport: fresh.currentReport })
    expect(auth).not.toHaveBeenCalled()
    expect(model).not.toHaveBeenCalled()
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('rejects --staged-dir without --report before model resolution', async () => {
    const runGateVerb = requireGateVerb()
    const fixture = await floorVerbFixture()
    const auth = vi.spyOn(await import('../../llm-utils.js'), 'resolveModelAuth')
    await expect(runGateVerb(fixture.session, { stagedDir: 'somewhere' })).rejects.toThrow('--report')
    expect(auth).not.toHaveBeenCalled()
  })

  it('sets command exits from 0/1/2 verdict DTOs, prints ordered lines, and keeps JSON one document', async () => {
    const runGateVerb = requireGateVerb()
    const fixture = await gateVerbFixture()
    const result = await runGateVerb(fixture.session, fixture.opts)
    if (result.kind !== 'verdict') throw new Error('expected fresh result')
    const output = captureConsole()
    const mocked = vi.spyOn(evalVerbs, 'runGateVerb')
    for (const exit of [0, 1, 2] as const) {
      const dto = { ...result, verdict: { ...result.verdict, exit } }
      mocked.mockResolvedValue(dto)
      output.logs.length = 0
      const command = new Command().option('--config <path>').addCommand(createEvalCommand())
      await command.parseAsync(['--config', fixture.configPath, 'eval', 'gate', '--json'], { from: 'user' })
      expect(process.exitCode).toBe(exit)
      expect(output.logs).toHaveLength(1)
      expect(JSON.parse(output.logs[0]!)).toEqual(JSON.parse(JSON.stringify(dto)))
    }
    output.logs.length = 0
    mocked.mockResolvedValue(result)
    const program = new Command().option('--config <path>').addCommand(createEvalCommand())
    await program.parseAsync(['--config', fixture.configPath, 'eval', 'gate'], { from: 'user' })
    expect(output.logs).toEqual(result.lines)
    const gate = program.commands[0]!.commands.find(command => command.name() === 'gate')!
    expect(gate.options.map(option => option.long)).toEqual(expect.arrayContaining([
      '--report', '--staged-dir', '--seed', '--judge', '--json',
    ]))
  })

  it('maps refused reads and thrown session/config or flag errors to command exit 2', async () => {
    const runGateVerb = requireGateVerb()
    const fixture = await floorVerbFixture()
    const output = captureConsole()
    vi.spyOn(evalVerbs, 'runGateVerb').mockImplementation((session, opts) =>
      runGateVerb(session, { ...opts, ...fixture.opts }))
    const parse = (args: string[]) => new Command().option('--config <path>').addCommand(createEvalCommand())
      .parseAsync(['--config', fixture.configPath, 'eval', 'gate', ...args], { from: 'user' })
    await parse(['--report', computeBatchKey([]), '--json'])
    expect(process.exitCode).toBe(2)
    expect(JSON.parse(output.logs[0]!)).toMatchObject({ kind: 'refused' })
    output.logs.length = 0
    await parse(['--seed', 'NaN'])
    expect(process.exitCode).toBe(2)
    expect(output.logs).toHaveLength(0)
    expect(output.errors.join('\n')).toContain('release-gate: inconclusive')
    const yaml = await readFile(fixture.configPath, 'utf8')
    await writeFile(fixture.configPath, yaml.replace('  llm: planner\n', ''))
    await parse([])
    expect(process.exitCode).toBe(2)
    expect(output.errors.join('\n')).toContain('use.llm')
  })
})

describe('runFloorVerb — recorded protocol and write-once measurement', () => {
  beforeEach(() => {
    // Freeze only clocks: real IO and async scheduling still execute.
    vi.spyOn(Date, 'now').mockReturnValue(1_725_000_000)
    vi.spyOn(performance, 'now').mockReturnValue(10)
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network forbidden in floor fixture'))
  })
  afterEach(() => vi.restoreAllMocks())

  it.each([false, true])('recovers saved floor runs with auth and model creation forbidden (judge=%s)', async judged => {
    const runFloorVerb = requireFloorVerb()
    const fixture = await floorVerbFixture(judged)
    const fresh = await runFloorVerb(fixture.session, fixture.opts)
    await writeFile(join(fixture.dir, 'original-floor.log'), fresh.costLines.join('\n'))
    const auth = vi.spyOn(await import('../../llm-utils.js'), 'resolveModelAuth')
      .mockRejectedValue(new Error('credential resolution forbidden'))
    const model = vi.spyOn(await import('@vostride/agent-qa-model'), 'createModel')
      .mockImplementation(() => { throw new Error('model creation forbidden') })
    const recovered = await runFloorVerb(fixture.session, { ...fixture.opts,
      fromMeasured: 'original-floor.log', commit: true })
    expect(recovered.artefact).toEqual(fresh.artefact)
    expect(recovered.costLines).toEqual(fresh.costLines)
    expect(recovered.committed?.kind).toBe('written')
    expect(recovered.recovery).toEqual({ costLog: join(fixture.dir, 'original-floor.log'), modelCalls: 0 })
    expect(auth).not.toHaveBeenCalled()
    expect(model).not.toHaveBeenCalled()
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('records defaults, four actual cost lines, axis denominators and product census', async () => {
    const runFloorVerb = requireFloorVerb()
    const fixture = await floorVerbFixture()
    const progress = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const result = await runFloorVerb(fixture.session, fixture.opts)
    expect(result).toMatchObject({ repeats: 3, seeds: [11, 29], bootstrapSeed: 7,
      recordedDefaults: true, corpusDigest: result.artefact.corpusDigest })
    expect(result.artefact.profileKey).toBe(result.profileKey)
    expect(result.fingerprint).toBe(await resolveReplayProfileFingerprint(
      fixture.session, 'declared', fixture.opts.plannerOverrides,
    ))
    expect(result.artefact.axes.headline.n).toBe(3)
    expect(result.artefact.runs.map(run => run.seed)).toEqual([11, 11, 11, 29])
    expect(fixture.planner.captured).toHaveLength(12)
    expect(result.artefact.cost.modelCalls).toBe(12)
    expect(result.costLines).toHaveLength(4)
    expect(result.costLines.every(line => /^floor r\d+ seed=\d+:/.test(line))).toBe(true)
    expect(result.costLines[0]).toContain('modelCalls=3 promptTokens=30 completionTokens=6')
    expect(progress.mock.calls).toHaveLength(16)
    for (const root of result.runRoots) expect(existsSync(join(root, 'reports'))).toBe(true)
    const lines = evalRender.renderFloorSummary(result)
    expect(lines[0]).toBe('eval floor: repeats=3 seeds=11,29 bootstrapSeed=7 (recorded defaults)')
    expect(lines).toContainEqual(expect.stringMatching(/^headline: floor=.+ n=3 sameSeed=0 twoSeed=0 wilson=/))
    expect(lines).toContainEqual(expect.stringMatching(/^default: minimumGateSet=\d+ natural=\d+ heldOut=\d+$/))
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it.each([{ repeats: 2 }, { seeds: [11] }, { seeds: [11, 11] }, { repeats: 3.5 }])(
    'refuses protocol %j before planner or credential resolution', async options => {
      const runFloorVerb = requireFloorVerb()
      const { configPath } = await writeReplayFixture()
      const session = await sessionFor(configPath)
      const llmUtils = await import('../../llm-utils.js')
      const resolution = vi.spyOn(llmUtils, 'resolveNamedConfig').mockRejectedValue(new Error('resolution forbidden'))
      await expect(runFloorVerb(session, options)).rejects.toMatchObject({ code: 'FLOOR_PROTOCOL_MINIMUM' })
      expect(resolution).not.toHaveBeenCalled()
    },
  )

  it('guards the config-relative classifier file before auth and copies its measured block', async () => {
    const runFloorVerb = requireFloorVerb()
    const fixture = await floorVerbFixture()
    const path = join(fixture.dir, 'classifier.json')
    await writeFile(path, '{broken')
    const llmUtils = await import('../../llm-utils.js')
    const auth = vi.spyOn(llmUtils, 'resolveModelAuth')
    await expect(runFloorVerb(fixture.session, { ...fixture.opts,
      classifierRepeatability: 'classifier.json' })).rejects.toThrow(path)
    expect(auth).not.toHaveBeenCalled()
    await writeFile(path, JSON.stringify({ schemaVersion: 1 }))
    await expect(runFloorVerb(fixture.session, { ...fixture.opts,
      classifierRepeatability: path })).rejects.toBeInstanceOf(TypeError)
    const measured = classifierDisclosureFixture()
    await writeFile(path, JSON.stringify(measured))
    const result = await runFloorVerb(fixture.session, { ...fixture.opts,
      classifierRepeatability: path, seeds: [17, 31], repeats: 4, bootstrapSeed: 5 })
    expect(result.artefact.classifierRepeatability).toEqual(measured)
    expect(result).toMatchObject({ seeds: [17, 31], repeats: 4, bootstrapSeed: 5, recordedDefaults: false })
    expect(result.costLines).toHaveLength(5)
  })

  it('commits written then unchanged, preserving a differing measurement as write-conflict data', async () => {
    const runFloorVerb = requireFloorVerb()
    const fixture = await floorVerbFixture()
    const opts = { ...fixture.opts, commit: true, explanation: 'measured fixture protocol' }
    const first = await runFloorVerb(fixture.session, opts)
    expect(first.committed?.kind).toBe('written')
    const second = await runFloorVerb(fixture.session, opts)
    expect(second.committed?.kind).toBe('unchanged')
    expect(second.artefact).toEqual(first.artefact)
    const conflict = await runFloorVerb(fixture.session, { ...opts, explanation: 'different operator explanation' })
    expect(conflict.committed?.kind).toBe('write-conflict')
    expect(evalRender.renderFloorSummary(conflict)).toContainEqual(expect.stringContaining('committed: write-conflict'))
  })

  it('preserves zero-floor refusal without explanation and renders it as a notice', async () => {
    const runFloorVerb = requireFloorVerb()
    const fixture = await floorVerbFixture()
    const local = await import('@vostride/agent-qa-eval-local')
    const measure = local.runNoiseFloorMeasurement
    // Finite nonempty Wilson samples have positive width. Inject only the zero-floor fold
    // boundary here; the real writer still decides refusal/explanation/unchanged outcomes.
    vi.spyOn(local, 'runNoiseFloorMeasurement').mockImplementation(async input => {
      const result = await measure({ ...input, commit: false })
      result.artefact.axes.headline.aggregateFloor = 0
      return { ...result, committed: local.writeNoiseFloorArtefact({ artefact: result.artefact,
        committedRoot: input.committedRoot }) }
    })
    const refused = await runFloorVerb(fixture.session, { ...fixture.opts, commit: true })
    expect(refused.committed).toMatchObject({ kind: 'refused', refusal: { kind: 'zero-floor-without-explanation' } })
    expect(refused.notices).toContainEqual(expect.stringContaining('zero-floor-without-explanation'))
    const explained = { ...fixture.opts, commit: true, explanation: 'operator-supplied zero-floor rationale' }
    expect((await runFloorVerb(fixture.session, explained)).committed?.kind).toBe('written')
    expect((await runFloorVerb(fixture.session, explained)).committed?.kind).toBe('unchanged')
  })

  it('forwards judge overrides through the real stack and counts every planner and judge call', async () => {
    const runFloorVerb = requireFloorVerb()
    const fixture = await floorVerbFixture(true)
    const result = await runFloorVerb(fixture.session, fixture.opts)
    expect(fixture.planner.captured).toHaveLength(12)
    expect(fixture.judge.captured).toHaveLength(24)
    expect(result.artefact.cost.modelCalls).toBe(36)
    expect(result.artefact.judgeModelId).toBe(fixture.judgeModelId)
    expect(result.costLines[0]).toContain('modelCalls=9 promptTokens=90 completionTokens=18')
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('registers floor flags and emits exactly one JSON DTO with progress on stderr', async () => {
    const runFloorVerb = requireFloorVerb()
    const fixture = await floorVerbFixture()
    vi.spyOn(evalVerbs, 'runFloorVerb').mockImplementation((session, opts) =>
      runFloorVerb(session, { ...opts, ...fixture.opts }))
    const output = captureConsole()
    const program = new Command().option('--config <path>').addCommand(createEvalCommand())
    const floor = program.commands[0]!.commands.find(command => command.name() === 'floor')
    expect(floor?.options.map(option => option.long)).toEqual(expect.arrayContaining([
      '--repeats', '--seeds', '--bootstrap-seed', '--commit', '--explanation', '--classifier-repeatability', '--from-measured', '--json',
    ]))
    await program.parseAsync(['--config', fixture.configPath, 'eval', 'floor', '--json'], { from: 'user' })
    expect(output.logs).toHaveLength(1)
    expect(JSON.parse(output.logs[0]!)).toMatchObject({ recordedDefaults: true, repeats: 3 })
    expect(output.errors.join('\n')).toContain('no judge configured')
  })
})

const BLOB_BYTES = Uint8Array.from(Buffer.from('agent-qa eval extract fixture blob\n', 'utf8'))
const SUITE_SCOPE: ScopeKey = { tier: 'suite', key: 'eval-cli' }

// 414 D-07 — a TEST fixture value, not a plan-authored production default; production has no
// default and every fresh test root is its own first partition.
const TEST_FRACTIONS = { heldOutFraction: 0.5, privateFraction: 0.5 } as const

let tmpRoot: string
let savedXdgDataHome: string | undefined
let savedExitCode: number | string | undefined

const CONFIG_YAML = [
  'workspace:',
  '  testMatch: ["tests/**/*.yaml"]',
  '  suiteMatch: ["suites/**/*.suite.yaml"]',
  '  hooksFile: hooks.yaml',
  '  envFile: .env',
  '  secretsFile: .env.secrets.local',
  'registry:',
  '  llms:',
  '    - name: planner',
  '      provider: openai-compatible',
  '      model: gpt-4o',
  '      baseURL: https://api.openai.com/v1',
  'use:',
  '  mobile:',
  '    appState: preserve',
  '  llm: planner',
  '',
].join('\n')

async function writeFixture(): Promise<{ dir: string; configPath: string }> {
  const dir = await mkdtemp(join(tmpRoot, 'fixture-'))
  const configPath = join(dir, 'agent-qa.config.yaml')
  await writeFile(configPath, CONFIG_YAML)
  await writeFile(join(dir, '.env.secrets.local'), '')
  return { dir, configPath }
}

function emptyBrief(scope: ScopeKey): ServedBrief {
  const unstamped: ServedBrief = {
    scope,
    asOfBuild: 11,
    budget: 0,
    truncation: 'none',
    channel1: [],
    channel2: [],
    channel3: [],
    briefDigest: '',
  }
  return { ...unstamped, briefDigest: computeBriefDigest(unstamped) }
}

const buttonRef = asRef('e-continue')

function screenState(timestamp: number): ScreenState {
  const bounds = { x: 24, y: 32, width: 160, height: 44 }
  const center = { x: 104, y: 54 }
  return {
    platform: 'web',
    tree: 'button Continue',
    elements: [
      {
        ref: buttonRef,
        role: 'button',
        name: 'Continue',
        nameNormalized: 'continue',
        bounds,
        center,
        state: { enabled: true, focused: false, visible: true, clickable: true },
        labels: { ariaLabel: 'Continue' },
        attributes: { 'data-fixture': 'continue' },
      },
    ],
    refMap: {
      [buttonRef]: { bounds, center, scrollContext: { offsetX: 0, offsetY: 0 } },
    } as ScreenState['refMap'],
    url: 'https://example.test/checkout',
    timestamp,
    metadata: {
      captureMode: 'full',
      coordSpace: 'viewport',
      viewportWidth: 1_280,
      viewportHeight: 720,
      imageWidth: 1_280,
      imageHeight: 720,
      scroll: { offsetX: 0, offsetY: 0, contentWidth: 1_280, contentHeight: 720 },
    },
  }
}

function step(input: {
  stepIndex: number
  scope: ScopeKey
  live: boolean
  screenshotRef?: ArtifactRef
  stepText?: string
}): StepEvidence {
  return {
    stepIndex: input.stepIndex,
    stepText: input.stepText ?? (input.live ? 'Click Continue' : 'Replay Continue from cache'),
    cacheStatus: input.live ? 'miss' : 'hit',
    servedBrief: emptyBrief(input.scope),
    modelProfile: {
      provider: 'openai-compatible',
      modelId: 'eval-cli-fixture-planner',
      vision: true,
      maxOutputTokens: 512,
      sampling: { temperature: 0 },
    },
    toolSchemaDigest: 'c'.repeat(64),
    subActions: [
      {
        plan: input.live ? 'Use the recorded Continue button' : 'Use the cached Continue decision',
        plannedAction: { type: 'click', ref: buttonRef },
        stateBefore: screenState(1_725_000_000_100 + input.stepIndex),
        result: {
          success: true,
          annotation: {
            kind: 'point',
            viewport: { width: 1_280, height: 720 },
            point: { x: 104, y: 54, boundingBox: { x: 24, y: 32, width: 160, height: 44 } },
          },
        },
        ...(input.live
          ? {
              exchanges: [],
              ...(input.screenshotRef ? { decisionScreenshotRef: input.screenshotRef } : {}),
              callRecord: {
                resolvedModelId: 'eval-cli-fixture-planner-2026-07-10',
                fingerprint: 'fp_eval_cli_fixture',
                effectiveMaxOutputTokens: 512,
                effectiveSampling: { temperature: 0 },
              },
            }
          : {}),
      },
    ],
    verifierVerdict: { pass: true, reasoning: 'The recorded state advanced' },
    verifierIdentity: { provider: 'openai-compatible', modelId: 'eval-cli-fixture-verifier' },
  }
}

function buildHandoff(input: {
  runId: string
  scope?: ScopeKey
  screenshotRef: ArtifactRef
  withCachedStep?: boolean
  schemaVersion?: number
  stepText?: string
  /** 413-06 D-04: the member outcome the deterministic floor keys its verdict domain off. */
  outcome?: MemberTestOutcome
  /** 413-06 D-04: the persisted deterministic classification (a passed+retry member reads flake). */
  rootCause?: Verdict
}): CompletedRunHandoff {
  const scope = input.scope ?? SUITE_SCOPE
  const steps = [
    step({
      stepIndex: 0,
      scope,
      live: true,
      screenshotRef: input.screenshotRef,
      ...(input.stepText === undefined ? {} : { stepText: input.stepText }),
    }),
    ...(input.withCachedStep ? [step({ stepIndex: 1, scope, live: false })] : []),
  ]
  return {
    schemaVersion: input.schemaVersion ?? CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: asRunId(input.runId),
    scope,
    buildOrdinal: 11,
    executionContext: 'ci',
    aggregateVerdict: input.outcome === 'failed' ? 'failed' : 'passed',
    configDigests: { suiteConfigDigest: 'd'.repeat(64), testConfigDigest: 'e'.repeat(64) },
    startedAt: 1_725_000_000_000,
    endedAt: 1_725_000_001_000,
    tests: [
      {
        testId: 'eval-cli::extract-fixture',
        testName: 'Eval CLI extract fixture',
        filePath: 'eval-cli.spec.yaml',
        testIndex: 0,
        outcome: input.outcome ?? 'passed',
        ...(input.rootCause === undefined ? {} : { rootCause: input.rootCause }),
        steps,
      },
    ],
  }
}

/** Persist the fixture blob + a valid v2 handoff into `<dir>/.agent-qa/runs/<slug(runId)>/`. */
function saveRun(
  dir: string,
  runId: string,
  options: { scope?: ScopeKey; withCachedStep?: boolean; stepText?: string; recordedModelId?: string } = {},
): void {
  const root = join(dir, '.agent-qa')
  const ref = new FsEvidenceArtifactStore({ root, runId }).persistDecisionScreenshot(BLOB_BYTES)
  const handoff = buildHandoff({ runId, screenshotRef: ref, ...options })
  if (options.recordedModelId !== undefined) {
    for (const test of handoff.tests) {
      for (const step of test.steps) {
        if (step.modelProfile !== undefined) step.modelProfile.modelId = options.recordedModelId
      }
    }
  }
  new FsHandoffStore({ root, runId }).save(handoff)
}

async function sessionFor(configPath: string): Promise<EvalSession> {
  return resolveEvalSession({ configPath })
}

/** Recursive file-name → content-sha snapshot of the staged cassettes root. */
async function snapshotTree(root: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {}
  let entries: string[]
  try {
    entries = (await readdir(root, { recursive: true })) as string[]
  } catch {
    return snapshot
  }
  for (const entry of entries) {
    try {
      const bytes = await readFile(join(root, entry))
      snapshot[entry] = createHash('sha256').update(bytes).digest('hex')
    } catch {
      // directories
    }
  }
  return snapshot
}

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'agent-qa-eval-cli-'))
  savedXdgDataHome = process.env.XDG_DATA_HOME
  savedExitCode = process.exitCode ?? undefined
  // Point the auth store at an empty temp location so nothing reads the host auth store.
  process.env.XDG_DATA_HOME = join(tmpRoot, 'xdg-data')
})

afterEach(async () => {
  if (savedXdgDataHome === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = savedXdgDataHome
  process.exitCode = savedExitCode
  await rm(tmpRoot, { recursive: true, force: true })
})

describe('runExtractVerb — sweep-by-default over the sanctioned engines (D-01/D-02)', () => {
  it('sweeps every recorded handoff and writes staged cassette bundles with faithful counters', async () => {
    const { dir, configPath } = await writeFixture()
    saveRun(dir, 'run-alpha')
    saveRun(dir, 'run-beta', { withCachedStep: true })

    const result = await runExtractVerb(await sessionFor(configPath))

    expect(result.runsSwept).toBe(2)
    expect(result.runsSkipped).toEqual([])
    expect(result.runsFiltered).toBe(0)
    // Each run stages one leaf + one procedure cassette; run-beta's cached step is a
    // selection skip counted by the engine's report, never re-derived by the CLI (D-04).
    expect(result.cassettesWritten).toBe(4)
    expect(result.completeness).toEqual({ complete: 4, 'cache-hit': 1 })
    expect(result.cassettesRoot).toBe(resolve(dir, '.agent-qa', 'eval', 'cassettes'))

    const staged = await snapshotTree(result.cassettesRoot)
    const cassetteFiles = Object.keys(staged).filter(name => name.endsWith('cassette.json'))
    expect(cassetteFiles).toHaveLength(4)
  })

  it('surfaces unreadable and pre-366 handoffs as typed skips, never batch errors (D-02)', async () => {
    const { dir, configPath } = await writeFixture()
    saveRun(dir, 'run-alpha')
    saveRun(dir, 'run-beta')

    const corruptDir = join(dir, '.agent-qa', RUNS_SUBDIR, slugBranch('run-corrupt'))
    await mkdir(corruptDir, { recursive: true })
    await writeFile(join(corruptDir, HANDOFF_FILE), 'not json at all')

    const preInstrumentationDir = join(dir, '.agent-qa', RUNS_SUBDIR, slugBranch('run-old'))
    await mkdir(preInstrumentationDir, { recursive: true })
    await writeFile(
      join(preInstrumentationDir, HANDOFF_FILE),
      JSON.stringify({ schemaVersion: 1, runId: 'run-old' }),
    )

    const result = await runExtractVerb(await sessionFor(configPath))

    expect(result.runsSwept).toBe(4)
    expect(result.runsSkipped).toHaveLength(2)
    const skippedSlugs = result.runsSkipped.map(skip => skip.runSlug).sort()
    expect(skippedSlugs).toEqual([slugBranch('run-corrupt'), slugBranch('run-old')].sort())
    for (const skip of result.runsSkipped) {
      expect(skip.reason).toBeTruthy()
    }
    const oldSkip = result.runsSkipped.find(skip => skip.runSlug === slugBranch('run-old'))
    expect(oldSkip?.reason).toContain('schemaVersion')
    // The other runs still extracted — never a batch abort.
    expect(result.cassettesWritten).toBe(4)
  })

  it('narrows to --run and throws the typed named-input error for a missing slug (D-08)', async () => {
    const { dir, configPath } = await writeFixture()
    saveRun(dir, 'run-alpha')
    saveRun(dir, 'run-beta')
    const session = await sessionFor(configPath)

    const narrowed = await runExtractVerb(session, { run: slugBranch('run-alpha') })
    expect(narrowed.runsSwept).toBe(1)
    expect(narrowed.cassettesWritten).toBe(2)

    const missing = runExtractVerb(session, { run: 'no-such-run' })
    await expect(missing).rejects.toBeInstanceOf(EvalNamedInputError)
    await expect(runExtractVerb(session, { run: 'no-such-run' })).rejects.toThrow(/no-such-run/)
    await expect(runExtractVerb(session, { run: 'no-such-run' })).rejects.toThrow(
      new RegExp(RUNS_SUBDIR),
    )
  })

  it('counts product-scope mismatches as filtered, not extracted (D-02)', async () => {
    const { dir, configPath } = await writeFixture()
    saveRun(dir, 'run-shop', { scope: { tier: 'product', key: 'shop' } })
    saveRun(dir, 'run-suite-scoped')

    const result = await runExtractVerb(await sessionFor(configPath), { product: 'shop' })

    expect(result.runsSwept).toBe(2)
    expect(result.runsFiltered).toBe(1)
    expect(result.runsSkipped).toEqual([])
    expect(result.cassettesWritten).toBe(2)
    expect(result.completeness).toEqual({ complete: 2 })
  })

  it('re-sweeps idempotently — identical DTO and identical staged bytes (D-02)', async () => {
    const { dir, configPath } = await writeFixture()
    saveRun(dir, 'run-alpha')
    saveRun(dir, 'run-beta', { withCachedStep: true })
    const session = await sessionFor(configPath)

    const first: ExtractVerbResult = await runExtractVerb(session)
    const firstTree = await snapshotTree(first.cassettesRoot)

    const second = await runExtractVerb(session)
    expect(second).toEqual(first)
    expect(await snapshotTree(second.cassettesRoot)).toEqual(firstTree)
  })
})

// ---- 372-06 Task 1: runReplayVerb — sweep, seeded masking, judge bag (D-02/D-06/D-08) ---------

/** The config-registry model id the captured-boundary stub keys off (createModel passthrough). */
const REPLAY_STUB_MODEL_ID = 'replay-cli-stub'

// A registered fake secret embedded in recorded step text — long enough for the ≥4-char register
// guard, shaped to trip NO guardrail detector (no Bearer prefix, no email).
const FAKE_REPLAY_SECRET = 'raw-fake-replay-secret-9001'

const REPLAY_CONFIG_YAML = [
  'workspace:',
  '  testMatch: ["tests/**/*.yaml"]',
  '  suiteMatch: ["suites/**/*.suite.yaml"]',
  '  hooksFile: hooks.yaml',
  '  envFile: .env',
  '  secretsFile: .env.secrets.local',
  'registry:',
  '  llms:',
  '    - name: planner',
  '      provider: openai-compatible',
  `      model: ${REPLAY_STUB_MODEL_ID}`,
  '      baseURL: http://localhost:9999/v1',
  'use:',
  '  mobile:',
  '    appState: preserve',
  '  llm: planner',
  '',
].join('\n')

async function writeReplayFixture(
  secretsContent = '',
  plannerModelId: string = REPLAY_STUB_MODEL_ID,
): Promise<{ dir: string; configPath: string }> {
  const dir = await mkdtemp(join(tmpRoot, 'replay-fixture-'))
  const configPath = join(dir, 'agent-qa.config.yaml')
  // 413-06: the registry model id is what the D-19 profile key is composed FROM, so a baseline
  // cell swaps it while keeping every other fixture property (localhost baseURL, no credential).
  await writeFile(
    configPath,
    REPLAY_CONFIG_YAML.replace(`model: ${REPLAY_STUB_MODEL_ID}`, `model: ${plannerModelId}`),
  )
  await writeFile(join(dir, '.env.secrets.local'), secretsContent)
  return { dir, configPath }
}

type StubLanguageModel = ReturnType<typeof createModel>
type CapturedCallOptions = Parameters<StubLanguageModel['doGenerate']>[0]
type StubGenerateResult = Awaited<ReturnType<StubLanguageModel['doGenerate']>>

/** A grounded web_click tool-call on the recorded ref — a full-match replay decision. */
function clickGenerateResult(): StubGenerateResult {
  return {
    content: [
      {
        type: 'tool-call',
        toolCallId: 'replay-action',
        toolName: 'web_click',
        input: JSON.stringify({
          ref: 'e-continue',
          reasoning: 'Click the recorded Continue button',
          confidence: 0.95,
          stepComplete: true,
          doesActionAdvanceUsTowardsGoal: true,
        }),
      },
    ],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: {
      inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 2, text: 0, reasoning: 0 },
    },
    warnings: [],
  }
}

/**
 * The captured-boundary stub seam (the replay-composition test recipe): a scripted language model
 * injected through createModel's overrides so every doGenerate params object is captured POST the
 * pinned-last mask/guardrail middleware — the exact provider boundary.
 */
function replayStub(
  modelId: string = REPLAY_STUB_MODEL_ID,
  generate: () => StubGenerateResult = clickGenerateResult,
): { captured: CapturedCallOptions[]; overrides: ModelProviderOverrides } {
  const captured: CapturedCallOptions[] = []
  const stub: StubLanguageModel = {
    specificationVersion: 'v3',
    provider: 'replay-cli-stub-provider',
    modelId,
    supportedUrls: {},
    async doGenerate(params) {
      captured.push(params)
      return generate()
    },
    async doStream() {
      return { stream: new ReadableStream() }
    },
  }
  return { captured, overrides: { languageModels: { [modelId]: stub } } }
}

/** Read every staged cassette id back from the bundle documents, sorted. */
async function stagedCassetteIds(dir: string): Promise<string[]> {
  const root = join(dir, '.agent-qa', 'eval', 'cassettes')
  const entries = (await readdir(root, { recursive: true })) as string[]
  const ids: string[] = []
  for (const entry of entries) {
    if (!entry.endsWith('cassette.json')) continue
    const document = JSON.parse(await readFile(join(root, entry), 'utf-8')) as { id: string }
    ids.push(document.id)
  }
  return ids.sort()
}

/** The slugged replay-record dir FsReplayRecordStore derives for one cassette id. */
function replayDirFor(dir: string, id: string): string {
  return join(dir, '.agent-qa', 'eval', 'replays', ...id.split('/').map(segment => slugBranch(segment)))
}

describe('runReplayVerb — offline sweep through the sanctioned composition (D-02/D-06/D-08)', () => {
  afterEach(() => vi.restoreAllMocks())

  it('reports observed spend, reported usage and supported seed from this invocation only', async () => {
    const fixture = await floorVerbFixture()
    fixture.session.evalConfig.seed = 11
    const clock = vi.spyOn(performance, 'now').mockReturnValue(100)
    const first = await runReplayVerb(fixture.session, {}, { ...fixture.opts, source: 'committed' })
    expect(first.spend).toEqual({
      seed: 11, seedHonored: true, decisions: 3, modelCalls: 3,
      promptTokens: 30, completionTokens: 6, wallClockMs: 0,
      sampleCount: 3, samplesMissingTokenUsage: 0,
      judgeCost: { calls: 0, inputTokens: 0, outputTokens: 0, outcomesMissingUsage: 0 },
    })
    const oneId = (await readCommittedCorpus(join(fixture.dir, 'agent-qa-eval')))
      .snapshot.entries[0]!.cassetteId
    const timed = replayStub(fixture.plannerModelId, () => {
      clock.mockReturnValue(137)
      return clickGenerateResult()
    })
    const second = await runReplayVerb(fixture.session, { cassette: oneId }, {
      source: 'committed', plannerOverrides: timed.overrides,
    })
    expect(second.spend).toMatchObject({ decisions: 1, modelCalls: 1, promptTokens: 10,
      completionTokens: 2, wallClockMs: 37, sampleCount: 1 })
    expect(fixture.planner.captured).toHaveLength(first.spend.modelCalls)
  })

  it('counts provider retries separately from replay samples without inventing retry usage', async () => {
    const fixture = await floorVerbFixture()
    let calls = 0
    const retrying = replayStub(fixture.plannerModelId, () => {
      if (calls++ === 0) throw new APICallError({
        message: 'retry fixture', url: 'http://localhost/fixture', requestBodyValues: {},
        statusCode: 429, isRetryable: true, responseHeaders: { 'retry-after-ms': '0' },
      })
      return clickGenerateResult()
    })
    const result = await runReplayVerb(fixture.session, {}, {
      source: 'committed', plannerOverrides: retrying.overrides,
    })
    expect(result.spend).toMatchObject({ modelCalls: 4, sampleCount: 3, promptTokens: 30,
      completionTokens: 6, samplesMissingTokenUsage: 0, seed: null, seedHonored: null })
    expect(retrying.captured).toHaveLength(result.spend.modelCalls)
  })

  it('retains missing sample usage on provider failures', async () => {
    const fixture = await floorVerbFixture()
    const failing = replayStub(fixture.plannerModelId, () => {
      throw new Error('unreported provider failure')
    })
    const result = await runReplayVerb(fixture.session, {}, {
      source: 'committed', plannerOverrides: failing.overrides,
    })
    expect(result.spend).toMatchObject({ sampleCount: 3, samplesMissingTokenUsage: 3,
      promptTokens: 0, completionTokens: 0 })
    expect(result.spend.modelCalls).toBe(failing.captured.length)
    expect(result.spend.modelCalls).toBeGreaterThanOrEqual(3)
  })

  it('discloses unsupported seed evidence instead of asserting determinism', async () => {
    const fixture = await floorVerbFixture()
    fixture.session.evalConfig.seed = 0
    const failing = replayStub(fixture.plannerModelId, () => {
      return { ...clickGenerateResult(), warnings: [{ type: 'unsupported', feature: 'seed' }] }
    })
    const result = await runReplayVerb(fixture.session, {}, {
      source: 'committed', plannerOverrides: failing.overrides,
    })
    expect(result.spend).toMatchObject({ seed: 0, seedHonored: false, modelCalls: 3,
      sampleCount: 3, samplesMissingTokenUsage: 0, promptTokens: 30, completionTokens: 6 })
  })

  it('includes judge provider calls and reports their token contribution explicitly', async () => {
    const fixture = await floorVerbFixture(true)
    const result = await runReplayVerb(fixture.session, {}, { ...fixture.opts, source: 'committed' })
    // Each ambiguous fixture decision has two adjudicated tie axes.
    expect(result.spend).toMatchObject({ modelCalls: 9, sampleCount: 3, promptTokens: 90,
      completionTokens: 18,
      judgeCost: { calls: 6, inputTokens: 60, outputTokens: 12, outcomesMissingUsage: 0 },
    })
    expect(result.spend.modelCalls).toBe(fixture.planner.captured.length + fixture.judge.captured.length)
  })

  it('returns zero spend for empty committed input without resolving models or credentials', async () => {
    const { configPath } = await writeReplayFixture()
    const session = await sessionFor(configPath)
    delete session.config.use!.llm
    session.evalConfig.judge = 'does-not-exist'
    session.evalConfig.seed = 11
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network forbidden'))
    const result = await runReplayVerb(session, {}, { source: 'committed' })
    expect(result.spend).toMatchObject({ seed: 11, seedHonored: null, decisions: 0,
      modelCalls: 0, promptTokens: 0, completionTokens: 0, sampleCount: 0,
      samplesMissingTokenUsage: 0 })
    expect(result.spend.wallClockMs).toBeGreaterThanOrEqual(0)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('replays every staged bundle, persists replay.json + score.json, and stamps the deterministic batchKey', async () => {
    const { dir, configPath } = await writeReplayFixture()
    saveRun(dir, 'run-alpha')
    const session = await sessionFor(configPath)
    await runExtractVerb(session)
    const ids = await stagedCassetteIds(dir)
    expect(ids).toHaveLength(2)

    const stub = replayStub()
    const result = await runReplayVerb(session, {}, { plannerOverrides: stub.overrides })

    expect(result.swept).toBe(2)
    expect(result.replayed).toBe(2)
    expect(result.loadRefusals).toEqual({})
    expect(result.replayRefusals).toEqual({})
    expect(result.batchKey).toBe(computeBatchKey(ids))
    expect(result.scored).toBe(2)
    expect(result.replaysRoot).toBe(join(dir, '.agent-qa', 'eval', 'replays'))
    for (const id of ids) {
      expect(existsSync(join(replayDirFor(dir, id), 'replay.json'))).toBe(true)
      expect(existsSync(join(replayDirFor(dir, id), 'score.json'))).toBe(true)
    }

    // Idempotent re-run over the same staging: the record store recreates dirs, the score store
    // writes file-scoped — a second sweep is green with the same counters (Pitfall 5).
    const second = await runReplayVerb(session, {}, { plannerOverrides: replayStub().overrides })
    expect(second.replayed).toBe(2)
    expect(second.scored).toBe(2)
    expect(second.batchKey).toBe(result.batchKey)
  })

  it('threads the session-seeded masking factory: a secrets-file value crosses the boundary as a placeholder (D-06)', async () => {
    const { dir, configPath } = await writeReplayFixture(`EVAL_FIXTURE_TOKEN=${FAKE_REPLAY_SECRET}\n`)
    saveRun(dir, 'run-secret', {
      stepText: `Use the token ${FAKE_REPLAY_SECRET} then click Continue`,
    })
    const session = await sessionFor(configPath)
    await runExtractVerb(session)

    const stub = replayStub()
    const result = await runReplayVerb(session, {}, { plannerOverrides: stub.overrides })

    expect(result.replayed).toBe(2)
    expect(stub.captured.length).toBeGreaterThan(0)
    // Captured POST the pinned-last mask middleware: the secrets-file value reaches the provider
    // boundary as its named marker, never as raw bytes — end-to-end proof the CLI passes the
    // session's mask into runCassetteReplay.
    const boundaryPayload = JSON.stringify(stub.captured)
    expect(boundaryPayload).toContain('[secret:EVAL_FIXTURE_TOKEN]')
    expect(boundaryPayload).not.toContain(FAKE_REPLAY_SECRET)
  })

  it('folds a corrupt bundle into loadRefusals by reason and still replays the rest (D-08)', async () => {
    const { dir, configPath } = await writeReplayFixture()
    saveRun(dir, 'run-alpha')
    const session = await sessionFor(configPath)
    await runExtractVerb(session)

    const corruptDir = join(dir, '.agent-qa', 'eval', 'cassettes', 'corrupt-bundle')
    await mkdir(corruptDir, { recursive: true })
    await writeFile(join(corruptDir, 'cassette.json'), 'not json at all')

    const result = await runReplayVerb(session, {}, { plannerOverrides: replayStub().overrides })

    // The refusal is data (never a batch abort): the corrupt dir entered the sweep and folded
    // into loadRefusals by reason while both valid cassettes replayed normally.
    expect(result.swept).toBe(3)
    expect(result.loadRefusals).toEqual({ 'parse-failed': 1 })
    expect(result.replayed).toBe(2)
    expect(result.scored).toBe(2)
  })

  it('applies the ONE filter vocabulary on the loaded set: --cassette, --run, --product (D-02)', async () => {
    const { dir, configPath } = await writeReplayFixture()
    saveRun(dir, 'run-shop', { scope: { tier: 'product', key: 'shop' } })
    saveRun(dir, 'run-plain')
    const session = await sessionFor(configPath)
    await runExtractVerb(session)
    const ids = await stagedCassetteIds(dir)
    expect(ids).toHaveLength(4)
    const shopIds = ids.filter(id => id.startsWith(slugBranch('run-shop')))
    const shopLeafId = shopIds.find(id => id.endsWith('-leaf'))
    if (shopLeafId === undefined) throw new Error('expected a staged run-shop leaf cassette')

    const named = await runReplayVerb(
      session,
      { cassette: shopLeafId },
      { plannerOverrides: replayStub().overrides },
    )
    expect(named.replayed).toBe(1)
    expect(named.batchKey).toBe(computeBatchKey([shopLeafId]))

    await expect(
      runReplayVerb(session, { cassette: 'no-such-cassette' }, { plannerOverrides: replayStub().overrides }),
    ).rejects.toBeInstanceOf(EvalNamedInputError)

    const byRun = await runReplayVerb(
      session,
      { run: 'run-plain' },
      { plannerOverrides: replayStub().overrides },
    )
    expect(byRun.replayed).toBe(2)
    expect(byRun.batchKey).toBe(
      computeBatchKey(ids.filter(id => id.startsWith(slugBranch('run-plain')))),
    )

    await expect(
      runReplayVerb(session, { run: 'no-such-run' }, { plannerOverrides: replayStub().overrides }),
    ).rejects.toBeInstanceOf(EvalNamedInputError)

    const byProduct = await runReplayVerb(
      session,
      { product: 'shop' },
      { plannerOverrides: replayStub().overrides },
    )
    expect(byProduct.replayed).toBe(2)
    expect(byProduct.batchKey).toBe(computeBatchKey(shopIds))
  })

  it('completes without a judge: configured false with the notice riding the DTO (D-03/370)', async () => {
    const { dir, configPath } = await writeReplayFixture()
    saveRun(dir, 'run-alpha')
    const session = await sessionFor(configPath)
    await runExtractVerb(session)

    const result = await runReplayVerb(session, {}, { plannerOverrides: replayStub().overrides })

    // Absence is first-class configuration (370): the batch completes, the judge block is honest
    // zeros, and the no-judge notice is DTO data — any tie would record not-invoked downstream.
    expect(result.replayed).toBe(2)
    expect(result.judge).toEqual({
      configured: false,
      invoked: 0,
      settled: 0,
      abstained: 0,
      errors: 0,
      notInvoked: 0,
    })
    expect(result.notices.some(notice => notice.includes('no judge configured'))).toBe(true)
  })
})

// ---- 372-07 Task 2: runReportVerb — whole-corpus assembly from persisted records (D-13/D-14) --

/** Extract + replay one recorded run so real replay.json/score.json records exist on disk. */
async function scoredRecordsFixture(
  plannerModelId: string = 'gpt-report-stub',
): Promise<{
  dir: string
  configPath: string
  session: EvalSession
  ids: string[]
}> {
  const { dir, configPath } = await writeReplayFixture('', plannerModelId)
  saveRun(dir, 'run-alpha', { recordedModelId: 'gpt-recorded-report-stub' })
  const session = await sessionFor(configPath)
  await runExtractVerb(session)
  // Deterministic timing is an input to the real producer. Rewriting replay.json after its
  // scoringContext was recorded would correctly make that score stale.
  const clock = vi.spyOn(performance, 'now').mockReturnValue(100)
  try {
    await runReplayVerb(session, {}, { plannerOverrides: replayStub(plannerModelId).overrides })
  } finally { clock.mockRestore() }
  return { dir, configPath, session, ids: await stagedCassetteIds(dir) }
}

/** Hand-write a persisted refusal replay record — refusal outcomes ARE entries (Pitfall 4). */
async function writeRefusalReplayRecord(dir: string, cassetteId: string): Promise<void> {
  const recordDir = join(dir, '.agent-qa', 'eval', 'replays', slugBranch(cassetteId))
  await mkdir(recordDir, { recursive: true })
  await writeFile(
    join(recordDir, 'replay.json'),
    JSON.stringify(
      {
        kind: 'integrity-refusal',
        cassetteId,
        reason: 'missing-blob',
        detail: 'fixture: blob absent from bundle',
      },
      null,
      2,
    ),
  )
}

/** Stamp a contrastive pairing onto a bundle document at an explicit path (D-08 exclusion input). */
async function setBundlePairingAt(
  bundleFile: string,
  relation: 'contrastive-negative' | 'contrastive-positive',
  pairedCassetteId: string,
): Promise<void> {
  const document = JSON.parse(await readFile(bundleFile, 'utf-8')) as {
    label: Record<string, unknown>
  }
  document.label = { ...document.label, pairing: { pairedCassetteId, relation } }
  await writeFile(bundleFile, `${JSON.stringify(document, null, 2)}\n`)
}

/** Stamp a contrastive pairing onto a staged bundle's label leg (the D-08 exclusion input). */
async function setStagedLabelPairing(
  dir: string,
  cassetteId: string,
  relation: 'contrastive-negative' | 'contrastive-positive',
  pairedCassetteId: string,
): Promise<void> {
  await setBundlePairingAt(
    join(
      dir,
      '.agent-qa',
      'eval',
      'cassettes',
      ...cassetteId.split('/').map(segment => slugBranch(segment)),
      'cassette.json',
    ),
    relation,
    pairedCassetteId,
  )
}

/** Reproduce the requested judge identity through real replay, adjudication and score storage. */
async function setScoreJudgeBlock(
  dir: string,
  cassetteId: string,
  judge: JudgeIdentityBlock | undefined,
): Promise<void> {
  const root = join(dir, '.agent-qa')
  const bundle = loadCassetteBundle(join(root, 'eval', 'cassettes',
    ...cassetteId.split('/').map(segment => slugBranch(segment))))
  if (bundle.kind !== 'loaded') throw new Error('expected guarded report fixture cassette')
  const planner = await resolveReplayPlanner(await sessionFor(join(dir, 'agent-qa.config.yaml')))
  const judgeStub = judge === undefined ? undefined : replayStub(judge.judgeModelId, () => ({
    ...clickGenerateResult(),
    content: [{ type: 'text', text: JSON.stringify({ verdict: 'equivalent', confidence: 'high',
      rationale: 'Equivalent fixture decision' }) }],
  }))
  await runCassetteReplay({
    cassette: bundle.cassette, artifacts: bundle.artifacts, ...planner,
    modelOverrides: replayStub(planner.profile.model).overrides,
    clock: { now: () => 100 },
    mask: (text: string) => text,
    recordStore: new FsReplayRecordStore({ root }), scoreStore: new FsScoreStore({ root }),
    ...(judge === undefined ? {} : { judge: {
      profile: { ...planner.profile, model: judge.judgeModelId }, auth: planner.auth,
      modelOverrides: judgeStub!.overrides,
      allowSameFamily: judge.familyOverride === 'same-family-allowed',
    } }),
  })
  const stored = JSON.parse(await readFile(join(replayDirFor(dir, cassetteId), 'score.json'), 'utf8'))
  expect(stored.judge).toEqual(judge)
  expect(stored.scoringContext).toBeDefined()
}

const JUDGE_BLOCK_A: JudgeIdentityBlock = {
  judgeModelId: 'claude-report-fixture',
  judgeFamily: 'claude',
  judgeVersion: JUDGE_CONFIG.judgeVersion,
  confidenceThreshold: 'high',
}

const JUDGE_BLOCK_B: JudgeIdentityBlock = {
  judgeModelId: 'gemini-report-fixture',
  judgeFamily: 'gemini',
  judgeVersion: JUDGE_CONFIG.judgeVersion,
  confidenceThreshold: 'high',
}

describe('runReportVerb — one batch, one report, one headline (D-13/D-14)', () => {
  it('refuses post-stamp replay tampering without rewriting the producer score', async () => {
    const { dir, session, ids } = await scoredRecordsFixture()
    const leafId = ids.find(id => id.endsWith('-leaf'))!
    const scoreFile = join(replayDirFor(dir, leafId), 'score.json')
    const originalScore = await readFile(scoreFile, 'utf8')
    const replayFile = join(replayDirFor(dir, leafId), 'replay.json')
    const replay = JSON.parse(await readFile(replayFile, 'utf8'))
    replay.totalDurationMs += 1
    await writeFile(replayFile, JSON.stringify(replay))
    const result = await runReportVerb(session)
    expect(result.report.honesty.neverScoredCounts['stale-scoring-context']).toBe(1)
    expect(await readFile(scoreFile, 'utf8')).toBe(originalScore)
  })

  it('assembles ONE whole-corpus report from every persisted replay record (the Wave 0 gap)', async () => {
    const { dir, session, ids } = await scoredRecordsFixture()
    expect(ids).toHaveLength(2)
    const leafId = ids.find(id => id.endsWith('-leaf'))!
    const procedureId = ids.find(id => !id.endsWith('-leaf'))!
    await writeRefusalReplayRecord(dir, 'refusal-fixture')
    // The leaf carries a contrastive-negative label leg: its full-match decision must move OUT
    // of the headline and INTO the negative buckets (D-08) — proof the pairing reached
    // buildEvalReport through the staged-label join.
    await setStagedLabelPairing(dir, leafId, 'contrastive-negative', procedureId)

    const result = await runReportVerb(session)

    expect(result.entries).toBe(3)
    expect(result.batchKey).toBe(computeBatchKey([...ids, 'refusal-fixture']))
    expect(result.report.batchKey).toBe(result.batchKey)
    // The persisted refusal outcome IS an entry — counted, never dropped (Pitfall 4).
    expect(result.report.honesty.refusalCounts['missing-blob']).toBe(1)
    // Scored entries carried their persisted scores; the labeled leaf's decision is negative.
    expect(result.report.recovery.negativeDecisionCount).toBe(1)
    expect(result.report.recovery.negativeFullMatchCount).toBe(1)
    // The staged report landed at the batchKey-derived path.
    expect(result.stagedFile).toBe(
      join(dir, '.agent-qa', 'eval', 'reports', `${slugBranch(result.batchKey)}.json`),
    )
    expect(result.stagedFile).toBeDefined()
    expect(existsSync(result.stagedFile!)).toBe(true)
  })

  it('threads judge identity honestly: present / absent / mixed, never fabricated (Pitfall 4)', async () => {
    const { dir, session, ids } = await scoredRecordsFixture()
    const [firstId, secondId] = [ids[0]!, ids[1]!]

    // No judge blocks anywhere ⇒ 'absent' with an honest notice, no block passed through.
    const absent = await runReportVerb(session)
    expect(absent.judgeIdentity).toBe('absent')
    expect(absent.report.judge).toBeUndefined()
    expect(absent.notices.some(notice => notice.includes('judge'))).toBe(true)

    // Identical blocks on every scored record ⇒ 'present' and the block passes to the report.
    await setScoreJudgeBlock(dir, firstId, JUDGE_BLOCK_A)
    await setScoreJudgeBlock(dir, secondId, JUDGE_BLOCK_A)
    const present = await runReportVerb(session)
    expect(present.judgeIdentity).toBe('present')
    expect(present.report.judge).toEqual(JUDGE_BLOCK_A)

    // Two DIFFERING blocks ⇒ 'mixed': buildEvalReport called WITHOUT a judge block, notice
    // emitted — an identity is never synthesized (T-372-20).
    await setScoreJudgeBlock(dir, secondId, JUDGE_BLOCK_B)
    const mixed = await runReportVerb(session)
    expect(mixed.judgeIdentity).toBe('mixed')
    expect(mixed.report.judge).toBeUndefined()
    expect(mixed.notices.some(notice => notice.includes('mixed'))).toBe(true)
    // 413-15: the mixture is stamped on the report as data, so the comparator can see it.
    expect(mixed.report.judgeIdentity).toBe('mixed')
  })

  it('--commit routes through commitEvalReport; an identical regeneration reports unchanged (D-13/D-17)', async () => {
    const { dir, session } = await scoredRecordsFixture()

    const first = await runReportVerb(session, {}, { commit: true })
    expect(first.committed).toMatchObject({
      kind: 'committed',
      json: 'written',
      markdown: 'written',
      decisions: 'written',
    })
    const reportDir = join(
      dir,
      'agent-qa-eval',
      'reports',
      slugBranch(first.batchKey),
    )
    expect(first.committed).toMatchObject({ reportDir })
    expect(existsSync(join(reportDir, 'report.json'))).toBe(true)
    expect(existsSync(join(reportDir, 'report.md'))).toBe(true)
    const decisions = guardDecisionVectorsDocument(
      JSON.parse(await readFile(join(reportDir, 'decisions.json'), 'utf8')),
    )
    expect(decisions.kind).toBe('ok')
    if (decisions.kind !== 'ok') throw new Error(decisions.reason)
    expect(decisions.document.batchKey).toBe(first.batchKey)
    expect(decisions.document.matcherVersion).toBe(first.report.matcherVersion)
    expect(decisions.document.vectors.length).toBeGreaterThan(0)
    const stagedDecisions = join(
      dir, '.agent-qa', 'eval', 'reports', `${slugBranch(first.batchKey)}.decisions.json`,
    )
    expect(JSON.parse(await readFile(stagedDecisions, 'utf8'))).toEqual(decisions.document)

    const second = await runReportVerb(session, {}, { commit: true })
    expect(second.committed).toMatchObject({
      kind: 'committed',
      json: 'unchanged',
      markdown: 'unchanged',
      decisions: 'unchanged',
    })
  })

  it('--commit still writes a guarded empty decisions document when every entry is refused', async () => {
    const { dir, session, ids } = await scoredRecordsFixture()
    const store = new FsReplayRecordStore({ root: join(dir, '.agent-qa') })
    for (const cassetteId of ids) {
      store.save({
        kind: 'integrity-refusal', cassetteId, reason: 'missing-blob',
        detail: 'fixture: blob absent from bundle',
      })
    }
    const result = await runReportVerb(session, {}, { commit: true })
    expect(result.entries).toBe(ids.length)
    expect(result.report.honesty.refusalCounts['missing-blob']).toBe(ids.length)
    expect(result.committed).toMatchObject({ kind: 'committed', decisions: 'written' })
    const document = JSON.parse(await readFile(
      join(dir, 'agent-qa-eval', 'reports', result.batchKey, 'decisions.json'), 'utf8',
    ))
    expect(guardDecisionVectorsDocument(document)).toEqual({
      kind: 'ok',
      document: {
        schemaVersion: DECISION_VECTORS_SCHEMA_VERSION, batchKey: result.batchKey,
        matcherVersion: result.report.matcherVersion, vectors: [],
      },
    })
  })
})

// ---- 372-07 Task 1: runSeedVerb — per-handoff plan-then-execute, wrapped 1:1 (D-01/D-16) ------

/**
 * Seed fixture: the extract fixture with Luhn-safe state timestamps. The committed egress
 * checkpoint's credit-card detector Luhn-checks every 13-19 digit run and the extract fixture's
 * 1725000000100 stateBefore timestamp happens to pass — a 10-digit epoch keeps the committed
 * cassette text free of card-shaped numbers (the seeding-composition test precedent).
 */
function saveSeedRun(
  dir: string,
  runId: string,
  options: {
    withPairSkipStep?: boolean
    outcome?: MemberTestOutcome
    rootCause?: Verdict
  } = {},
): void {
  const root = join(dir, '.agent-qa')
  const ref = new FsEvidenceArtifactStore({ root, runId }).persistDecisionScreenshot(BLOB_BYTES)
  const handoff = buildHandoff({
    runId,
    screenshotRef: ref,
    ...(options.outcome === undefined ? {} : { outcome: options.outcome }),
    ...(options.rootCause === undefined ? {} : { rootCause: options.rootCause }),
  })
  for (const test of handoff.tests) {
    for (const testStep of test.steps) {
      for (const subAction of testStep.subActions) {
        subAction.stateBefore = { ...subAction.stateBefore, timestamp: 1_725_000_000 }
      }
      if (options.withPairSkipStep) {
        // A selfHeal block whose failed action matches NO recorded sub-action mints exactly one
        // typed 'no-match' pair skip — never silent (T-371-18), carried verbatim by the verb.
        const recorded = testStep.subActions[0]!
        testStep.selfHeal = {
          failedDecision: {
            plan: 'Click a button that was never recorded',
            plannedAction: { type: 'click', ref: asRef('e-nonexistent') },
            result: structuredClone(recorded.result),
          },
          recoveringDecision: {
            plan: recorded.plan,
            plannedAction: structuredClone(recorded.plannedAction),
            result: structuredClone(recorded.result),
          },
        }
      }
    }
  }
  new FsHandoffStore({ root, runId }).save(handoff)
}

/**
 * 413-06 D-04 fixtures: the run's persisted analysis artifact (389 D-09) beside its handoff, and
 * the deterministic classification a retried-but-passed member carries on the handoff itself.
 */
function analysisArtifactFixture(
  runId: string,
  verdict: { class: Verdict['class']; producer: Verdict['producer'] },
): RunAnalysisArtifact {
  return {
    schemaVersion: CURRENT_ANALYSIS_SCHEMA_VERSION,
    runId,
    verdicts: [
      {
        class: verdict.class,
        producer: verdict.producer,
        confidence: 0.9,
        evidence: {
          citedSteps: [],
          citedAnchors: [],
          citedArtifacts: [],
          rationale: 'fixture analysis verdict',
        },
        memoryMisdirectionRuledOut: true,
        perTest: 0,
      },
    ],
    parts: [
      {
        perTest: 0,
        groundingQuote: { source: 'test-outcome', quote: 'fixture' },
        discriminator: 'fixture discriminator',
        nextAction: 'fixture next action',
        links: [],
      },
    ],
  }
}

function flakeRootCause(): Verdict {
  return {
    class: 'flake',
    producer: 'deterministic-classifier',
    confidence: 0.5,
    evidence: {
      citedSteps: [0],
      citedAnchors: [],
      citedArtifacts: [],
      rationale: 'passed on retry',
    },
    memoryMisdirectionRuledOut: true,
    perTest: 0,
  }
}

function testBugRootCause(): Verdict {
  return {
    class: 'test_bug',
    producer: 'deterministic-classifier',
    confidence: 0.7,
    evidence: {
      citedSteps: [0],
      citedAnchors: [],
      citedArtifacts: [],
      rationale: 'assertion never matched',
    },
    memoryMisdirectionRuledOut: true,
    perTest: 0,
  }
}

/** Write `analysis.json` beside the run's handoff — raw text so a corrupt file is expressible. */
async function saveAnalysis(dir: string, runId: string, text: string): Promise<void> {
  const runDir = join(dir, '.agent-qa', RUNS_SUBDIR, slugBranch(runId))
  await mkdir(runDir, { recursive: true })
  await writeFile(join(runDir, 'analysis.json'), text)
}

async function feedbackVerbFixture() {
  const { dir, configPath } = await writeFixture()
  await appendFile(configPath, '\nknowledge:\n  dir: knowledge\n')
  const committedRoot = join(dir, 'agent-qa-eval')
  await mkdir(committedRoot)
  await writeFile(join(committedRoot, 'eval-root.json'), JSON.stringify({ schemaVersion: COMMITTED_ROOT_SCHEMA_VERSION }))
  const agentQaRoot = join(dir, '.agent-qa')
  const { writeStagedFeedback } = await import(new URL(
    '../../../../eval-local/src/__tests__/fixtures/staged-feedback-fixture.js', import.meta.url,
  ).href)
  for (let index = 0; index < 2; index++) {
    const runId = generateRunId()
    const screenshotRef = new FsEvidenceArtifactStore({ root: agentQaRoot, runId }).persistDecisionScreenshot(BLOB_BYTES)
    const handoff = buildHandoff({ runId, screenshotRef, scope: { tier: 'product', key: `feedback-${index}` } })
    const state = handoff.tests[0]!.steps[0]!.subActions[0]!.stateBefore
    state.url = `https://feedback.example/${index}`
    state.timestamp = 1_725_000_000
    new FsHandoffStore({ root: agentQaRoot, runId }).save(handoff)
    writeStagedFeedback({ agentQaRoot, product: `feedback-${index}`,
      target: { runId, testId: handoff.tests[0]!.testId, stepIndex: 0 }, stateDigest: distilledScreenStateDigest(state),
      candidateId: `fixture-candidate-${index}`, attributedObservationId: `fixture-observation-${index}`, benefit: index === 0 ? 'rode-along' : 'exercised-harmed' })
  }
  const { createPromotionFloorFixture, completeGate1Receipt } = await import(new URL(
    '../../../../knowledge-local/src/curator/__tests__/fixtures/promotion-floor-fixture.js', import.meta.url,
  ).href)
  const knowledgeRoot = join(dir, 'knowledge')
  const knowledge = createPromotionFloorFixture({ knowledgeRoot })
  const { published } = knowledge.publishHeldCandidate('feedback')
  const digest = computeCorpusDigest(readCommittedCorpus(committedRoot).snapshot.entries)
  expect(appendGateReceipt(knowledge.outcomeAppendConfig(), published.id, completeGate1Receipt(published.id, { corpusDigest: digest }))).toEqual({ kind: 'appended' })
  return { dir, configPath, agentQaRoot, committedRoot, knowledgeRoot, candidateId: published.id, digest }
}

describe('418 eval seed --from-feedback', () => {
  afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports() })
  it.each([
    ['cleanup', false], ['cleanup', true], ['final-digest', false], ['final-digest', true],
  ] as const)('preserves verified admission after %s failure (json=%s)', async (phase, json) => {
    const f = await feedbackVerbFixture()
    const remove = fs.rmSync
    const read = fs.readFileSync
    const stagingRoot = join(fs.realpathSync(f.agentQaRoot), 'eval/feedback/')
    let cleanupReached = false
    vi.spyOn(fs, 'rmSync').mockImplementation((path, options) => {
      if (String(path).startsWith(stagingRoot)) {
        cleanupReached = true
        if (phase === 'cleanup') throw Object.assign(new Error('private fault text must not escape'), { code: 'EACCES' })
      }
      return remove(path, options)
    })
    vi.spyOn(fs, 'readFileSync').mockImplementation(((path: fs.PathOrFileDescriptor, options?: unknown) => {
      if (phase === 'final-digest' && cleanupReached && String(path) === join(f.committedRoot, 'eval-root.json')) {
        throw Object.assign(new Error('private fault text must not escape'), { code: 'EACCES' })
      }
      return read(path, options as Parameters<typeof read>[1])
    }) as typeof fs.readFileSync)
    syncBuiltinESMExports()
    const { logs, errors } = captureConsole()
    await buildProgram().parseAsync(['--config', f.configPath, 'eval', 'seed', '--from-feedback', ...(json ? ['--json'] : [])], { from: 'user' })
    expect(cleanupReached, JSON.stringify({ logs, errors })).toBe(true)
    expect(errors).toEqual([])
    expect(process.exitCode).toBe(2)
    expect(readCommittedCorpus(f.committedRoot).snapshot.entries).toHaveLength(2)
    expect(logs.join('\n')).not.toContain('private fault text')
    if (json) {
      const result = JSON.parse(logs[0]!)
      expect(result).toMatchObject({ kind: 'refused', writesStarted: true, previousCorpusDigest: f.digest,
        failures: expect.arrayContaining([expect.objectContaining({ phase })]) })
      expect(result.entries).toHaveLength(2)
      if (phase === 'final-digest') {
        expect(result.staleReceipts).toBeNull()
        expect(result).not.toHaveProperty('nextCorpusDigest')
      } else {
        expect(result.staleReceipts).toHaveLength(1)
        expect(result.nextCorpusDigest).not.toBe(f.digest)
        expect(result.failures).toHaveLength(2)
        expect(result.failures.every((failure: { cassetteId?: string }) => failure.cassetteId)).toBe(true)
      }
    } else {
      expect(logs.filter(line => line.startsWith('admitted '))).toHaveLength(2)
      expect(logs.some(line => line.startsWith(`feedback ${phase}:`))).toBe(true)
      expect(logs.join('\n')).toContain('Writes began; inspect the admitted entries')
      expect(logs.join('\n')).toContain(phase === 'final-digest'
        ? 'receipt-stale: unknown (final corpus digest unavailable)' : 'receipt-stale: 1')
    }
    vi.restoreAllMocks()
    syncBuiltinESMExports()
    const remaining = await readdir(join(f.agentQaRoot, 'eval/feedback/feedback-0'))
    expect(remaining).toHaveLength(phase === 'cleanup' ? 1 : 0)
  })
  it('classifies a staging read refusal before any writes without claiming progress', async () => {
    const f = await feedbackVerbFixture()
    await writeFile(join(f.agentQaRoot, 'eval/feedback/unexpected-file'), 'fixture')
    const before = await snapshotTree(f.committedRoot)
    const { logs } = captureConsole()
    await buildProgram().parseAsync(['--config', f.configPath, 'eval', 'seed', '--from-feedback', '--json'], { from: 'user' })
    expect(JSON.parse(logs[0]!)).toMatchObject({ kind: 'refused', entries: [], writesStarted: false,
      staleReceipts: [], failures: [{ phase: 'before-write', reason: 'feedback-unavailable' }] })
    expect(await snapshotTree(f.committedRoot)).toEqual(before)
  })
  it('previews a real mixed-product batch and standing receipt without changing any host file', async () => {
    const f = await feedbackVerbFixture()
    const before = await snapshotTree(f.dir)
    const { logs, errors } = captureConsole()
    await buildProgram().parseAsync(['--config', f.configPath, 'eval', 'seed', '--from-feedback', '--dry-run', '--json'], { from: 'user' })
    expect(errors).toEqual([])
    expect(logs).toHaveLength(1)
    const result = JSON.parse(logs[0]!)
    expect(result).toMatchObject({ kind: 'dry-run', previousCorpusDigest: f.digest,
      staleReceipts: [{ candidateId: f.candidateId, gate: 1, verdict: 'pass', corpusDigest: f.digest }] })
    expect(result.entries).toHaveLength(2)
    expect(result).not.toHaveProperty('nextCorpusDigest')
    expect(await snapshotTree(f.dir)).toEqual(before)
    expect(result.floorCommand).toBe(`agent-qa --config '${f.configPath}' eval floor`)
    const floor = vi.spyOn(evalVerbs, 'runFloorVerb').mockRejectedValue(new Error('registered floor reached without measurement'))
    await buildProgram().parseAsync(['--config', f.configPath, 'eval', 'floor'], { from: 'user' })
    expect(floor).toHaveBeenCalledTimes(1)
  })
  it('admits once, discloses the digest and receipt-stale change, then answers nothing-staged', async () => {
    const f = await feedbackVerbFixture()
    const { logs, errors } = captureConsole()
    const args = ['--config', f.configPath, 'eval', 'seed', '--from-feedback']
    await buildProgram().parseAsync(args, { from: 'user' })
    expect(errors).toEqual([])
    expect(logs.filter(line => line.startsWith('admitted '))).toHaveLength(2)
    expect(logs).toContain('standing receipts that will read receipt-stale: 1')
    expect(logs).toContain(`${f.candidateId} gate 1 pass`)
    expect(logs.some(line => line.startsWith(`corpus digest ${f.digest} → `))).toBe(true)
    const after = await snapshotTree(f.committedRoot)
    const next = computeCorpusDigest(readCommittedCorpus(f.committedRoot).snapshot.entries)
    expect(next).not.toBe(f.digest)
    logs.length = 0
    await buildProgram().parseAsync([...args, '--json'], { from: 'user' })
    expect(JSON.parse(logs[0]!)).toMatchObject({ kind: 'nothing-staged', entries: [], staleReceipts: [], nextCorpusDigest: next })
    expect(await snapshotTree(f.committedRoot)).toEqual(after)
  })
  it('filters optional product and never invents a corpus citation for Gate3', async () => {
    const f = await feedbackVerbFixture()
    const session = await resolveEvalSession({ configPath: f.configPath, keyOnly: true })
    const result = await evalVerbs.runSeedFromFeedbackVerb(session, { agentQaRoot: f.agentQaRoot, product: 'feedback-1', dryRun: true,
      knowledgeRoot: f.knowledgeRoot, readStandingGateReceipts: input => [
        ...LOCAL_CURATION_CAPABILITIES.readStandingGateReceipts(input),
        { candidateId: f.candidateId, gate: 3, verdict: 'pass', producedAtOrdinal: 45 },
        { candidateId: 'older', gate: 1, verdict: 'pass', corpusDigest: 'f'.repeat(64), producedAtOrdinal: 45 },
      ] })
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]!.product).toBe('feedback-1')
    expect(result.staleReceipts).toHaveLength(1)
    expect(result.staleReceipts?.[0]!.gate).toBe(1)
  })
  it.each([['--run', 'x'], ['--held-out-fraction', '0.5'], ['--private-fraction', '0.5'], ['--silver-cap', '2']])('refuses incompatible flags %j before session resolution', async (...flags) => {
    const { errors } = captureConsole()
    const session = vi.spyOn(evalVerbs, 'resolveEvalSession')
    await buildProgram().parseAsync(['eval', 'seed', '--from-feedback', ...flags], { from: 'user' })
    expect(process.exitCode).toBe(1)
    expect(errors.join('\n')).toContain('--from-feedback admits staged feedback only; --run and partition flags do not apply')
    expect(session).not.toHaveBeenCalled()
  })
  it('refuses no-eval-root with exit 2 and prevents dry-run on ordinary seed from writing', async () => {
    const f = await writeFixture()
    const before = await snapshotTree(f.dir)
    const { logs, errors } = captureConsole()
    await buildProgram().parseAsync(['--config', f.configPath, 'eval', 'seed', '--from-feedback', '--json'], { from: 'user' })
    expect(JSON.parse(logs[0]!)).toMatchObject({ kind: 'refused', reason: 'no-eval-root', entries: [] })
    expect(process.exitCode).toBe(2)
    await buildProgram().parseAsync(['--config', f.configPath, 'eval', 'seed', '--dry-run'], { from: 'user' })
    expect(errors.join('\n')).toContain('--dry-run requires --from-feedback')
    expect(await snapshotTree(f.dir)).toEqual(before)
  })
})

describe('runSeedVerb — corpus committing wraps seedCommittedCorpus 1:1 (D-01/D-16/D-17)', () => {
  it('re-extracts per handoff, plans, seeds the committed root, and sums the reports (D-16)', async () => {
    const { dir, configPath } = await writeFixture()
    saveSeedRun(dir, 'run-alpha')
    saveSeedRun(dir, 'run-beta')
    const session = await sessionFor(configPath)
    await runExtractVerb(session)
    const ids = await stagedCassetteIds(dir)
    const leafIds = ids.filter(id => id.endsWith('-leaf'))
    expect(leafIds).toHaveLength(2)

    const result = await runSeedVerb(session, {}, TEST_FRACTIONS)

    // The committedRoot is ALWAYS <configDir>/agent-qa-eval (spec §B7, D-12) — no flag retargets it.
    expect(result.committedRoot).toBe(resolve(dir, 'agent-qa-eval'))
    expect(result.handoffsSeeded).toBe(2)
    // Each run's single verified-pass live decision is one silver case (D-10/D-11).
    expect(result.seededCount).toBe(2)
    expect(result.unchangedCount).toBe(0)
    expect(result.refusals).toEqual([])
    expect(result.pairSkips).toBe(0)
    expect(result.pairCounts).toEqual({ total: 0, sameState: 0, differingState: 0 })
    // Committed files land under the product partition — cassette + label per admitted case.
    for (const leafId of leafIds) {
      expect(existsSync(join(result.committedRoot, committedCassettePath('default', leafId)))).toBe(true)
      expect(existsSync(join(result.committedRoot, committedLabelPath('default', leafId)))).toBe(true)
    }
    expect(existsSync(join(result.committedRoot, 'eval-root.json'))).toBe(true)
  })

  it('re-seeds idempotently: the second sweep reports every case unchanged (D-17)', async () => {
    const { dir, configPath } = await writeFixture()
    saveSeedRun(dir, 'run-alpha')
    saveSeedRun(dir, 'run-beta')
    const session = await sessionFor(configPath)

    const first = await runSeedVerb(session, {}, TEST_FRACTIONS)
    expect(first.seededCount).toBe(2)
    expect(first.refusals).toEqual([])

    const second = await runSeedVerb(session)
    expect(second.unchangedCount).toBe(first.seededCount)
    expect(second.seededCount).toBe(0)
    expect(second.refusals).toEqual([])
    // 414 D-07 read with D-05: a later seed accepts no fraction flags and re-derives nothing —
    // the committed manifest is echoed back unchanged, never rewritten.
    expect(second.partitions).toHaveLength(1)
    expect(second.partitions[0]?.outcome).toBe('unchanged')
    expect(second.partitions[0]?.saltDigest).toBe(first.partitions[0]?.saltDigest)
  })

  it('threads params.silverPerTestCap into buildSeedingPlan — cap 0 admits nothing (D-11)', async () => {
    const { dir, configPath } = await writeFixture()
    saveSeedRun(dir, 'run-alpha')
    const session = await sessionFor(configPath)

    const capped = await runSeedVerb(session, {}, { silverPerTestCap: 0, ...TEST_FRACTIONS })
    expect(capped.seededCount).toBe(0)
    // The excluded candidate is a typed 'cap-exceeded' exclusion, never silently dropped.
    expect(capped.silverExclusions).toBeGreaterThan(0)

    const uncapped = await runSeedVerb(session)
    expect(uncapped.seededCount).toBe(1)
  })

  it('carries typed pair skips verbatim from the SeedingReport (T-371-18)', async () => {
    const { dir, configPath } = await writeFixture()
    saveSeedRun(dir, 'run-skips', { withPairSkipStep: true })
    const session = await sessionFor(configPath)

    const result = await runSeedVerb(session, {}, TEST_FRACTIONS)

    expect(result.pairSkips).toBe(1)
    // The selfHeal step's decision belongs to the pair channel, so silver excludes it too.
    expect(result.seededCount).toBe(0)
    expect(result.silverExclusions).toBeGreaterThan(0)
  })

  // ---- 413-06 Task 1: D-09 forward relative paths + the D-04 verdict filter -------------------

  it('writes run_links as exactly { runId, runSlug } — the machine path is gone (414 D-13)', async () => {
    const { dir, configPath } = await writeFixture()
    saveSeedRun(dir, 'run-alpha')
    saveSeedRun(dir, 'run-beta')
    const session = await sessionFor(configPath)

    const result = await runSeedVerb(session, {}, TEST_FRACTIONS)
    expect(result.seededCount).toBe(2)

    const read = readCommittedCorpus(resolve(dir, 'agent-qa-eval'))
    expect(read.snapshot.entries).toHaveLength(2)
    for (const entry of read.snapshot.entries) {
      // 414 D-13 superseded 413's T-413-27 relativisation by DELETING the field: a committed
      // entry names the run, and the run dir is a machine-local fact nobody else can resolve.
      // Deep equality (not a key probe) is what keeps a path from creeping back in.
      expect(entry.run_links).toEqual({
        runId: entry.run_links.runId,
        runSlug: entry.run_links.runSlug,
      })
      expect(Object.keys(entry.run_links).sort()).toEqual(['runId', 'runSlug'])
      expect(JSON.stringify(entry.run_links)).not.toContain(dir)
    }
  })

  it('excludes a deterministic flake run with typed verdicts and seeds nothing for it (D-04)', async () => {
    const { dir, configPath } = await writeFixture()
    saveSeedRun(dir, 'run-flaky', { rootCause: flakeRootCause() })
    const session = await sessionFor(configPath)

    const result = await runSeedVerb(session, {}, TEST_FRACTIONS)

    expect(result.seededCount).toBe(0)
    expect(result.handoffsSeeded).toBe(0)
    expect(result.runsAdmitted).toEqual([])
    expect(result.runsExcluded).toEqual([
      {
        runSlug: slugBranch('run-flaky'),
        product: 'default',
        verdicts: [{ class: 'flake', producer: 'deterministic-classifier' }],
      },
    ])
    // The exclusion runs BEFORE the write-once root is touched: nothing landed for the run.
    const read = readCommittedCorpus(resolve(dir, 'agent-qa-eval'))
    expect(read.snapshot.entries).toEqual([])
  })

  it('excludes an analyze-run environment verdict read from analysis.json (D-04/389 D-10)', async () => {
    const { dir, configPath } = await writeFixture()
    saveSeedRun(dir, 'run-env')
    await saveAnalysis(
      dir,
      'run-env',
      `${JSON.stringify(analysisArtifactFixture('run-env', {
        class: 'environment',
        producer: 'analyze-run',
      }), null, 2)}\n`,
    )
    const session = await sessionFor(configPath)

    const result = await runSeedVerb(session, {}, TEST_FRACTIONS)

    expect(result.seededCount).toBe(0)
    expect(result.runsExcluded).toEqual([
      {
        runSlug: slugBranch('run-env'),
        product: 'default',
        verdicts: [{ class: 'environment', producer: 'analyze-run' }],
      },
    ])
  })

  it('admits a clean run and a test_bug run, listing each admitted runs verdict producer (D-04)', async () => {
    const { dir, configPath } = await writeFixture()
    saveSeedRun(dir, 'run-clean')
    saveSeedRun(dir, 'run-testbug', { outcome: 'failed', rootCause: testBugRootCause() })
    const session = await sessionFor(configPath)

    const result = await runSeedVerb(session, {}, TEST_FRACTIONS)

    expect(result.runsExcluded).toEqual([])
    // D-04 excludes EXACTLY three classes — test_bug is an attributable failure and stays in.
    expect(result.runsAdmitted).toEqual([
      {
        runSlug: slugBranch('run-clean'),
        product: 'default',
        verdicts: [],
      },
      {
        runSlug: slugBranch('run-testbug'),
        product: 'default',
        verdicts: [{ class: 'test_bug', producer: 'deterministic-classifier' }],
      },
    ])
    // The clean run still seeds its single verified-pass silver case, exactly as before.
    expect(result.seededCount).toBe(1)
  })

  it('treats an unreadable analysis.json as artifact-absent with a notice, never a skip (T-413-26)', async () => {
    const { dir, configPath } = await writeFixture()
    saveSeedRun(dir, 'run-alpha')
    await saveAnalysis(dir, 'run-alpha', 'not json')
    const session = await sessionFor(configPath)

    const result = await runSeedVerb(session, {}, TEST_FRACTIONS)

    // The deterministic floor answers instead — the run seeds and is never skipped.
    expect(result.runsSkipped).toEqual([])
    expect(result.seededCount).toBe(1)
    expect(result.runsAdmitted).toHaveLength(1)
    expect(
      result.notices.some(
        notice => notice.includes(slugBranch('run-alpha')) && notice.includes('analysis.json'),
      ),
    ).toBe(true)
  })
})

// ---- 414-07 Task 1: the partition manifest and the committed run exclusions -------------------

describe('runSeedVerb — partition manifest and run exclusions (414 D-02/D-05/D-06/D-07)', () => {
  it('mints a 32-byte salt and commits the product manifest on the FIRST seed (D-05/D-06)', async () => {
    const { dir, configPath } = await writeFixture()
    saveSeedRun(dir, 'run-alpha')
    saveSeedRun(dir, 'run-beta')
    const session = await sessionFor(configPath)

    const result = await runSeedVerb(session, {}, TEST_FRACTIONS)

    const manifestPath = join(dir, 'agent-qa-eval', 'contracts', 'partition-default.json')
    const manifest = guardPartitionManifest(
      JSON.parse(await readFile(manifestPath, 'utf8')),
    )
    expect(manifest.salt).toMatch(/^[0-9a-f]{64}$/)
    expect(result.partitions).toEqual([
      {
        product: 'default',
        path: 'contracts/partition-default.json',
        outcome: 'written',
        saltDigest: createHash('sha256').update(manifest.salt).digest('hex'),
        heldOutFraction: TEST_FRACTIONS.heldOutFraction,
        privateFraction: TEST_FRACTIONS.privateFraction,
        partitionVersion: 1,
      },
    ])
    // D-17: the raw salt is a partition secret. Only its digest may leave the manifest file.
    expect(JSON.stringify(result)).not.toContain(manifest.salt)

    // D-07: every entry's split is assignSplit over the COMMITTED params — the cli relabels nothing.
    const read = readCommittedCorpus(resolve(dir, 'agent-qa-eval'))
    expect(read.snapshot.entries).toHaveLength(2)
    // D-08: a self-heal pair member is never bucketed and is always natural. This fixture mints
    // no pair cases at all (asserted, so the `false` below can never go quietly vacuous), so
    // every seeded entry is a bucketed silver leaf.
    expect(result.pairCounts.total).toBe(0)
    for (const entry of read.snapshot.entries) {
      const expected = assignSplit({
        ...partitionParamsOf(manifest),
        cassetteId: entry.cassetteId,
        isPairMember: false,
      })
      expect(entry.split).toBe(expected.split)
      if (entry.split === 'held-out' && expected.split === 'held-out') {
        expect(entry.heldOutVisibility).toBe(expected.heldOutVisibility)
      }
    }
  })

  it('re-seeds with no fraction flags: the manifest is echoed unchanged, bytes untouched (D-07)', async () => {
    const { dir, configPath } = await writeFixture()
    saveSeedRun(dir, 'run-alpha')
    const session = await sessionFor(configPath)
    const first = await runSeedVerb(session, {}, TEST_FRACTIONS)
    const manifestPath = join(dir, 'agent-qa-eval', 'contracts', 'partition-default.json')
    const before = await readFile(manifestPath, 'utf8')

    const second = await runSeedVerb(session)

    expect(second.partitions).toHaveLength(1)
    expect(second.partitions[0]?.outcome).toBe('unchanged')
    expect(second.partitions[0]?.saltDigest).toBe(first.partitions[0]?.saltDigest)
    expect(second.unchangedCount).toBeGreaterThan(0)
    expect(await readFile(manifestPath, 'utf8')).toBe(before)
  })

  it('refuses a later seed whose fractions DISAGREE with the committed manifest (D-05)', async () => {
    const { dir, configPath } = await writeFixture()
    saveSeedRun(dir, 'run-alpha')
    const session = await sessionFor(configPath)
    await runSeedVerb(session, {}, TEST_FRACTIONS)
    const manifestPath = join(dir, 'agent-qa-eval', 'contracts', 'partition-default.json')
    const before = await readFile(manifestPath, 'utf8')
    const entriesBefore = readCommittedCorpus(resolve(dir, 'agent-qa-eval')).snapshot.entries.length

    await expect(
      runSeedVerb(session, {}, { ...TEST_FRACTIONS, heldOutFraction: 0.25 }),
    ).rejects.toThrow(EvalPartitionManifestConflictError)
    await expect(
      runSeedVerb(session, {}, { ...TEST_FRACTIONS, heldOutFraction: 0.25 }),
    ).rejects.toThrow(/default[\s\S]*contracts\/partition-default\.json|contracts\/partition-default\.json/)

    // Nothing moved: a disagreeing manifest is refused, never merged over the committed one.
    expect(await readFile(manifestPath, 'utf8')).toBe(before)
    expect(readCommittedCorpus(resolve(dir, 'agent-qa-eval')).snapshot.entries).toHaveLength(
      entriesBefore,
    )
  })

  it('requires BOTH flags on a first partition — but the exclusion is already committed (D-02/D-07)', async () => {
    const { dir, configPath } = await writeFixture()
    saveSeedRun(dir, 'run-alpha')
    saveSeedRun(dir, 'run-flaky', { rootCause: flakeRootCause() })
    const session = await sessionFor(configPath)

    await expect(runSeedVerb(session)).rejects.toThrow(EvalPartitionFlagsRequiredError)
    await expect(runSeedVerb(session)).rejects.toThrow(/default/)

    const committedRoot = resolve(dir, 'agent-qa-eval')
    expect(existsSync(join(committedRoot, 'corpus'))).toBe(false)
    expect(existsSync(join(committedRoot, 'contracts', 'partition-default.json'))).toBe(false)
    // D-02: provenance for a dropped run is written in phase (A), before and independently of the
    // partition check — the operator learns what was excluded from the invocation that refused.
    const exclusionPath = join(
      committedRoot,
      'exclusions',
      'default',
      `${slugBranch('run-flaky')}.json`,
    )
    expect(existsSync(exclusionPath)).toBe(true)

    const retried = await runSeedVerb(session, {}, TEST_FRACTIONS)
    expect(retried.exclusionsWritten).toEqual([
      {
        runSlug: slugBranch('run-flaky'),
        product: 'default',
        path: `exclusions/default/${slugBranch('run-flaky')}.json`,
        outcome: 'unchanged',
      },
    ])
    expect(retried.partitions[0]?.outcome).toBe('written')
  })

  it('commits an exclusion digesting the analysis.json bytes that decided it (D-02)', async () => {
    const { dir, configPath } = await writeFixture()
    saveSeedRun(dir, 'run-alpha')
    const analysisText = `${JSON.stringify(
      analysisArtifactFixture('run-alpha', { class: 'flake', producer: 'analyze-run' }),
      null,
      2,
    )}\n`
    await saveAnalysis(dir, 'run-alpha', analysisText)
    const session = await sessionFor(configPath)

    const result = await runSeedVerb(session, {}, TEST_FRACTIONS)

    expect(result.runsExcluded).toEqual([
      {
        runSlug: 'run-alpha',
        product: 'default',
        verdicts: [{ class: 'flake', producer: 'analyze-run' }],
      },
    ])
    expect(result.exclusionsWritten).toEqual([
      {
        runSlug: 'run-alpha',
        product: 'default',
        path: 'exclusions/default/run-alpha.json',
        outcome: 'written',
      },
    ])

    const record = guardRunExclusionRecord(
      JSON.parse(
        await readFile(join(dir, 'agent-qa-eval', 'exclusions', 'default', 'run-alpha.json'), 'utf8'),
      ),
    )
    expect(record.runSlug).toBe('run-alpha')
    expect(record.reason).toBe('excluded-verdict-class')
    expect(record.verdicts[0]?.producer).toBe('analyze-run')
    expect(record.analysisDigest).toBe(
      createHash('sha256').update(analysisText).digest('hex'),
    )

    // Write-once: an identical regeneration is `unchanged`, never a second decision.
    const again = await runSeedVerb(session)
    expect(again.exclusionsWritten[0]?.outcome).toBe('unchanged')
  })

  it('commits an exclusion for a deterministic-floor flake, digesting the verdict rows (D-02)', async () => {
    const { dir, configPath } = await writeFixture()
    saveSeedRun(dir, 'run-flaky', { rootCause: flakeRootCause() })
    const session = await sessionFor(configPath)

    const result = await runSeedVerb(session, {}, TEST_FRACTIONS)

    const record = guardRunExclusionRecord(
      JSON.parse(
        await readFile(
          join(dir, 'agent-qa-eval', 'exclusions', 'default', `${slugBranch('run-flaky')}.json`),
          'utf8',
        ),
      ),
    )
    // No analysis.json exists, so the digest covers the canonical resolved verdict rows the
    // deterministic classifier produced — the evidence that actually decided the exclusion.
    expect(record.verdicts).toEqual([{ class: 'flake', producer: 'deterministic-classifier' }])
    expect(record.analysisDigest).toBe(
      createHash('sha256')
        .update(canonicalJson(result.runsExcluded[0]?.verdicts ?? []))
        .digest('hex'),
    )
  })

  it('renders one summary line per partition and per written exclusion, none when empty (D-04)', async () => {
    const { dir, configPath } = await writeFixture()
    saveSeedRun(dir, 'run-alpha')
    saveSeedRun(dir, 'run-flaky', { rootCause: flakeRootCause() })
    const session = await sessionFor(configPath)
    const { logs, errors } = captureConsole()

    await buildProgram().parseAsync(
      [
        '--config',
        configPath,
        'eval',
        'seed',
        '--held-out-fraction',
        String(TEST_FRACTIONS.heldOutFraction),
        '--private-fraction',
        String(TEST_FRACTIONS.privateFraction),
      ],
      { from: 'user' },
    )

    expect(process.exitCode).not.toBe(1)
    expect(errors).toEqual([])
    const rendered = logs.join('\n')
    const manifest = guardPartitionManifest(
      JSON.parse(
        await readFile(join(dir, 'agent-qa-eval', 'contracts', 'partition-default.json'), 'utf8'),
      ),
    )
    const digest = createHash('sha256').update(manifest.salt).digest('hex')
    expect(rendered).toContain(
      `  default: held-out ${TEST_FRACTIONS.heldOutFraction}, `
        + `private ${TEST_FRACTIONS.privateFraction}, salt sha256 ${digest}`,
    )
    expect(rendered).toContain(`exclusions/default/${slugBranch('run-flaky')}.json (written)`)
    // D-17: the raw salt never reaches an operator's terminal.
    expect(rendered).not.toContain(manifest.salt)
  })

  it('reports a diverging committed exclusion as a write-conflict DATA row, never a throw (D-02)', async () => {
    const { dir, configPath } = await writeFixture()
    saveSeedRun(dir, 'run-alpha')
    saveSeedRun(dir, 'run-flaky', { rootCause: flakeRootCause() })
    const session = await sessionFor(configPath)
    // Plant a VALID exclusion record for the same run whose core disagrees (a different
    // analysisDigest): the write-once writer must refuse it rather than overwrite.
    const planted = join(
      dir,
      'agent-qa-eval',
      'exclusions',
      'default',
      `${slugBranch('run-flaky')}.json`,
    )
    await mkdir(dirname(planted), { recursive: true })
    await writeFile(
      planted,
      committedFileText(
        projectRunExclusion({
          runId: 'run-flaky',
          runSlug: slugBranch('run-flaky'),
          product: 'default',
          verdicts: [{ class: 'flake', producer: 'deterministic-classifier' }],
          analysisDigest: 'a'.repeat(64),
        }),
      ),
    )
    const before = await readFile(planted, 'utf8')

    const result = await runSeedVerb(session, {}, TEST_FRACTIONS)

    // A refused write is DATA on the DTO — the sweep still partitions and still seeds run-alpha.
    expect(result.exclusionsWritten).toEqual([
      {
        runSlug: slugBranch('run-flaky'),
        product: 'default',
        path: `exclusions/default/${slugBranch('run-flaky')}.json`,
        outcome: 'write-conflict',
      },
    ])
    expect(await readFile(planted, 'utf8')).toBe(before)
    expect(result.partitions[0]?.outcome).toBe('written')
    expect(result.seededCount).toBe(1)
  })

  it('prints "- none" for both blocks when a sweep partitions and excludes nothing (D-04)', async () => {
    const { configPath } = await writeFixture()
    const { logs, errors } = captureConsole()

    await buildProgram().parseAsync(['--config', configPath, 'eval', 'seed'], { from: 'user' })

    expect(process.exitCode).not.toBe(1)
    expect(errors).toEqual([])
    const rendered = logs.join('\n')
    expect(rendered).toContain('partitions:')
    expect(rendered).toContain('exclusions written:')
    expect(rendered).toContain('- none')
  })
})

// ---- 414-07 Task 2: the two optional D-04 provenance fields ----------------------------------

/**
 * 414 D-04: a fixture whose `registry.targets` block is supplied by the cell.
 *
 * The environment is a property of the TARGET REGISTRY — a `CompletedRunHandoff` carries no
 * target at all — so every D-04 environment case has to be expressed here and nowhere else.
 */
async function writeTargetsFixture(
  targetLines: readonly string[],
): Promise<{ dir: string; configPath: string }> {
  const dir = await mkdtemp(join(tmpRoot, 'fixture-'))
  const configPath = join(dir, 'agent-qa.config.yaml')
  await writeFile(
    configPath,
    CONFIG_YAML.replace('use:\n', `${['  targets:', ...targetLines, 'use:'].join('\n')}\n`),
  )
  await writeFile(join(dir, '.env.secrets.local'), '')
  return { dir, configPath }
}

function webTarget(
  name: string,
  fields: { product?: string; environment?: 'local' | 'shared' },
): string[] {
  return [
    `    ${name}:`,
    '      platform: web',
    `      url: https://${name}.example.test`,
    ...(fields.product === undefined ? [] : [`      product: ${fields.product}`]),
    ...(fields.environment === undefined ? [] : [`      environment: ${fields.environment}`]),
  ]
}

/** The fixture run's own clock — the ONLY source captured_at may come from (D-04). */
async function handoffEndedAt(dir: string, runId: string): Promise<number> {
  const raw = await readFile(
    join(dir, '.agent-qa', RUNS_SUBDIR, slugBranch(runId), HANDOFF_FILE),
    'utf8',
  )
  return (JSON.parse(raw) as { endedAt: number }).endedAt
}

describe('runSeedVerb — captured_at and targetEnvironment stamping (414 D-04)', () => {
  it('stamps both fields when exactly one declared environment resolves for the product', async () => {
    const { dir, configPath } = await writeTargetsFixture(
      webTarget('checkout', { product: 'default', environment: 'shared' }),
    )
    saveSeedRun(dir, 'run-alpha')
    const session = await sessionFor(configPath)

    const result = await runSeedVerb(session, {}, TEST_FRACTIONS)
    expect(result.seededCount).toBe(1)

    const expectedCapturedAt = new Date(await handoffEndedAt(dir, 'run-alpha')).toISOString()
    const read = readCommittedCorpus(resolve(dir, 'agent-qa-eval'))
    expect(read.snapshot.entries).toHaveLength(1)
    for (const entry of read.snapshot.entries) {
      expect(entry.targetEnvironment).toBe('shared')
      expect(entry.captured_at).toBe(expectedCapturedAt)
    }
  })

  it('OMITS targetEnvironment for a MIXED target set, keeping captured_at (D-04)', async () => {
    const { dir, configPath } = await writeTargetsFixture([
      ...webTarget('checkout', { product: 'default', environment: 'shared' }),
      ...webTarget('staging', { product: 'default', environment: 'local' }),
    ])
    saveSeedRun(dir, 'run-alpha')
    const session = await sessionFor(configPath)

    await runSeedVerb(session, {}, TEST_FRACTIONS)

    const read = readCommittedCorpus(resolve(dir, 'agent-qa-eval'))
    expect(read.snapshot.entries).toHaveLength(1)
    for (const entry of read.snapshot.entries) {
      // A mixed set has no single answer, and a majority vote would be a fabricated one. The KEY
      // is absent — asserting `toBe(undefined)` would pass on a key present with value undefined.
      expect(Object.keys(entry)).not.toContain('targetEnvironment')
      expect(Object.keys(entry)).toContain('captured_at')
    }
  })

  it('OMITS targetEnvironment when no target, or an undeclared one, resolves (D-04)', async () => {
    const cases: readonly string[][] = [
      // No target resolves to the run's product at all.
      webTarget('otherapp', { product: 'somewhere-else', environment: 'shared' }),
      // The only matching target declares no environment — silence stays silence.
      webTarget('checkout', { product: 'default' }),
    ]
    for (const targetLines of cases) {
      const { dir, configPath } = await writeTargetsFixture(targetLines)
      saveSeedRun(dir, 'run-alpha')
      const session = await sessionFor(configPath)

      await runSeedVerb(session, {}, TEST_FRACTIONS)

      const read = readCommittedCorpus(resolve(dir, 'agent-qa-eval'))
      expect(read.snapshot.entries).toHaveLength(1)
      for (const entry of read.snapshot.entries) {
        expect(Object.keys(entry)).not.toContain('targetEnvironment')
        expect(Object.keys(entry)).toContain('captured_at')
      }
    }
  })

  it('resolveTargetEnvironmentForProduct answers shared, undefined, undefined (D-04)', async () => {
    const single = await writeTargetsFixture(
      webTarget('checkout', { product: 'default', environment: 'shared' }),
    )
    const mixed = await writeTargetsFixture([
      ...webTarget('checkout', { product: 'default', environment: 'shared' }),
      ...webTarget('staging', { product: 'default', environment: 'local' }),
    ])
    const undeclared = await writeTargetsFixture(webTarget('checkout', { product: 'default' }))

    expect(
      resolveTargetEnvironmentForProduct((await sessionFor(single.configPath)).config, 'default'),
    ).toBe('shared')
    expect(
      resolveTargetEnvironmentForProduct((await sessionFor(mixed.configPath)).config, 'default'),
    ).toBeUndefined()
    expect(
      resolveTargetEnvironmentForProduct(
        (await sessionFor(undeclared.configPath)).config,
        'default',
      ),
    ).toBeUndefined()
    // A target the registry knows nothing about never invents a class for itself.
    expect(
      resolveTargetEnvironmentForProduct((await sessionFor(single.configPath)).config, 'nobody'),
    ).toBeUndefined()
  })
})

// ---- 413-06 Task 2: --source committed on replay and report (D-08) ---------------------------

/** Extract, replay and seed one run so the fixture COMMITTED root holds real cassette bundles. */
async function committedCorpusFixture(): Promise<{
  dir: string
  configPath: string
  session: EvalSession
  committedRoot: string
  leafId: string
  procedureId: string
}> {
  const { dir, configPath } = await writeReplayFixture()
  saveSeedRun(dir, 'run-alpha')
  const session = await sessionFor(configPath)
  await runExtractVerb(session)
  const seeded = await runSeedVerb(session, {}, TEST_FRACTIONS)
  expect(seeded.seededCount).toBe(1)
  const ids = await stagedCassetteIds(dir)
  const leafId = ids.find(id => id.endsWith('-leaf'))
  const procedureId = ids.find(id => !id.endsWith('-leaf'))
  if (leafId === undefined || procedureId === undefined) {
    throw new Error('expected one staged leaf and one staged procedure cassette')
  }
  return { dir, configPath, session, committedRoot: resolve(dir, 'agent-qa-eval'), leafId, procedureId }
}

/** The committed bundle dir for one seeded leaf under the fixture's product partition. */
function committedBundleDir(committedRoot: string, cassetteId: string): string {
  return dirname(join(committedRoot, committedCassettePath('default', cassetteId)))
}

describe('eval --source committed — the whole committed corpus in ONE batch (413 D-08)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('replay sweeps the committed root under the committed source and reports it', async () => {
    const { dir, session, leafId } = await committedCorpusFixture()

    const result = await runReplayVerb(
      session,
      {},
      { source: 'committed', plannerOverrides: replayStub().overrides },
    )

    // Only the seeded leaf lives in the committed root — the whole corpus, not the staging root.
    expect(result.source).toBe('committed')
    expect(result.swept).toBe(1)
    expect(result.replayed).toBe(1)
    expect(result.loadRefusals).toEqual({})
    expect(result.replayRefusals).toEqual({})
    expect(result.batchKey).toBe(computeBatchKey([leafId]))
    // D-07: replay records stay runtime staging even when the cassettes came from the committed root.
    expect(result.replaysRoot).toBe(join(dir, '.agent-qa', 'eval', 'replays'))
    expect(existsSync(join(replayDirFor(dir, leafId), 'replay.json'))).toBe(true)
    expect(result.notices.some(notice => notice.includes('committed root'))).toBe(true)
  })

  it('counts a blob-less committed cassette as a missing-blob refusal under the committed source', async () => {
    const { dir, session, committedRoot, leafId } = await committedCorpusFixture()
    // The committed root gitignores blobs/, so a fresh clone replays cassettes whose bytes are
    // absent locally. That entry is a COUNTED refusal — never dropped from the denominator.
    await rm(join(committedBundleDir(committedRoot, leafId), 'blobs'), {
      recursive: true,
      force: true,
    })

    const result = await runReplayVerb(
      session,
      {},
      { source: 'committed', plannerOverrides: replayStub().overrides },
    )

    expect(result.source).toBe('committed')
    expect(result.swept).toBe(1)
    expect(result.replayRefusals['missing-blob']).toBe(1)
    expect(result.loadRefusals).toEqual({})
    // A refusal IS an outcome: the record is persisted so the report counts the entry (Pitfall 4).
    expect(existsSync(join(replayDirFor(dir, leafId), 'replay.json'))).toBe(true)
  })

  it('leaves the default staged source unchanged when no source is supplied', async () => {
    const { dir, session } = await committedCorpusFixture()

    const result = await runReplayVerb(session, {}, { plannerOverrides: replayStub().overrides })

    expect(result.source).toBe('staged')
    // Both staged bundles (leaf + procedure) entered — the staging root, not the committed one.
    expect(result.swept).toBe(2)
    expect(result.replayed).toBe(2)
    expect(existsSync(join(dir, '.agent-qa', 'eval', 'cassettes'))).toBe(true)
  })

  it('report joins label legs from the committed source and reports the source', async () => {
    const { session, committedRoot, leafId, procedureId } = await committedCorpusFixture()
    await runReplayVerb(session, {}, { plannerOverrides: replayStub().overrides })
    // The pairing lands ONLY on the authoritative committed label, leaving the recorded
    // cassette and staged label unchanged.
    await setBundlePairingAt(
      join(committedRoot, committedLabelPath('default', leafId)),
      'contrastive-negative',
      procedureId,
    )

    const committed = await runReportVerb(session, {}, { source: 'committed' })
    expect(committed.source).toBe('committed')
    const members = readCommittedCorpus(committedRoot).snapshot.entries.map(entry => entry.cassetteId)
    expect(members).toEqual([leafId])
    expect(members).not.toContain(procedureId)
    expect(committed.entries).toBe(members.length)
    expect(committed.batchKey).toBe(computeBatchKey(members))
    expect(committed.report.recovery.negativeDecisionCount).toBe(1)

    const staged = await runReportVerb(session)
    expect(staged.source).toBe('staged')
    // Phase420: authoritative standalone labels govern staged scores too; split ownership remains unknown.
    expect(staged.report.recovery.negativeDecisionCount).toBe(1)
    expect(staged.report.perSplit.unassignedCount).toBe(staged.entries)
  })

  it('accepts --source committed and rejects an unknown source with exit 1 on both verbs', async () => {
    const { configPath } = await committedCorpusFixture()

    const accepted = captureConsole()
    await buildProgram().parseAsync(
      ['--config', configPath, 'eval', 'replay', '--source', 'committed', '--json'],
      { from: 'user' },
    )
    expect(process.exitCode).not.toBe(1)
    const dto = JSON.parse(accepted.logs.join('\n')) as ReplayVerbResult
    expect(dto.source).toBe('committed')
    vi.restoreAllMocks()

    const rejected = captureConsole()
    await buildProgram().parseAsync(
      ['--config', configPath, 'eval', 'replay', '--source', 'bogus'],
      { from: 'user' },
    )
    expect(process.exitCode).toBe(1)
    expect(rejected.errors.join('\n')).toContain('--source')
    expect(rejected.logs).toEqual([])

    const flagsFor = (verb: string): (string | undefined)[] =>
      createEvalCommand().commands.find(sub => sub.name() === verb)?.options.map(o => o.long) ?? []
    expect(flagsFor('replay')).toEqual(expect.arrayContaining(['--source']))
    expect(flagsFor('report')).toEqual(expect.arrayContaining(['--source']))
  })
})

// ---- Task 2: the commander family, D-04 rendering purity, D-08 exit codes ---------------------

/** Mirror of cli.ts: the global --config option on the program, eval as a direct child. */
function buildProgram(): Command {
  const program = new Command()
  program.enablePositionalOptions()
  program.option('--config <path>', 'config file path', 'agent-qa.config.yaml')
  program.addCommand(createEvalCommand())
  return program
}

function captureConsole(): { logs: string[]; errors: string[] } {
  const logs: string[] = []
  const errors: string[] = []
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '))
  })
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(' '))
  })
  return { logs, errors }
}

describe('createEvalCommand — family skeleton and registration shape (D-01)', () => {
  it('names the family "eval" with explicit calibration and the existing corpus and gate verbs', () => {
    const cmd = createEvalCommand()
    expect(cmd.name()).toBe('eval')
    const verbs = ['calibrate', 'extract', 'replay', 'seed', 'adversarial', 'report', 'census', 'floor', 'gate', 'replay-gate']
    expect(cmd.commands.map(sub => sub.name())).toEqual(verbs)
  })

  it('declares the D-02 filter vocabulary on extract: --run, --product, --json', () => {
    const extract = createEvalCommand().commands.find(sub => sub.name() === 'extract')
    const flags = extract?.options.map(option => option.long) ?? []
    expect(flags).toEqual(expect.arrayContaining(['--run', '--product', '--json']))
  })

  it('declares the full replay flag vocabulary: --run, --cassette, --product, --judge, --k, --seed, --source, --json', () => {
    const replay = createEvalCommand().commands.find(sub => sub.name() === 'replay')
    const flags = replay?.options.map(option => option.long) ?? []
    expect(flags).toEqual(
      expect.arrayContaining([
        '--run',
        '--cassette',
        '--product',
        '--judge',
        '--k',
        '--seed',
        '--source',
        '--json',
      ]),
    )
  })

  it('declares the seed flag vocabulary: --run, --product, --silver-cap, --json', () => {
    const seed = createEvalCommand().commands.find(sub => sub.name() === 'seed')
    const flags = seed?.options.map(option => option.long) ?? []
    expect(flags).toEqual(
      expect.arrayContaining([
        '--run',
        '--product',
        '--silver-cap',
        // 414 D-07: the two REQUIRED-on-first-partition fraction flags.
        '--held-out-fraction',
        '--private-fraction',
        '--json',
      ]),
    )
  })

  it('declares the report flag vocabulary: --run, --cassette, --product, --commit, --source, --baseline, --json', () => {
    const report = createEvalCommand().commands.find(sub => sub.name() === 'report')
    const flags = report?.options.map(option => option.long) ?? []
    expect(flags).toEqual(
      expect.arrayContaining([
        '--run',
        '--cassette',
        '--product',
        '--commit',
        '--source',
        '--baseline',
        '--json',
      ]),
    )
  })

  it('declares the census flag vocabulary: --commit, --campaign, --json (413 D-13/D-15/D-16)', () => {
    const census = createEvalCommand().commands.find(sub => sub.name() === 'census')
    const flags = census?.options.map(option => option.long) ?? []
    expect(flags).toEqual(expect.arrayContaining(['--commit', '--campaign', '--json']))
  })
})

describe('agent-qa eval seed / report — rendering and exit semantics (372-07, D-04/D-08)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('seed --json emits exactly one JSON DTO on stdout and nothing else (Pitfall 11)', async () => {
    const { dir, configPath } = await writeFixture()
    saveSeedRun(dir, 'run-alpha')
    const { logs, errors } = captureConsole()

    await buildProgram().parseAsync(
      [
        '--config',
        configPath,
        'eval',
        'seed',
        '--held-out-fraction',
        String(TEST_FRACTIONS.heldOutFraction),
        '--private-fraction',
        String(TEST_FRACTIONS.privateFraction),
        '--json',
      ],
      { from: 'user' },
    )

    expect(process.exitCode).not.toBe(1)
    expect(errors).toEqual([])
    expect(logs).toHaveLength(1)
    const dto = JSON.parse(logs[0] ?? '') as SeedVerbResult
    expect(dto.handoffsSeeded).toBe(1)
    expect(dto.seededCount).toBe(1)
    expect(dto.committedRoot).toBe(resolve(dir, 'agent-qa-eval'))
  })

  it('seed renders the human summary from the DTO fields only (D-04)', async () => {
    const { dir, configPath } = await writeFixture()
    saveSeedRun(dir, 'run-alpha')
    const { logs, errors } = captureConsole()

    await buildProgram().parseAsync(
      [
        '--config',
        configPath,
        'eval',
        'seed',
        '--held-out-fraction',
        String(TEST_FRACTIONS.heldOutFraction),
        '--private-fraction',
        String(TEST_FRACTIONS.privateFraction),
      ],
      { from: 'user' },
    )

    expect(process.exitCode).not.toBe(1)
    expect(errors).toEqual([])
    const rendered = logs.join('\n')
    expect(rendered).toContain('1 handoff(s) seeded')
    expect(rendered).toContain('cases: 1 seeded, 0 unchanged')
    expect(rendered).toContain(resolve(dir, 'agent-qa-eval'))
    expect(() => JSON.parse(rendered)).toThrow()
  })

  it('report --json emits exactly one JSON DTO on stdout (Pitfall 11)', async () => {
    const { configPath } = await scoredRecordsFixture()
    const { logs, errors } = captureConsole()

    await buildProgram().parseAsync(['--config', configPath, 'eval', 'report', '--json'], {
      from: 'user',
    })

    expect(process.exitCode).not.toBe(1)
    expect(errors).toEqual([])
    expect(logs).toHaveLength(1)
    const dto = JSON.parse(logs[0] ?? '') as ReportVerbResult
    expect(dto.entries).toBe(2)
    expect(dto.judgeIdentity).toBe('absent')
    expect(dto.report.batchKey).toBe(dto.batchKey)
  })

  it('report --commit exits 0 and renders the committed outcome — unchanged on regeneration (D-08/D-17)', async () => {
    const { configPath } = await scoredRecordsFixture()

    const first = captureConsole()
    await buildProgram().parseAsync(['--config', configPath, 'eval', 'report', '--commit'], {
      from: 'user',
    })
    expect(process.exitCode).not.toBe(1)
    expect(first.logs.join('\n')).toContain('committed: json written, markdown written')
    vi.restoreAllMocks()

    const second = captureConsole()
    await buildProgram().parseAsync(['--config', configPath, 'eval', 'report', '--commit'], {
      from: 'user',
    })
    expect(process.exitCode).not.toBe(1)
    expect(second.logs.join('\n')).toContain('committed: json unchanged, markdown unchanged')
  })

  // ---- 414-07 Task 1 Test 7: the fraction flags are validated in the ACTION (D-07/D-08) -------

  it('a non-numeric --held-out-fraction sets exitCode 1 naming the flag — never process.exit', async () => {
    const { dir, configPath } = await writeFixture()
    saveSeedRun(dir, 'run-alpha')
    const { logs, errors } = captureConsole()
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('process.exit must never be called by the eval family (D-08)')
    }) as never)

    await buildProgram().parseAsync(
      [
        '--config',
        configPath,
        'eval',
        'seed',
        '--held-out-fraction',
        'abc',
        '--private-fraction',
        '0.5',
      ],
      { from: 'user' },
    )

    expect(exitSpy).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
    expect(errors.join('\n')).toContain('--held-out-fraction')
    expect(logs).toEqual([])
    // Nothing was partitioned on the way to the refusal.
    expect(existsSync(join(dir, 'agent-qa-eval', 'contracts', 'partition-default.json'))).toBe(false)
  })

  it('an out-of-range --held-out-fraction sets exitCode 1 from the manifest guard (D-05/D-08)', async () => {
    const { dir, configPath } = await writeFixture()
    saveSeedRun(dir, 'run-alpha')
    const { logs, errors } = captureConsole()
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('process.exit must never be called by the eval family (D-08)')
    }) as never)

    await buildProgram().parseAsync(
      [
        '--config',
        configPath,
        'eval',
        'seed',
        '--held-out-fraction',
        '1.5',
        '--private-fraction',
        '0.5',
      ],
      { from: 'user' },
    )

    expect(exitSpy).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
    // The RANGE is the committed manifest guard's bound, and its TypeError names the flag's own
    // field — one spelling of the bound that governs the bytes, surfaced through the D-08 catch.
    expect(errors.join('\n')).toContain('heldOutFraction')
    expect(logs).toEqual([])
    expect(existsSync(join(dir, 'agent-qa-eval', 'contracts', 'partition-default.json'))).toBe(false)
  })

  it('a valid fraction pair reaches runSeedVerb as NUMBERS and partitions the product (D-07)', async () => {
    const { dir, configPath } = await writeFixture()
    saveSeedRun(dir, 'run-alpha')
    const { logs, errors } = captureConsole()

    await buildProgram().parseAsync(
      [
        '--config',
        configPath,
        'eval',
        'seed',
        '--held-out-fraction',
        '0.25',
        '--private-fraction',
        '0.5',
        '--json',
      ],
      { from: 'user' },
    )

    expect(process.exitCode).not.toBe(1)
    expect(errors).toEqual([])
    const dto = JSON.parse(logs[0] ?? '') as SeedVerbResult
    expect(dto.partitions).toHaveLength(1)
    expect(dto.partitions[0]?.heldOutFraction).toBe(0.25)
    expect(dto.partitions[0]?.privateFraction).toBe(0.5)
    const manifest = guardPartitionManifest(
      JSON.parse(
        await readFile(join(dir, 'agent-qa-eval', 'contracts', 'partition-default.json'), 'utf8'),
      ),
    )
    expect(manifest.heldOutFraction).toBe(0.25)
    expect(manifest.privateFraction).toBe(0.5)
  })
})

describe('agent-qa eval extract — rendering and exit semantics (D-04/D-08)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('--json emits exactly one JSON DTO on stdout and nothing else (Pitfall 11)', async () => {
    const { dir, configPath } = await writeFixture()
    saveRun(dir, 'run-alpha')
    saveRun(dir, 'run-beta', { withCachedStep: true })
    const { logs, errors } = captureConsole()

    await buildProgram().parseAsync(['--config', configPath, 'eval', 'extract', '--json'], {
      from: 'user',
    })

    expect(errors).toEqual([])
    expect(logs).toHaveLength(1)
    const dto = JSON.parse(logs[0] ?? '') as ExtractVerbResult
    expect(dto.runsSwept).toBe(2)
    expect(dto.cassettesWritten).toBe(4)
    expect(dto.completeness).toEqual({ complete: 4, 'cache-hit': 1 })
    expect(process.exitCode).not.toBe(1)
  })

  it('renders the human summary from the same DTO fields without --json (D-04)', async () => {
    const { dir, configPath } = await writeFixture()
    saveRun(dir, 'run-alpha')
    const { logs, errors } = captureConsole()

    await buildProgram().parseAsync(['--config', configPath, 'eval', 'extract'], { from: 'user' })

    expect(errors).toEqual([])
    const rendered = logs.join('\n')
    expect(rendered).toContain('swept 1 run')
    expect(rendered).toContain('cassettes written: 2')
    expect(rendered).toContain('complete=2')
    expect(rendered).toContain(resolve(dir, '.agent-qa', 'eval', 'cassettes'))
    expect(() => JSON.parse(rendered)).toThrow()
  })

  it('a named --run with no handoff sets process.exitCode 1 — the ONLY extract failure (D-08)', async () => {
    const { dir, configPath } = await writeFixture()
    saveRun(dir, 'run-alpha')
    const { logs, errors } = captureConsole()

    await buildProgram().parseAsync(
      ['--config', configPath, 'eval', 'extract', '--run', 'no-such-run'],
      { from: 'user' },
    )

    expect(process.exitCode).toBe(1)
    expect(errors.join('\n')).toContain('no-such-run')
    expect(logs).toEqual([])
  })

  it('an empty sweep is data, not an error: exit 0 with runsSwept 0', async () => {
    const { configPath } = await writeFixture()
    const { logs, errors } = captureConsole()

    await buildProgram().parseAsync(['--config', configPath, 'eval', 'extract', '--json'], {
      from: 'user',
    })

    expect(process.exitCode).not.toBe(1)
    expect(errors).toEqual([])
    const dto = JSON.parse(logs.join('\n')) as ExtractVerbResult
    expect(dto.runsSwept).toBe(0)
    expect(dto.cassettesWritten).toBe(0)
    expect(dto.runsSkipped).toEqual([])
  })

  it('config/session resolution errors map to exit 1 with the message on stderr (D-08)', async () => {
    const dir = await mkdtemp(join(tmpRoot, 'fixture-'))
    const configPath = join(dir, 'agent-qa.config.yaml')
    await writeFile(configPath, CONFIG_YAML)
    // No secrets file: resolveEvalSession throws a typed error naming the path.
    const { errors } = captureConsole()

    await buildProgram().parseAsync(['--config', configPath, 'eval', 'extract'], { from: 'user' })

    expect(process.exitCode).toBe(1)
    expect(errors.join('\n')).toContain('.env.secrets.local')
  })
})

describe('agent-qa eval replay — rendering and exit semantics (372-06, D-04/D-08)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('--json emits exactly one JSON DTO on stdout; an empty sweep is data with batchKey "empty" (Pitfall 11/D-02)', async () => {
    const { configPath } = await writeReplayFixture()
    const { logs } = captureConsole()

    await buildProgram().parseAsync(['--config', configPath, 'eval', 'replay', '--json'], {
      from: 'user',
    })

    expect(process.exitCode).not.toBe(1)
    expect(logs).toHaveLength(1)
    const dto = JSON.parse(logs[0] ?? '') as ReplayVerbResult
    expect(dto.batchKey).toBe('empty')
    expect(dto.swept).toBe(0)
    expect(dto.replayed).toBe(0)
    expect(dto.judge.configured).toBe(false)
    expect(dto.spend).toMatchObject({ modelCalls: 0, promptTokens: 0, completionTokens: 0,
      seed: null, seedHonored: null })
  })

  it('renders the human summary from the DTO fields only, "0 ties" honestly (D-04)', async () => {
    const { configPath } = await writeReplayFixture()
    const { logs, errors } = captureConsole()

    await buildProgram().parseAsync(['--config', configPath, 'eval', 'replay'], { from: 'user' })

    expect(process.exitCode).not.toBe(1)
    expect(errors).toEqual([])
    const rendered = logs.join('\n')
    expect(rendered).toContain('batch empty')
    expect(rendered).toContain('swept 0')
    expect(rendered).toContain('judge: not configured')
    expect(rendered).toContain('0 ties')
    expect(rendered).toMatch(/replay seed=none: decisions=0 modelCalls=0 promptTokens=0 completionTokens=0 wallClock=\d+ms seedHonored=unknown/)
    expect(rendered).toContain('modelCalls includes planner, judge and retries')
    expect(rendered).toContain('planner samples=0, missingUsage=0; judge outcomes=0')
    expect(rendered).toContain(join('.agent-qa', 'eval', 'replays'))
    expect(() => JSON.parse(rendered)).toThrow()
  })

  it('a named --cassette with no staged match sets exitCode 1 (D-08)', async () => {
    const { configPath } = await writeReplayFixture()
    const { logs, errors } = captureConsole()

    await buildProgram().parseAsync(
      ['--config', configPath, 'eval', 'replay', '--cassette', 'no-such-cassette'],
      { from: 'user' },
    )

    expect(process.exitCode).toBe(1)
    expect(errors.join('\n')).toContain('no-such-cassette')
    expect(logs).toEqual([])
  })

  it('a sweep containing only load refusals exits 0 — refusal counters are data, not errors (D-08)', async () => {
    const { dir, configPath } = await writeReplayFixture()
    const corruptDir = join(dir, '.agent-qa', 'eval', 'cassettes', 'corrupt-bundle')
    await mkdir(corruptDir, { recursive: true })
    await writeFile(join(corruptDir, 'cassette.json'), 'not json at all')
    const { logs } = captureConsole()

    await buildProgram().parseAsync(['--config', configPath, 'eval', 'replay', '--json'], {
      from: 'user',
    })

    expect(process.exitCode).not.toBe(1)
    const dto = JSON.parse(logs.join('\n')) as ReplayVerbResult
    expect(dto.swept).toBe(1)
    expect(dto.loadRefusals).toEqual({ 'parse-failed': 1 })
    expect(dto.replayed).toBe(0)
    expect(dto.spend).toMatchObject({ modelCalls: 0, decisions: 0, sampleCount: 0,
      promptTokens: 0, completionTokens: 0, seedHonored: null })
  })
})

// ---- 413-05 Task 1: the deterministic census markdown projection (D-15/D-16) ------------------

/** A fully-populated CorpusCensus DTO: one product, a campaign, one refused cross-check line. */
/**
 * The raw partition salt behind the fixture's `saltDigest`. It exists ONLY so the render cell can
 * assert the markdown does not contain it — the DTO itself never carries a raw salt (T-414-29).
 */
const CENSUS_FIXTURE_SALT = 'a3f'.repeat(21).concat('b')

function censusFixture(): CorpusCensus {
  return {
    schemaVersion: 2,
    corpusDigest: 'a'.repeat(64),
    entryCount: 2,
    products: {
      default: {
        total: 2,
        scorableByTier: { tier1: 2, tier2: 1, tier3: 0 },
        goldEvidence: 1,
        staticScorability: {
          'no-gold-evidence': 1,
          'tier2-anchor': 1,
          'tier3-annotation': 0,
        },
        labelTiers: { gold: 0, 'near-gold': 0, silver: 2 },
        proofCoverage: { numerator: 0, denominator: 2, rate: 0 },
        rungMix: { 'legacy-no-rung': 2 } as CorpusCensus['products'][string]['rungMix'],
        briefContent: { 'empty-brief': 2, 'populated-brief': 0 },
        blobsPresentLocally: { numerator: 2, denominator: 2, rate: 1 },
        missingLabelRecord: 0,
        missingCassette: 0,
        runsSeeded: 1,
        runsExcluded: { environment: 0, flake: 1, timeout: 0 },
        runsExcludedByProducer: { 'analyze-run': 0, 'deterministic-classifier': 1 },
        seededByProducer: {
          'analyze-run': 1,
          'deterministic-classifier': 0,
          'no-verdict': 0,
        },
        repeatCounts: { 'eval-cli::extract-fixture': 2 },
        splits: { natural: 1, heldOutShared: 1, heldOutPrivate: 0, adversarial: 0 },
        fieldCoverage: {
          capturedAt: { numerator: 2, denominator: 2, rate: 1 },
          targetEnvironment: { numerator: 1, denominator: 2, rate: 0.5 },
        },
        exclusions: {
          total: 1,
          byClass: { environment: 0, flake: 1, timeout: 0 },
          byProducer: { 'analyze-run': 0, 'deterministic-classifier': 1 },
        },
      },
    },
    partition: {
      default: {
        saltDigest: createHash('sha256').update(CENSUS_FIXTURE_SALT).digest('hex'),
        heldOutFraction: 0.5,
        privateFraction: 0.5,
        partitionVersion: 1,
      },
    },
    schemaVersionsSeen: { '2': 2 },
    campaign: {
      present: true,
      manifestDigest: 'b'.repeat(64),
      legs: 2,
      runsSeeded: 1,
      runsExcluded: 1,
      modelCalls: 7,
      promptTokens: 1_234,
      completionTokens: 56,
      wallClockMs: 449_000,
    },
    crossCheck: [
      {
        batchKey: '358327d21294f77b91645e3cefde46ad12fe065422757372835447a41865a71e',
        decisionCount: 86,
        corpusCassetteCount: 2,
        membershipComparable: false,
        unscorableIdentityCounts: { 'no-gold-evidence': 41 },
        refusalCounts: {},
        comparator: {
          ok: false,
          refusal: {
            kind: 'same-family-override',
            judgeModelId: 'gpt-5.6-sol',
            judgeFamily: 'openai',
            batchKey: '358327d21294f77b91645e3cefde46ad12fe065422757372835447a41865a71e',
          },
        },
        designatedBy: [],
      },
    ],
  }
}

describe('renderCensusMarkdown — byte-deterministic, counts-only projection (413 D-15/D-16)', () => {
  it('copies marked gold counts and leaves unmarked markdown byte-identical', () => {
    const census = censusFixture()
    const before = renderCensusMarkdown(census)
    expect(before).not.toContain('marked gold:')
    census.products.default!.markedGold = { 'user-mark': 1, 'overturned-verdict': 1 }
    const line = '- marked gold: user-mark 1 · overturned-verdict 1\n\n'
    const rendered = renderCensusMarkdown(census)
    expect(rendered).toContain(line)
    expect(rendered.replace(line, '')).toBe(before)
    census.products.default!.markedGold = { 'user-mark': 37, 'overturned-verdict': 0 }
    expect(renderCensusMarkdown(census)).toContain('marked gold: user-mark 37 · overturned-verdict 0')
  })
  it('renders the same DTO to byte-identical text under the locked section structure', () => {
    const census = censusFixture()

    const first = renderCensusMarkdown(census)
    const second = renderCensusMarkdown(census)

    // Byte-determinism is what makes commitCensus's write-once re-compare meaningful (D-15).
    expect(first).toBe(second)
    expect(first).toContain('# Corpus Census')
    expect(first).toContain('## Provenance')
    expect(first).toContain('## Cross-check')
    // The D-16 triple and the refused comparator both land verbatim from the DTO.
    expect(first).toContain('- scorableByTier: tier1=2 tier2=1 tier3=0')
    expect(first).toContain('comparator=refused:same-family-override')
    // No clock, no locale: nothing in the output can move between two renders of one DTO.
    expect(first).not.toMatch(/\d{4}-\d{2}-\d{2}T/)
  })

  it('states absence honestly and publishes no interpretation for an empty corpus (D-04/D-16)', () => {
    const empty = deriveCensus({
      snapshot: {
        entries: [],
        labelsById: new Map(),
        cassettesById: new Map(),
        blobPresentById: new Map(),
      },
    })

    const rendered = renderCensusMarkdown(empty)

    expect(Object.keys(empty.products)).toEqual([])
    expect(rendered).toContain('## Campaign\n\n- none supplied')
    expect(rendered).toContain('## Cross-check\n\n- none')
    // 414 D-17: an unpartitioned root states its absence rather than printing a fabricated row.
    expect(rendered).toContain('## Partition\n\n- none')
    expect(rendered).toContain('- schemaVersionsSeen:\n  - none')
    // D-16 forbids a percentage, a threshold and a minimum-n claim alike — the census is counts.
    expect(rendered).not.toContain('%')
    expect(rendered).not.toMatch(/\d\s*%/)
    expect(rendered.toLowerCase()).not.toContain('threshold')
    expect(rendered.toLowerCase()).not.toContain('makes no claim')
  })

  it('names the partition, splits, D-04 coverage and exclusions as counts only (414 D-17)', () => {
    const census = censusFixture()

    const first = renderCensusMarkdown(census)
    const second = renderCensusMarkdown(census)
    expect(first).toBe(second)

    // The locked section order: Partition sits immediately after Provenance, before any product.
    expect(first.split('\n').filter(line => line.startsWith('## '))).toEqual([
      '## Provenance',
      '## Partition',
      '## default',
      '## Campaign',
      '## Cross-check',
    ])

    // Provenance names which entry schema versions the committed BYTES still declare.
    expect(first).toContain('- schemaVersionsSeen:\n  - v2: 2')

    // The partition echo: the salt DIGEST and the three re-derivable parameters, nothing else.
    expect(first).toContain(
      `- default: saltDigest=${createHash('sha256').update(CENSUS_FIXTURE_SALT).digest('hex')} `
        + 'heldOutFraction=0.5 privateFraction=0.5 partitionVersion=1',
    )
    // T-414-29: the raw salt is a partition secret and never reaches committed prose.
    expect(first).not.toContain(CENSUS_FIXTURE_SALT)

    // Per product: the four split arms, the two D-04 rates, and the exclusion tallies.
    expect(first).toContain(
      '### Splits\n\n- adversarial: 0\n- heldOutPrivate: 0\n- heldOutShared: 1\n- natural: 1',
    )
    expect(first).toContain(
      '### Field coverage\n\n- capturedAt: 2/2 (rate: 1)\n- targetEnvironment: 1/2 (rate: 0.5)',
    )
    expect(first).toContain('### Exclusions\n\n- total: 1')
    expect(first).toContain('### By class\n\n- environment: 0\n- flake: 1\n- timeout: 0')
    expect(first).toContain('### By producer\n\n- analyze-run: 0\n- deterministic-classifier: 1')

    // D-16 stands over every value this plan added: counts and pairs, never an interpretation.
    expect(first).not.toContain('%')
    expect(first.toLowerCase()).not.toContain('threshold')
    expect(first.toLowerCase()).not.toContain('minimum')
  })
})

// ---- 413-05 Task 2: runCensusVerb — the ONE census pipeline (D-13/D-14/D-15/D-16) -------------

/**
 * Byte-copied from the committed D-18 fixture's `judge` block (the same constant Plan 02's
 * comparator cell carries):
 * demo/init/agent-qa-eval/reports/358327d21294f77b91645e3cefde46ad12fe065422757372835447a41865a71e/report.json
 *
 * The in-place proof against the real file is the Task 3 real-root check; this fixture cell
 * proves the cross-check WIRING, so the two can never drift without one of them reddening.
 */
const FIXTURE_JUDGE_BLOCK: JudgeIdentityBlock = {
  confidenceThreshold: 'high',
  familyOverride: 'same-family-allowed',
  judgeFamily: 'openai',
  judgeModelId: 'gpt-5.6-sol',
  judgeVersion: 1,
}

const FIXTURE_BATCH_KEY = '358327d21294f77b91645e3cefde46ad12fe065422757372835447a41865a71e'
const NO_JUDGE_BATCH_KEY = 'f'.repeat(64)

/** A seeded committed root holding exactly the two fixture cassettes (the census's corpus). */
async function seededCorpusFixture(): Promise<{
  dir: string
  configPath: string
  session: EvalSession
}> {
  const { dir, configPath } = await writeFixture()
  saveSeedRun(dir, 'run-alpha')
  saveSeedRun(dir, 'run-beta')
  const session = await sessionFor(configPath)
  const seeded = await runSeedVerb(session, {}, TEST_FRACTIONS)
  expect(seeded.seededCount).toBe(2)
  return { dir, configPath, session }
}

/** Pure synthetic repeats over fixture cassette identities, serialized with the committed law. */
async function writeFloorFixture(
  fixture: { dir: string; session: EvalSession },
  plannerModelId: string,
  options: { empty?: boolean; classifierRepeatability?: ClassifierRepeatability } = {},
) {
  const committedRoot = join(fixture.dir, 'agent-qa-eval')
  const corpus = readCommittedCorpus(committedRoot)
  const fingerprint = await resolveReplayProfileFingerprint(fixture.session, 'declared')
  const profile = {
    plannerModelId, fingerprint, matcherVersion: 1,
    profileKey: composeBaselineProfileKey({ plannerModelId, fingerprint, matcherVersion: 1 }),
  }
  const vectors: DecisionCorrectnessVector[] = options.empty ? [] : corpus.snapshot.entries.map(
    entry => ({
      key: `${entry.cassetteId}#-#0`, cassetteId: entry.cassetteId,
      decisionOrdinal: 0, product: entry.product, briefSource: 'empty',
      axes: {
        headline: 'correct', elementIdentity: 'correct', opClass: 'correct',
        value: 'not-applicable', sideEffect: 'correct', loop: 'not-applicable',
      },
    }),
  )
  const artefact = foldNoiseFloorArtefact({
    profile, corpusDigest: computeCorpusDigest(corpus.snapshot.entries), partitionVersion: 1,
    seeds: [11, 29], repeats: 3, bootstrapSeed: 19,
    runs: [11, 11, 11, 29].map((seed, index) => ({
      index, seed, vectors, wallClockMs: 10,
      report: buildEvalReport([], undefined, undefined, { declaredSeed: seed }),
    })),
    splitByCassetteId: new Map(corpus.snapshot.entries.map(entry => [entry.cassetteId, 'natural'])),
    censusByProduct: { default: { natural: vectors.length, heldOutShared: 0, heldOutPrivate: 0 } },
    ...(options.classifierRepeatability === undefined
      ? {} : { classifierRepeatability: options.classifierRepeatability }),
  })
  expect(guardNoiseFloorArtefact(artefact).kind).toBe('ok')
  const path = join(committedRoot, 'reports', 'noise-floor', `${slugBranch(profile.profileKey)}.json`)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, committedFileText(artefact))
  return { path, artefact }
}

function classifierDisclosureFixture(): ClassifierRepeatability {
  return foldClassifierRepeatability({
    k: 3,
    runs: [['unknown', 'flake', 'unknown'], ['unknown', 'unknown', 'unknown']].map(classes => ({
      runSlug: generateRunId(), product: 'default',
      sweeps: classes.map(cls => ({
        analysisDigest: createHash('sha256').update(cls).digest('hex'),
        verdicts: [{ class: cls as 'unknown' | 'flake' }],
      })),
    })),
  })
}

describe('runCensusVerb — committed floor disclosure without a census schema change (415 D-14)', () => {
  afterEach(() => vi.restoreAllMocks())

  it('projects every floor sorted by profileKey with measured minima and repeatability rates', async () => {
    const fixture = await seededCorpusFixture()
    const repeatability = classifierDisclosureFixture()
    expect(repeatability).toMatchObject({ n: 2, k: 3, classFlipRate: 0.5, admitExcludeFlipRate: 0.5 })
    const z = await writeFloorFixture(fixture, 'z-planner')
    const a = await writeFloorFixture(fixture, 'a-planner', { classifierRepeatability: repeatability })
    expect(a.artefact.minimumGateSet.value).toBeGreaterThanOrEqual(3)
    const before = await snapshotTree(dirname(a.path))
    const result = await runCensusVerb(fixture.session)
    expect(result).toHaveProperty('noiseFloor', [
      {
        profileKey: a.artefact.profileKey, path: a.path,
        minimumGateSet: a.artefact.minimumGateSet.value,
        minimumGateSetDerivation: a.artefact.minimumGateSet.derivation,
        classifierRepeatability: { n: 2, k: 3, classFlipRate: 0.5, admitExcludeFlipRate: 0.5 },
      },
      {
        profileKey: z.artefact.profileKey, path: z.path,
        minimumGateSet: z.artefact.minimumGateSet.value,
        minimumGateSetDerivation: z.artefact.minimumGateSet.derivation,
      },
    ])
    const { logs, errors } = captureConsole()
    await buildProgram().parseAsync(['--config', fixture.configPath, 'eval', 'census'], { from: 'user' })
    expect(errors).toEqual([])
    expect(logs.filter(line => line.startsWith('floor '))).toEqual([
      `floor ${a.artefact.profileKey}: minimumGateSet=${a.artefact.minimumGateSet.value} `
        + 'classifierRepeatability=n:2 k:3 classFlipRate=0.5 admitExcludeFlipRate=0.5',
      `floor ${z.artefact.profileKey}: minimumGateSet=${z.artefact.minimumGateSet.value} `
        + 'classifierRepeatability=undefined',
    ])
    expect(await snapshotTree(dirname(a.path))).toEqual(before)
  })

  it('retains the actual missing-minimum derivation and undefined rates instead of inventing zeroes', async () => {
    const fixture = await seededCorpusFixture()
    const floor = await writeFloorFixture(fixture, 'empty-planner', {
      empty: true, classifierRepeatability: foldClassifierRepeatability({ k: 3, runs: [] }),
    })
    expect(floor.artefact.minimumGateSet).not.toHaveProperty('value')
    const result = await runCensusVerb(fixture.session)
    expect(result).toHaveProperty('noiseFloor', [{
      profileKey: floor.artefact.profileKey, path: floor.path,
      minimumGateSetDerivation: floor.artefact.minimumGateSet.derivation,
      classifierRepeatability: { n: 0, k: 3 },
    }])
    const { logs, errors } = captureConsole()
    await buildProgram().parseAsync(['--config', fixture.configPath, 'eval', 'census'], { from: 'user' })
    expect(errors).toEqual([])
    expect(logs).toContain(
      `floor ${floor.artefact.profileKey}: minimumGateSet=undefined (${floor.artefact.minimumGateSet.derivation}) `
        + 'classifierRepeatability=n:0 k:3 classFlipRate=undefined admitExcludeFlipRate=undefined',
    )
  })

  it('omits the floor field and all console floor lines when no artefact exists', async () => {
    const fixture = await seededCorpusFixture()
    expect(await runCensusVerb(fixture.session)).not.toHaveProperty('noiseFloor')
    const { logs } = captureConsole()
    await buildProgram().parseAsync(['--config', fixture.configPath, 'eval', 'census'], { from: 'user' })
    expect(logs.some(line => line.startsWith('floor '))).toBe(false)
  })

  it('turns floor read refusals into named notices alongside valid artefacts', async () => {
    const fixture = await seededCorpusFixture()
    const floor = await writeFloorFixture(fixture, 'valid-planner')
    const broken = join(dirname(floor.path), 'broken.json')
    const stray = join(dirname(dirname(floor.path)), 'noise-floor.json')
    await writeFile(broken, '{')
    await writeFile(stray, committedFileText(floor.artefact))
    const result = await runCensusVerb(fixture.session)
    for (const path of [broken, stray]) {
      expect(result.notices.some(notice => notice.startsWith(`committed read refused ${path}:`))).toBe(true)
    }
    expect(result).toHaveProperty('noiseFloor.0.profileKey', floor.artefact.profileKey)
  })

  it('preserves committed census JSON and markdown byte-for-byte after a floor is added', async () => {
    const fixture = await seededCorpusFixture()
    const first = await runCensusVerb(fixture.session, { commit: true })
    expect(first.committed?.kind).toBe('committed')
    const censusDir = join(fixture.dir, 'agent-qa-eval', 'reports', 'census', first.corpusDigest)
    const before = await snapshotTree(censusDir)
    await writeFloorFixture(fixture, 'measured-planner', { classifierRepeatability: classifierDisclosureFixture() })
    const second = await runCensusVerb(fixture.session, { commit: true })
    expect(second).toHaveProperty('noiseFloor')
    expect(second.census).toEqual(first.census)
    expect(second.committed).toMatchObject({ kind: 'committed', json: 'unchanged', markdown: 'unchanged' })
    expect(await snapshotTree(censusDir)).toEqual(before)
  })
})

/** Commit one report into the fixture committed root under an explicit batchKey. */
function commitFixtureReport(
  dir: string,
  batchKey: string,
  judge: JudgeIdentityBlock | undefined,
): void {
  const report = { ...buildEvalReport([], judge), batchKey }
  const outcome = commitEvalReport({
    report,
    markdown: `# fixture report ${batchKey}\n`,
    committedRoot: resolve(dir, 'agent-qa-eval'),
  })
  expect(outcome.kind).toBe('committed')
}

function campaignManifest(): unknown {
  return {
    schemaVersion: CAMPAIGN_MANIFEST_SCHEMA_VERSION,
    phase: '413',
    submoduleHead: 'c'.repeat(40),
    legs: [
      {
        testId: 'growth::alpha',
        testFile: 'tests/growth-alpha.yaml',
        product: 'default',
        runSlug: 'run-growth-alpha',
        repeat: 0,
        exitCode: 0,
        aggregateVerdict: 'passed',
        verdicts: [{ class: 'unknown', producer: 'analyze-run' }],
        excluded: false,
        seeded: true,
        wallClockMs: 54_000,
        modelCalls: 4,
        promptTokens: 900,
        completionTokens: 40,
        steps: 3,
        proofSteps: 3,
      },
      {
        testId: 'growth::beta',
        testFile: 'tests/growth-beta.yaml',
        product: 'default',
        runSlug: 'run-growth-beta',
        repeat: 0,
        exitCode: 1,
        aggregateVerdict: 'failed',
        verdicts: [{ class: 'flake', producer: 'deterministic-classifier' }],
        excluded: true,
        seeded: false,
        wallClockMs: 449_000,
        modelCalls: 3,
        promptTokens: 334,
        completionTokens: 16,
        steps: 2,
        proofSteps: 0,
      },
    ],
  }
}

describe('runCensusVerb — static census over the committed root (413 D-13/D-14/D-15/D-16)', () => {
  it('derives the per-product triple from a legacy-shaped committed root with no campaign', async () => {
    const { dir, session } = await seededCorpusFixture()

    const result = await runCensusVerb(session)

    expect(result.entryCount).toBe(2)
    expect(result.census.entryCount).toBe(2)
    expect(result.census.products.default?.total).toBe(2)
    // Proof coverage denominator is the loaded-cassette count; the fixture briefs carry no proof.
    expect(result.census.products.default?.proofCoverage.denominator).toBe(2)
    expect(result.census.products.default?.proofCoverage.numerator).toBe(0)
    // The fixture handoff carries no retrieval rung — counted as legacy, never folded away (D-07).
    expect(result.census.products.default?.rungMix['legacy-no-rung']).toBe(2)
    expect(result.census.crossCheck).toEqual([])
    expect(result.census.campaign).toEqual({ present: false })
    expect(result.committed).toBeUndefined()
    // The digest NAMES the corpus the census was derived from (D-15).
    const read = readCommittedCorpus(resolve(dir, 'agent-qa-eval'))
    expect(result.corpusDigest).toBe(computeCorpusDigest(read.snapshot.entries))
    expect(result.census.corpusDigest).toBe(result.corpusDigest)
    expect(result.productsSeen).toContain('default')
  })

  it('cross-checks EVERY committed report and prints the same-family refusal (D-18/D-20, SC3)', async () => {
    const { dir, session } = await seededCorpusFixture()
    commitFixtureReport(dir, FIXTURE_BATCH_KEY, FIXTURE_JUDGE_BLOCK)
    commitFixtureReport(dir, NO_JUDGE_BATCH_KEY, undefined)

    const result = await runCensusVerb(session)

    const lines = result.census.crossCheck
    expect(lines.map(line => line.batchKey)).toEqual([FIXTURE_BATCH_KEY, NO_JUDGE_BATCH_KEY])
    for (const line of lines) {
      // RESEARCH F7: a report carries a batchKey, never its cassette-id list — the two
      // populations are PRINTED side by side and never asserted equal.
      expect(line.membershipComparable).toBe(false)
      expect(line.corpusCassetteCount).toBe(2)
      expect(line.designatedBy).toEqual([])
    }
    const sameFamily = lines[0]!
    expect(sameFamily.comparator.ok).toBe(false)
    expect(sameFamily.comparator.ok === false && sameFamily.comparator.refusal.judgeModelId).toBe(
      'gpt-5.6-sol',
    )
    expect(lines[1]!.comparator).toEqual({ ok: true })

    // The refusal and BOTH reconciliation lines are visible notices — never a silent omission.
    expect(
      result.notices.some(notice => notice.startsWith('baseline comparator refused: same-family-override')),
    ).toBe(true)
    for (const batchKey of [FIXTURE_BATCH_KEY, NO_JUDGE_BATCH_KEY]) {
      expect(result.notices).toContain(
        `cross-check ${batchKey}: report decisions 0 vs corpus cassettes 2 `
          + '— batch membership differs (batchKey only)',
      )
    }

    // A committed pointer naming a report designates it (D-19); the census states who.
    const baselinesDir = join(dir, 'agent-qa-eval', 'reports', 'baselines')
    await mkdir(baselinesDir, { recursive: true })
    await writeFile(
      join(baselinesDir, 'fixture-profile.json'),
      `${JSON.stringify(
        {
          schemaVersion: BASELINE_POINTER_SCHEMA_VERSION,
          profileKey: 'fixture-profile',
          batchKey: NO_JUDGE_BATCH_KEY,
          fingerprint: 'fixture-fingerprint',
          corpusDigest: 'fixture-corpus',
        },
        null,
        2,
      )}\n`,
    )

    const designated = await runCensusVerb(session)
    const designatedLine = designated.census.crossCheck.find(
      line => line.batchKey === NO_JUDGE_BATCH_KEY,
    )!
    expect(designatedLine.designatedBy).toEqual(['fixture-profile'])
  })

  it('folds a guarded --campaign manifest and rejects a widened one as a typed error (D-16)', async () => {
    const { dir, session } = await seededCorpusFixture()
    const manifestPath = join(dir, 'campaign.json')
    await writeFile(manifestPath, `${JSON.stringify(campaignManifest(), null, 2)}\n`)

    const result = await runCensusVerb(session, { campaign: manifestPath })

    expect(result.campaignManifest).toBe(manifestPath)
    const campaign = result.census.campaign
    expect(campaign.present).toBe(true)
    expect(campaign.present === true && campaign.legs).toBe(2)
    expect(campaign.present === true && campaign.runsSeeded).toBe(1)
    expect(campaign.present === true && campaign.runsExcluded).toBe(1)
    expect(campaign.present === true && campaign.modelCalls).toBe(7)
    const block = result.census.products.default!
    expect(block.runsExcluded.flake).toBe(1)
    expect(block.runsExcludedByProducer['deterministic-classifier']).toBe(1)
    expect(block.runsSeeded).toBe(1)
    expect(block.repeatCounts['growth::alpha']).toBe(1)
    expect(block.repeatCounts['growth::beta']).toBe(1)

    // T-413-21: a widened manifest is a TypeError, never a silently dropped tally.
    const widened = { ...(campaignManifest() as Record<string, unknown>), smuggled: true }
    const widenedPath = join(dir, 'campaign-widened.json')
    await writeFile(widenedPath, `${JSON.stringify(widened, null, 2)}\n`)
    await expect(runCensusVerb(session, { campaign: widenedPath })).rejects.toThrow(
      /^campaign manifest rejected:/,
    )
  })

  it('--commit writes census.json + census.md once and reports unchanged on re-derivation (D-15)', async () => {
    const { dir, session } = await seededCorpusFixture()

    const first = await runCensusVerb(session, { commit: true })

    expect(first.committed?.kind).toBe('committed')
    expect(first.committed).toMatchObject({ json: 'written', markdown: 'written' })
    const censusDir = join(
      dir,
      'agent-qa-eval',
      'reports',
      'census',
      slugBranch(first.corpusDigest),
    )
    expect(existsSync(join(censusDir, 'census.json'))).toBe(true)
    expect(existsSync(join(censusDir, 'census.md'))).toBe(true)
    // census.json is eval core's ONE serializer over the DTO — nothing re-serialises it here.
    expect(await readFile(join(censusDir, 'census.json'), 'utf-8')).toBe(
      committedFileText(first.census),
    )

    const second = await runCensusVerb(session, { commit: true })
    expect(second.committed).toMatchObject({ json: 'unchanged', markdown: 'unchanged' })
    expect(second.corpusDigest).toBe(first.corpusDigest)
  })

  it('folds committed manifests, exclusions and schemaVersionsSeen, refusing a broken document by path (414 D-02/D-05/D-17)', async () => {
    const { dir, session } = await seededCorpusFixture()
    const committedRoot = resolve(dir, 'agent-qa-eval')

    // Plant an analysis that makes run-alpha a flake; the re-seed's phase (A) commits its record.
    await saveAnalysis(
      dir,
      'run-alpha',
      `${JSON.stringify(
        analysisArtifactFixture('run-alpha', { class: 'flake', producer: 'analyze-run' }),
        null,
        2,
      )}\n`,
    )
    const reseeded = await runSeedVerb(session)
    expect(reseeded.exclusionsWritten).toHaveLength(1)

    const result = await runCensusVerb(session)

    const manifest = guardPartitionManifest(
      JSON.parse(await readFile(join(committedRoot, 'contracts', 'partition-default.json'), 'utf8')),
    )
    expect(result.census.partition.default).toEqual({
      saltDigest: createHash('sha256').update(manifest.salt).digest('hex'),
      heldOutFraction: TEST_FRACTIONS.heldOutFraction,
      privateFraction: TEST_FRACTIONS.privateFraction,
      partitionVersion: 1,
    })
    expect(result.census.partition.default?.saltDigest).toMatch(/^[0-9a-f]{64}$/)
    // T-414-29: only the digest may leave the manifest file, in the DTO as in the markdown.
    expect(JSON.stringify(result)).not.toContain(manifest.salt)

    expect(result.census.products.default?.exclusions).toEqual({
      total: 1,
      byClass: { environment: 0, flake: 1, timeout: 0 },
      byProducer: { 'analyze-run': 1, 'deterministic-classifier': 0 },
    })
    // Every seeded entry is v2, so the byte-version census names exactly that.
    expect(result.census.schemaVersionsSeen).toEqual({ '2': 2 })
    expect(result.census.products.default?.splits).toEqual(
      countGateSet(readCommittedCorpus(committedRoot).snapshot.entries),
    )

    // T-414-41: a refused manifest or exclusion is NAMED, never silently missing from the counts.
    await writeFile(join(committedRoot, 'contracts', 'partition-broken.json'), '{ not json')
    await writeFile(join(committedRoot, 'exclusions', 'default', 'broken.json'), '{ not json')

    const refused = await runCensusVerb(session)
    for (const suffix of [
      join('contracts', 'partition-broken.json'),
      join('exclusions', 'default', 'broken.json'),
    ]) {
      expect(
        refused.notices.some(
          notice => notice.startsWith('committed read refused ') && notice.includes(suffix),
        ),
      ).toBe(true)
    }
    // The refusal changed no count: the partition echo and the exclusion tally are untouched.
    expect(refused.census.partition).toEqual(result.census.partition)
    expect(refused.census.products.default?.exclusions.total).toBe(1)
  })
})

// ---- 413-05 Task 3: the census subcommand — rendering and exit semantics (D-04/D-08) ----------

describe('agent-qa eval census — rendering and exit semantics (413-05, D-04/D-08)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('--json emits exactly one JSON DTO on stdout and nothing else (Pitfall 11)', async () => {
    const { dir, configPath } = await writeFixture()
    saveSeedRun(dir, 'run-alpha')
    const session = await sessionFor(configPath)
    await runSeedVerb(session, {}, TEST_FRACTIONS)
    const { logs, errors } = captureConsole()

    await buildProgram().parseAsync(['--config', configPath, 'eval', 'census', '--json'], {
      from: 'user',
    })

    expect(process.exitCode).not.toBe(1)
    expect(errors).toEqual([])
    expect(logs).toHaveLength(1)
    const dto = JSON.parse(logs[0] ?? '') as CensusVerbResult
    expect(dto.corpusDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(dto.entryCount).toBe(1)
    expect(dto.census.corpusDigest).toBe(dto.corpusDigest)
  })

  it('renders the per-product line and the honest campaign absence from the DTO only (D-04)', async () => {
    const { dir, configPath } = await writeFixture()
    saveSeedRun(dir, 'run-alpha')
    const session = await sessionFor(configPath)
    await runSeedVerb(session, {}, TEST_FRACTIONS)
    const { logs, errors } = captureConsole()

    await buildProgram().parseAsync(['--config', configPath, 'eval', 'census'], { from: 'user' })

    expect(process.exitCode).not.toBe(1)
    expect(errors).toEqual([])
    const rendered = logs.join('\n')
    expect(rendered).toContain('default: total=1')
    expect(rendered).toContain('campaign: none supplied')
    expect(rendered).toContain('rungs=legacy-no-rung=1')
    expect(() => JSON.parse(rendered)).toThrow()
  })

  it('a --campaign path that names nothing sets exitCode 1 with the message on stderr (D-08)', async () => {
    const { dir, configPath } = await writeFixture()
    saveSeedRun(dir, 'run-alpha')
    const session = await sessionFor(configPath)
    await runSeedVerb(session, {}, TEST_FRACTIONS)
    const { logs, errors } = captureConsole()

    await buildProgram().parseAsync(
      ['--config', configPath, 'eval', 'census', '--campaign', join(dir, 'no-such-campaign.json')],
      { from: 'user' },
    )

    expect(process.exitCode).toBe(1)
    expect(errors.join('\n')).toContain('no-such-campaign.json')
    expect(logs).toEqual([])
  })
})

// ---- 413-06 Task 3: report --commit --baseline — the refusing per-profile pointer (D-19/D-20) --

/**
 * The D-19 profile key composed from what the report already stamps. The fixture registry entry
 * named by `use.llm` resolves to this model id, the matcher constitution is version 1, and an
 * abstention batch carries NO judge block — which gets its OWN key rather than sharing a judged
 * profile's slot, because a no-judge measurement is a different measurement, not a missing one.
 */
const BASELINE_PLANNER_MODEL_ID = 'gpt-4o'

/** Existing committed history, with no replay records and no invented run receipt. */
async function committedReportFixture(judge?: JudgeIdentityBlock) {
  const fixture = await seededCorpusFixture()
  const committedRoot = join(fixture.dir, 'agent-qa-eval')
  const corpus = readCommittedCorpus(committedRoot)
  const batchKey = computeBatchKey(corpus.snapshot.entries.map(entry => entry.cassetteId))
  commitFixtureReport(fixture.dir, batchKey, judge)
  return {
    ...fixture, batchKey, committedRoot,
    reportFile: join(committedRoot, 'reports', batchKey, 'report.json'),
  }
}

describe('runReportVerb --from-committed — reviewed designation without replay assembly (415 D-11)', () => {
  afterEach(() => vi.restoreAllMocks())

  it('writes then reports unchanged with the declared fingerprint and preserves all historical bytes', async () => {
    const { dir, session, batchKey, reportFile, committedRoot } = await committedReportFixture()
    const reportBefore = await readFile(reportFile, 'utf8')
    const reportsBefore = await snapshotTree(join(committedRoot, 'reports', batchKey))
    const corpus = readCommittedCorpus(committedRoot)
    const evalLocal = await import('@vostride/agent-qa-eval-local')
    const assemble = vi.spyOn(evalLocal, 'assembleScoredBatch').mockImplementation(() => {
      throw new Error('committed designation must never read replays')
    })
    expect(existsSync(join(dir, '.agent-qa', 'eval', 'replays'))).toBe(false)
    const options = { baseline: true, fromCommitted: batchKey, seedPolicy: 'declared' as const }
    const first = await runReportVerb(session, {}, options)
    const profileKey = await baselineProfileKey(session, 'declared')
    const pointerPath = `reports/baselines/${slugBranch(profileKey)}.json`
    expect(first).toMatchObject({
      batchKey, entries: 0, source: 'committed', judgeIdentity: 'absent',
      profileKey, committedFile: reportFile,
      baseline: { kind: 'written', path: pointerPath },
    })
    expect(first).not.toHaveProperty('committed')
    expect(first).not.toHaveProperty('stagedFile')
    expect(first.report).toEqual(JSON.parse(reportBefore))
    expect(first.report).not.toHaveProperty('runIdentity')
    expect(JSON.parse(await readFile(join(committedRoot, pointerPath), 'utf8'))).toEqual({
      schemaVersion: 2, profileKey, batchKey, plannerModelId: BASELINE_PLANNER_MODEL_ID,
      matcherVersion: first.report.matcherVersion,
      fingerprint: await resolveReplayProfileFingerprint(session, 'declared'),
      corpusDigest: computeCorpusDigest(corpus.snapshot.entries),
    })
    const second = await runReportVerb(session, {}, options)
    expect(second.baseline).toEqual({ kind: 'unchanged', path: pointerPath })
    expect(assemble).not.toHaveBeenCalled()
    expect(await readFile(reportFile, 'utf8')).toBe(reportBefore)
    expect(await snapshotTree(join(committedRoot, 'reports', batchKey))).toEqual(reportsBefore)
    expect(existsSync(join(dir, '.agent-qa', 'eval', 'reports'))).toBe(false)
  })

  it('uses the explicit seed policy and override names without resolving auth or creating a model', async () => {
    const { session, batchKey } = await committedReportFixture()
    session.evalConfig.seed = 29
    const llmUtils = await import('../../llm-utils.js')
    const model = await import('@vostride/agent-qa-model')
    const auth = vi.spyOn(llmUtils, 'resolveModelAuth').mockRejectedValue(new Error('auth forbidden'))
    const create = vi.spyOn(model, 'createModel').mockImplementation(() => {
      throw new Error('model creation forbidden')
    })
    const stub = replayStub(BASELINE_PLANNER_MODEL_ID)
    const options = {
      baseline: true, fromCommitted: batchKey, seedPolicy: 'none' as const,
      plannerOverrides: stub.overrides,
    }
    const result = await runReportVerb(session, {}, options)
    expect(result.profileKey).toBe(composeBaselineProfileKey({
      plannerModelId: BASELINE_PLANNER_MODEL_ID,
      fingerprint: await resolveReplayProfileFingerprint(session, 'none', stub.overrides),
      matcherVersion: result.report.matcherVersion,
    }))
    expect(result.notices.join('\n')).toContain('re-designate with eval report --baseline --from-committed <batchKey> --seed-policy declared')
    expect(auth).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
    expect(stub.captured).toEqual([])
  })

  it.each(['same-family-override', 'mixed-judge-identity'] as const)(
    'refuses %s through the comparator without writing a pointer or rewriting history',
    async kind => {
      const { session, batchKey, reportFile, committedRoot } = await committedReportFixture(
        kind === 'same-family-override' ? FIXTURE_JUDGE_BLOCK : undefined,
      )
      if (kind === 'mixed-judge-identity') {
        const report = JSON.parse(await readFile(reportFile, 'utf8'))
        await writeFile(reportFile, committedFileText({
          ...report, judgeIdentity: 'mixed', mixedJudgeModelIds: ['judge-a', 'judge-b'],
        }))
      }
      const before = await readFile(reportFile, 'utf8')
      const options = { baseline: true, fromCommitted: batchKey, seedPolicy: 'declared' as const }
      const result = await runReportVerb(session, {}, options)
      expect(result.baseline).toMatchObject({ kind: 'refused', refusal: { kind } })
      expect(result.judgeIdentity).toBe(kind === 'same-family-override' ? 'present' : 'mixed')
      expect(result.notices.join('\n')).toContain(`baseline comparator refused: ${kind}`)
      expect(existsSync(join(committedRoot, 'reports', 'baselines'))).toBe(false)
      expect(await readFile(reportFile, 'utf8')).toBe(before)
    },
  )

  it('returns write-conflict when another batch is already designated under the same profile', async () => {
    const { session, batchKey, committedRoot } = await committedReportFixture()
    const options = { baseline: true, fromCommitted: batchKey, seedPolicy: 'declared' as const }
    const first = await runReportVerb(session, {}, options)
    expect(first.baseline?.kind).toBe('written')
    const otherReport = buildEvalReport([])
    const outcome = commitEvalReport({
      report: otherReport, markdown: '# other committed fixture\n', committedRoot,
    })
    expect(outcome.kind).toBe('committed')
    const pointerPath = `reports/baselines/${slugBranch(first.profileKey!)}.json`
    const before = await readFile(join(committedRoot, pointerPath), 'utf8')
    const conflict = await runReportVerb(session, {}, { ...options, fromCommitted: otherReport.batchKey })
    expect(conflict.baseline).toEqual({ kind: 'write-conflict', path: pointerPath })
    expect(await readFile(join(committedRoot, pointerPath), 'utf8')).toBe(before)
  })

  it.each([
    [{ fromCommitted: computeBatchKey([]), seedPolicy: 'declared' as const }, /--from-committed requires --baseline/],
    [{ fromCommitted: computeBatchKey([]), baseline: true }, /--from-committed requires --seed-policy/],
    [{ fromCommitted: computeBatchKey([]), baseline: true, seedPolicy: 'declared' as const, commit: true }, /--from-committed.*--commit/],
  ])('refuses invalid flag combinations before any session read: %j', async (options, message) => {
    const session = Object.defineProperty({}, 'configDir', {
      get: () => { throw new Error('session read before precondition') },
    }) as EvalSession
    await expect(runReportVerb(session, {}, options)).rejects.toThrow(message)
  })

  it('names an unknown committed batch in a typed named-input error', async () => {
    const { session, committedRoot } = await committedReportFixture()
    const missing = computeBatchKey([])
    const options = { baseline: true, fromCommitted: missing, seedPolicy: 'declared' as const }
    await expect(runReportVerb(session, {}, options)).rejects.toMatchObject({
      name: 'EvalNamedInputError', inputKind: 'batchKey', inputName: missing,
      searchRoot: join(committedRoot, 'reports'),
    })
    expect(existsSync(join(committedRoot, 'reports', 'baselines'))).toBe(false)
  })

  it.each(['../reports', '', 'not-a-batch-key'])(
    'rejects invalid requested batch key %j before any read', async fromCommitted => {
      const session = Object.defineProperty({}, 'configDir', {
        get: () => { throw new Error('session read before batch key validation') },
      }) as EvalSession
      const options = { baseline: true, fromCommitted, seedPolicy: 'declared' as const }
      await expect(runReportVerb(session, {}, options)).rejects.toThrow(/--from-committed.*batchKey/)
    },
  )

  it.each(['body-mismatch', 'malformed-judge'])(
    'names the requested file on %s and writes no pointer', async malformed => {
      const { session, batchKey, reportFile, committedRoot } = await committedReportFixture()
      const report = JSON.parse(await readFile(reportFile, 'utf8'))
      if (malformed === 'body-mismatch') report.batchKey = computeBatchKey([])
      else report.mixedJudgeModelIds = 'not-an-array'
      await writeFile(reportFile, committedFileText(report))
      const before = await readFile(reportFile, 'utf8')
      const options = { baseline: true, fromCommitted: batchKey, seedPolicy: 'declared' as const }
      await expect(runReportVerb(session, {}, options)).rejects.toThrow(reportFile)
      await expect(runReportVerb(session, {}, options)).rejects.toThrow(batchKey)
      expect(existsSync(join(committedRoot, 'reports', 'baselines'))).toBe(false)
      expect(await readFile(reportFile, 'utf8')).toBe(before)
    },
  )

  it('wires both report flags through Commander and emits one JSON DTO', async () => {
    const { configPath, batchKey, reportFile } = await committedReportFixture()
    const { logs, errors } = captureConsole()
    expect(createEvalCommand().commands.find(command => command.name() === 'report')!
      .options.map(option => option.flags)).toContain('--from-committed <batchKey>')
    await buildProgram().parseAsync([
      '--config', configPath, 'eval', 'report', '--baseline',
      '--from-committed', batchKey, '--seed-policy', 'declared', '--json',
    ], { from: 'user' })
    expect(process.exitCode).not.toBe(1)
    expect(errors).toEqual([])
    expect(logs).toHaveLength(1)
    expect(JSON.parse(logs[0]!)).toMatchObject({
      batchKey, committedFile: reportFile, baseline: { kind: 'written' }, source: 'committed',
    })
  })

  it('maps an invalid --seed-policy to the typed parser message and exitCode 1', async () => {
    const { logs, errors } = captureConsole()
    expect(createEvalCommand().commands.find(command => command.name() === 'report')!
      .options.map(option => option.flags)).toContain('--seed-policy <none|declared>')
    await buildProgram().parseAsync([
      '--config', join(tmpRoot, 'absent-config.yaml'), 'eval', 'report',
      '--baseline', '--from-committed', computeBatchKey([]), '--seed-policy', 'random',
    ], { from: 'user' })
    expect(process.exitCode).toBe(1)
    expect(errors.join('\n')).toContain('--seed-policy must be "none" or "declared", got "random"')
    expect(logs).toEqual([])
  })
})

async function baselineProfileKey(session: EvalSession, seedPolicy: SeedPolicy = 'none'): Promise<string> {
  return composeBaselineProfileKey({
    plannerModelId: BASELINE_PLANNER_MODEL_ID,
    fingerprint: await resolveReplayProfileFingerprint(session, seedPolicy),
    matcherVersion: 1,
  })
}

describe('runReportVerb — console decisions and baseline outcomes (415 D-11/D-14)', () => {
  afterEach(() => vi.restoreAllMocks())

  it('prints the projected vector count and profile key for written then unchanged parts', async () => {
    const { dir, configPath, session, ids } = await scoredRecordsFixture(BASELINE_PLANNER_MODEL_ID)
    const batchKey = computeBatchKey(ids)
    const profileKey = await baselineProfileKey(session)
    const { logs, errors } = captureConsole()
    const args = ['--config', configPath, 'eval', 'report', '--commit', '--baseline']
    await buildProgram().parseAsync(args, { from: 'user' })
    const document = JSON.parse(await readFile(
      join(dir, 'agent-qa-eval', 'reports', batchKey, 'decisions.json'), 'utf8',
    ))
    expect(document.vectors.length).toBeGreaterThan(0)
    expect(logs).toContain(`decisions: ${document.vectors.length} vectors (written)`)
    expect(logs).toContain(`baseline: ${profileKey} (written)`)
    logs.length = 0
    await buildProgram().parseAsync(args, { from: 'user' })
    expect(logs).toContain(`decisions: ${document.vectors.length} vectors (unchanged)`)
    expect(logs).toContain(`baseline: ${profileKey} (unchanged)`)
    expect(errors).toEqual([])
  })

  it('prints zero vectors for an all-refusal commit', async () => {
    const { dir, configPath, ids } = await scoredRecordsFixture()
    const store = new FsReplayRecordStore({ root: join(dir, '.agent-qa') })
    for (const cassetteId of ids) {
      store.save({ kind: 'integrity-refusal', cassetteId, reason: 'missing-blob', detail: 'fixture' })
    }
    const { logs, errors } = captureConsole()
    await buildProgram().parseAsync(['--config', configPath, 'eval', 'report', '--commit'], { from: 'user' })
    expect(logs).toContain('decisions: 0 vectors (written)')
    expect(errors).toEqual([])
  })

  it('names the committed read and refused key while keeping comparator details visible', async () => {
    const { configPath, session, batchKey, reportFile } = await committedReportFixture(FIXTURE_JUDGE_BLOCK)
    const options = { baseline: true, fromCommitted: batchKey, seedPolicy: 'declared' as const }
    const result = await runReportVerb(session, {}, options)
    expect(result.baseline?.kind).toBe('refused')
    const { logs, errors } = captureConsole()
    await buildProgram().parseAsync([
      '--config', configPath, 'eval', 'report', '--baseline',
      '--from-committed', batchKey, '--seed-policy', 'declared',
    ], { from: 'user' })
    expect(logs).toContain(`baseline: ${result.profileKey} (refused)`)
    expect(logs.join('\n')).toContain('baseline comparator refused: same-family-override')
    expect(logs.join('\n')).toContain(`committed file: ${reportFile}`)
    expect(logs.join('\n')).toContain('(committed report)')
    expect(logs.join('\n')).not.toContain('(0 entries)')
    expect(logs.join('\n')).not.toContain('staged file:')
    expect(logs.some(line => line.startsWith('decisions:'))).toBe(false)
    expect(errors).toEqual([])
  })

  it('prints the profile key and conflict path when a committed designation already names another batch', async () => {
    const { configPath, session, dir, batchKey } = await committedReportFixture()
    const options = { baseline: true, fromCommitted: batchKey, seedPolicy: 'declared' as const }
    const first = await runReportVerb(session, {}, options)
    expect(first.baseline?.kind).toBe('written')
    const otherBatchKey = computeBatchKey([])
    commitFixtureReport(dir, otherBatchKey, undefined)
    const { logs, errors } = captureConsole()
    await buildProgram().parseAsync([
      '--config', configPath, 'eval', 'report', '--baseline',
      '--from-committed', otherBatchKey, '--seed-policy', 'declared',
    ], { from: 'user' })
    expect(logs).toContain(`baseline: ${first.profileKey} (write-conflict)`)
    expect(logs.join('\n')).toContain(`reports/baselines/${slugBranch(first.profileKey!)}.json`)
    expect(errors).toEqual([])
  })
})

describe('resolveReplayProfileFingerprint — credential-free profile identity (415 D-11)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('matches the shared helper for the named config without auth resolution or model creation', async () => {
    const { configPath } = await writeReplayFixture()
    const session = await sessionFor(configPath)
    const llmUtils = await import('../../llm-utils.js')
    const model = await import('@vostride/agent-qa-model')
    const auth = vi.spyOn(llmUtils, 'resolveModelAuth').mockRejectedValue(new Error('auth forbidden'))
    const create = vi.spyOn(model, 'createModel').mockImplementation(() => {
      throw new Error('model creation forbidden')
    })
    const profile: ModelProfile = {
      provider: 'openai-compatible',
      model: REPLAY_STUB_MODEL_ID,
      baseURL: 'http://localhost:9999/v1',
      auth: { mode: 'none' },
    }
    expect(await resolveReplayProfileFingerprint(session, 'declared')).toBe(
      computeReplayProfileFingerprintFor({ profile, seedPolicy: 'declared' }),
    )
    expect(auth).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })

  it('passes the same stub override names to the shared helper without invoking the stub', async () => {
    const { configPath } = await writeReplayFixture()
    const session = await sessionFor(configPath)
    const stub = replayStub()
    const profile: ModelProfile = {
      provider: 'openai-compatible',
      model: REPLAY_STUB_MODEL_ID,
      baseURL: 'http://localhost:9999/v1',
      auth: { mode: 'none' },
    }
    const fingerprint = await resolveReplayProfileFingerprint(session, 'declared', stub.overrides)
    expect(fingerprint).toBe(computeReplayProfileFingerprintFor({
      profile, seedPolicy: 'declared', modelOverrides: stub.overrides,
    }))
    expect(fingerprint).not.toBe(await resolveReplayProfileFingerprint(session, 'declared'))
    expect(stub.captured).toEqual([])
  })
})

describe('runReportVerb --commit --baseline — designation through the refusing writer (D-19/D-20)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('writes the per-profile pointer after a committed abstention report (D-19)', async () => {
    const { dir, session } = await scoredRecordsFixture(BASELINE_PLANNER_MODEL_ID)
    saveSeedRun(dir, 'run-seed')
    await runSeedVerb(session, { run: 'run-seed' }, TEST_FRACTIONS)
    const corpus = readCommittedCorpus(join(dir, 'agent-qa-eval'))
    expect(corpus.snapshot.entries.length).toBeGreaterThan(0)

    const result = await runReportVerb(session, {}, { commit: true, baseline: true })

    expect(result.committed).toMatchObject({ kind: 'committed', decisions: 'written' })
    const profileKey = await baselineProfileKey(session)
    expect(result.profileKey).toBe(profileKey)
    expect(profileKey).toMatch(/^planner=gpt-4o\|fingerprint=[0-9a-f]{64}\|matcher=1\|/)
    const pointerPath = `reports/baselines/${slugBranch(profileKey)}.json`
    expect(result.baseline).toEqual({ kind: 'written', path: pointerPath })

    // The committed body carries ONLY stamped fields — no wall clock, so re-designation
    // byte-compares instead of churning the write-once root (D-19).
    const body = JSON.parse(
      await readFile(join(dir, 'agent-qa-eval', pointerPath), 'utf-8'),
    ) as Record<string, unknown>
    expect(body).toEqual({
      schemaVersion: 2,
      profileKey,
      batchKey: result.batchKey,
      plannerModelId: BASELINE_PLANNER_MODEL_ID,
      matcherVersion: 1,
      fingerprint: await resolveReplayProfileFingerprint(session, 'none'),
      corpusDigest: computeCorpusDigest(corpus.snapshot.entries),
    })
    expect(result.notices).toContain(
      'baseline designated under seed policy none — eval gate compares against a declared-policy '
      + 'pointer; re-designate with eval report --baseline --from-committed <batchKey> --seed-policy declared',
    )
  })

  it('designates declared seed policy with identical keys for two seed values', async () => {
    const { dir, session } = await scoredRecordsFixture(BASELINE_PLANNER_MODEL_ID)
    session.evalConfig.seed = 17
    const first = await runReportVerb(session, {}, { commit: true, baseline: true })
    expect(first.baseline?.kind).toBe('written')
    expect(first.profileKey).toBe(await baselineProfileKey(session, 'declared'))
    expect(first.profileKey).not.toBe(await baselineProfileKey(session, 'none'))
    expect(first.notices.some(notice => notice.includes('seed policy none'))).toBe(false)
    const pointerPath = `reports/baselines/${slugBranch(first.profileKey!)}.json`
    const body = JSON.parse(await readFile(join(dir, 'agent-qa-eval', pointerPath), 'utf8'))
    expect(body.fingerprint).toBe(await resolveReplayProfileFingerprint(session, 'declared'))

    session.evalConfig.seed = 29
    const second = await runReportVerb(session, {}, { commit: true, baseline: true })
    expect(second.profileKey).toBe(first.profileKey)
    expect(second.baseline?.kind).toBe('unchanged')
  })

  it('uses planner overrides only to fingerprint a report designation', async () => {
    const { session } = await scoredRecordsFixture(BASELINE_PLANNER_MODEL_ID)
    const stub = replayStub(BASELINE_PLANNER_MODEL_ID)
    const result = await runReportVerb(session, {}, {
      commit: true, baseline: true, plannerOverrides: stub.overrides,
    })
    expect(result.baseline?.kind).toBe('written')
    expect(result.profileKey).toBe(composeBaselineProfileKey({
      plannerModelId: BASELINE_PLANNER_MODEL_ID,
      fingerprint: await resolveReplayProfileFingerprint(session, 'none', stub.overrides),
      matcherVersion: 1,
    }))
    expect(result.profileKey).not.toBe(await baselineProfileKey(session))
    expect(stub.captured).toEqual([])
  })

  it('discloses committed-corpus read refusals during designation', async () => {
    const { dir, session } = await scoredRecordsFixture(BASELINE_PLANNER_MODEL_ID)
    const corpusDir = join(dir, 'agent-qa-eval', 'corpus', 'default')
    await mkdir(corpusDir, { recursive: true })
    const brokenPath = join(corpusDir, 'broken.json')
    await writeFile(brokenPath, '{')
    const result = await runReportVerb(session, {}, { commit: true, baseline: true })
    expect(result.baseline?.kind).toBe('written')
    expect(result.notices.some(notice => notice.startsWith(`committed read refused ${brokenPath}:`))).toBe(true)
  })

  it('refuses a same-family report as a comparator, keeps the report as history (D-18/D-20)', async () => {
    const { dir, configPath, session, ids } = await scoredRecordsFixture(BASELINE_PLANNER_MODEL_ID)
    // This cell produces fresh replay scores; the copied v1 census fixture stays unchanged.
    const currentJudge = { ...FIXTURE_JUDGE_BLOCK, judgeVersion: JUDGE_CONFIG.judgeVersion }
    for (const id of ids) await setScoreJudgeBlock(dir, id, currentJudge)

    const result = await runReportVerb(session, {}, { commit: true, baseline: true })

    expect(result.judgeIdentity).toBe('present')
    // The new report itself still commits, following the v50 history-preservation law (D-18).
    expect(result.committed?.kind).toBe('committed')
    expect(result.baseline?.kind).toBe('refused')
    expect(
      result.baseline?.kind === 'refused' && result.baseline.refusal.kind,
    ).toBe('same-family-override')
    // A refused designation leaves NO file behind — the refusal precedes every write.
    expect(existsSync(join(dir, 'agent-qa-eval', 'reports', 'baselines'))).toBe(false)

    // ROOT-11: the refusal is disclosed on the surface a person actually reads, and exit stays 0.
    const { logs } = captureConsole()
    await buildProgram().parseAsync(
      ['--config', configPath, 'eval', 'report', '--commit', '--baseline'],
      { from: 'user' },
    )
    expect(process.exitCode).not.toBe(1)
    expect(logs.join('\n')).toContain('baseline comparator refused: same-family-override')
  })

  /**
   * 413-15 (decision `refuse-mixed-identity`, 2026-09-04): the end-to-end slice for the case
   * 413-02 D-1 left open — persisted score records carrying DIFFERING judge blocks → the mixed
   * arm of `runReportVerb` → `buildEvalReport`'s third argument → `writeBaselinePointer` → the
   * ONE predicate → a printed refusal and NO pointer. Before this plan such a batch was
   * designated under the `judge=none|judgeVersion=none` key that D-2 reserved for an honestly
   * judge-less measurement.
   */
  it('refuses a mixed-judge-identity batch as a comparator, keeps the report as history (413-15 decision: refuse)', async () => {
    const { dir, configPath, session, ids } = await scoredRecordsFixture(BASELINE_PLANNER_MODEL_ID)
    await setScoreJudgeBlock(dir, ids[0]!, JUDGE_BLOCK_A)
    await setScoreJudgeBlock(dir, ids[1]!, JUDGE_BLOCK_B)

    const result = await runReportVerb(session, {}, { commit: true, baseline: true })

    expect(result.judgeIdentity).toBe('mixed')
    // No single identity is fabricated (T-372-20) — the mixture rides as data instead.
    expect(result.report.judge).toBeUndefined()
    expect(result.report.judgeIdentity).toBe('mixed')
    expect(result.report.mixedJudgeModelIds).toEqual([JUDGE_BLOCK_A.judgeModelId, JUDGE_BLOCK_B.judgeModelId])

    // The report still commits: a refused comparator is still honest history (D-18's posture).
    expect(result.committed?.kind).toBe('committed')
    expect(result.baseline?.kind).toBe('refused')
    expect(result.baseline?.kind === 'refused' && result.baseline.refusal.kind).toBe(
      'mixed-judge-identity',
    )
    expect(
      result.baseline?.kind === 'refused'
      && result.baseline.refusal.kind === 'mixed-judge-identity'
      && result.baseline.refusal.judgeModelIds,
    ).toEqual([JUDGE_BLOCK_A.judgeModelId, JUDGE_BLOCK_B.judgeModelId])
    // A refused designation leaves NO file behind — the refusal precedes every write.
    expect(existsSync(join(dir, 'agent-qa-eval', 'reports', 'baselines'))).toBe(false)

    // The committed projection discloses the mixture instead of claiming no judge was invoked.
    const markdown = await readFile(
      join(dir, 'agent-qa-eval', 'reports', slugBranch(result.batchKey), 'report.md'),
      'utf-8',
    )
    expect(markdown).toContain('mixed identities across score records')
    expect(markdown).not.toContain('judge: no judge invoked')

    // ROOT-11: the refusal is disclosed on the surface a person reads, and exit stays 0.
    const { logs } = captureConsole()
    await buildProgram().parseAsync(
      ['--config', configPath, 'eval', 'report', '--commit', '--baseline'],
      { from: 'user' },
    )
    expect(process.exitCode).not.toBe(1)
    expect(logs.join('\n')).toContain('baseline comparator refused: mixed-judge-identity')
  })

  it('--baseline without --commit is a typed error the command maps to exit 1 (D-19)', async () => {
    const { configPath, session } = await scoredRecordsFixture(BASELINE_PLANNER_MODEL_ID)

    await expect(runReportVerb(session, {}, { baseline: true })).rejects.toThrow(
      /--baseline requires --commit/,
    )

    const { logs, errors } = captureConsole()
    await buildProgram().parseAsync(
      ['--config', configPath, 'eval', 'report', '--baseline'],
      { from: 'user' },
    )
    expect(process.exitCode).toBe(1)
    expect(errors.join('\n')).toContain('--baseline requires --commit')
    expect(logs).toEqual([])
  })

  it('re-designating the same batch is an idempotent unchanged pointer (D-17/D-19)', async () => {
    const { session } = await scoredRecordsFixture(BASELINE_PLANNER_MODEL_ID)

    const first = await runReportVerb(session, {}, { commit: true, baseline: true })
    expect(first.baseline?.kind).toBe('written')

    const second = await runReportVerb(session, {}, { commit: true, baseline: true })
    expect(second.baseline).toEqual({
      kind: 'unchanged',
      path: `reports/baselines/${slugBranch(await baselineProfileKey(session))}.json`,
    })
  })
})
