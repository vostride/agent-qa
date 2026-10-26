// Phase 372-05 — the eval command family's first verb: extract (D-01), sweep-by-default with the
// D-02 filter vocabulary, typed per-run skips (never batch errors), D-04 DTO-faithful rendering,
// and D-08 exit semantics. Task 1 pins runExtractVerb; Task 2 pins the commander wiring.
// Phase 372-06 adds the replay verb: sweep staged cassette bundles through runCassetteReplay with
// the session's seeded masking factory (D-06), the D-03 judge bag and typed refusal counters.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Command, CommanderError } from 'commander'
import { APICallError } from 'ai'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import fs from 'node:fs'
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { generateRunId, generateTestId } from '@vostride/agent-qa-ids'
import {
  JUDGE_CONFIG,
  buildEvalReport,
  buildSeedingPlan,
  committedFileText,
  composeBaselineProfileKey,
  computeBatchKey,
  computeCorpusDigest,
  DECISION_VECTORS_SCHEMA_VERSION,
  extractRunCassettes,
  guardDecisionVectorsDocument,
  maskCorpusText,
  partitionParamsOf,
  projectPartitionManifest,
  resolveProductPartition,
} from '@vostride/agent-qa-eval'
import type {
  JudgeIdentityBlock,
  SeedPolicy,
} from '@vostride/agent-qa-eval'
import type { createModel, ModelProfile, ModelProviderOverrides } from '@vostride/agent-qa-model'
import {
  FsEvidenceArtifactStore,
  FsHandoffStore,
  HANDOFF_FILE,
  RUNS_SUBDIR,
  loadCompletedRunHandoff,
  slugBranch,
} from '@vostride/agent-qa-runner-local'
import {
  CURRENT_HANDOFF_SCHEMA_VERSION,
  asRef,
  asRunId,
  computeBriefDigest,
} from '@vostride/agent-qa-schema'
import type {
  ArtifactRef,
  CompletedRunHandoff,
  MemberTestOutcome,
  ScopeKey,
  ScreenState,
  ServedBrief,
  StepEvidence,
  Verdict,
} from '@vostride/agent-qa-schema'
import {
  FsReplayRecordStore,
  commitEvalReport,
  computeReplayProfileFingerprintFor,
  loadCassetteBundle,
  FsScoreStore,
  runCassetteReplay,
  readCommittedCorpus,
  FsRunArtifactSource,
  loadLabelEvidence,
  readPartitionManifests,
  seedCommittedCorpus,
  writePartitionManifest,
} from '@vostride/agent-qa-eval-local'
import {
  EvalNamedInputError,
  resolveEvalSession,
  resolveReplayProfileFingerprint,
  resolveReplayPlanner,
  runExtractVerb,
  runReplayVerb,
  runReportVerb,
} from '../../eval-session-composition.js'
import type {
  EvalSession,
  ExtractVerbResult,
  ReplayVerbResult,
  ReportVerbResult,
} from '../../eval-session-composition.js'
import { createEvalCommand } from '../eval.js'

/** Three recorded runs extracted into staged cassettes, with generated identities and provider stubs. */
async function stagedReplayFixture(judged = false) {
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
  expect((await runExtractVerb(session)).cassettesWritten).toBe(6)
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

describe('runReplayVerb sweeps staged cassettes through the sanctioned composition', () => {
  afterEach(() => vi.restoreAllMocks())

  it('reports observed spend, reported usage and supported seed from this invocation only', async () => {
    const fixture = await stagedReplayFixture()
    fixture.session.evalConfig.seed = 11
    const clock = vi.spyOn(performance, 'now').mockReturnValue(100)
    const first = await runReplayVerb(fixture.session, {}, fixture.opts)
    // Each run stages a leaf and a procedure cassette, one decision apiece.
    expect(first.spend).toEqual({
      seed: 11, seedHonored: true, decisions: 6, modelCalls: 6,
      promptTokens: 60, completionTokens: 12, wallClockMs: 0,
      sampleCount: 6, samplesMissingTokenUsage: 0,
      judgeCost: { calls: 0, inputTokens: 0, outputTokens: 0, outcomesMissingUsage: 0 },
    })
    const oneId = (await stagedCassetteIds(fixture.dir)).find(id => id.endsWith('-leaf'))!
    const timed = replayStub(fixture.plannerModelId, () => {
      clock.mockReturnValue(137)
      return clickGenerateResult()
    })
    const second = await runReplayVerb(fixture.session, { cassette: oneId }, {
      plannerOverrides: timed.overrides,
    })
    expect(second.spend).toMatchObject({ decisions: 1, modelCalls: 1, promptTokens: 10,
      completionTokens: 2, wallClockMs: 37, sampleCount: 1 })
    expect(fixture.planner.captured).toHaveLength(first.spend.modelCalls)
  })

  it('counts provider retries separately from replay samples without inventing retry usage', async () => {
    const fixture = await stagedReplayFixture()
    let calls = 0
    const retrying = replayStub(fixture.plannerModelId, () => {
      if (calls++ === 0) throw new APICallError({
        message: 'retry fixture', url: 'http://localhost/fixture', requestBodyValues: {},
        statusCode: 429, isRetryable: true, responseHeaders: { 'retry-after-ms': '0' },
      })
      return clickGenerateResult()
    })
    const result = await runReplayVerb(fixture.session, {}, {
      plannerOverrides: retrying.overrides,
    })
    expect(result.spend).toMatchObject({ modelCalls: 7, sampleCount: 6, promptTokens: 60,
      completionTokens: 12, samplesMissingTokenUsage: 0, seed: null, seedHonored: null })
    expect(retrying.captured).toHaveLength(result.spend.modelCalls)
  })

  it('retains missing sample usage on provider failures', async () => {
    const fixture = await stagedReplayFixture()
    const failing = replayStub(fixture.plannerModelId, () => {
      throw new Error('unreported provider failure')
    })
    const result = await runReplayVerb(fixture.session, {}, {
      plannerOverrides: failing.overrides,
    })
    expect(result.spend).toMatchObject({ sampleCount: 6, samplesMissingTokenUsage: 6,
      promptTokens: 0, completionTokens: 0 })
    expect(result.spend.modelCalls).toBe(failing.captured.length)
    expect(result.spend.modelCalls).toBeGreaterThanOrEqual(6)
  })

  it('discloses unsupported seed evidence instead of asserting determinism', async () => {
    const fixture = await stagedReplayFixture()
    fixture.session.evalConfig.seed = 0
    const failing = replayStub(fixture.plannerModelId, () => {
      return { ...clickGenerateResult(), warnings: [{ type: 'unsupported', feature: 'seed' }] }
    })
    const result = await runReplayVerb(fixture.session, {}, {
      plannerOverrides: failing.overrides,
    })
    expect(result.spend).toMatchObject({ seed: 0, seedHonored: false, modelCalls: 6,
      sampleCount: 6, samplesMissingTokenUsage: 0, promptTokens: 60, completionTokens: 12 })
  })

  it('includes judge provider calls and reports their token contribution explicitly', async () => {
    const fixture = await stagedReplayFixture(true)
    const result = await runReplayVerb(fixture.session, {}, fixture.opts)
    // Each ambiguous fixture decision has two adjudicated tie axes.
    expect(result.spend).toMatchObject({ modelCalls: 18, sampleCount: 6, promptTokens: 180,
      completionTokens: 36,
      judgeCost: { calls: 12, inputTokens: 120, outputTokens: 24, outcomesMissingUsage: 0 },
    })
    expect(result.spend.modelCalls).toBe(fixture.planner.captured.length + fixture.judge.captured.length)
  })

  it('returns zero spend for an empty staged sweep without resolving models or credentials', async () => {
    const { configPath } = await writeReplayFixture()
    const session = await sessionFor(configPath)
    delete session.config.use!.llm
    session.evalConfig.judge = 'does-not-exist'
    session.evalConfig.seed = 11
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network forbidden'))
    const result = await runReplayVerb(session)
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

/**
 * Seed fixture: the extract fixture with Luhn-safe state timestamps. The committed egress
 * checkpoint's credit-card detector Luhn-checks every 13-19 digit run and the extract fixture's
 * 1725000000100 stateBefore timestamp happens to pass — a 10-digit epoch keeps the committed
 * cassette text free of card-shaped numbers (the seeding-composition test precedent).
 */
function saveSeedRun(dir: string, runId: string): void {
  const root = join(dir, '.agent-qa')
  const ref = new FsEvidenceArtifactStore({ root, runId }).persistDecisionScreenshot(BLOB_BYTES)
  const handoff = buildHandoff({ runId, screenshotRef: ref })
  for (const test of handoff.tests) {
    for (const testStep of test.steps) {
      for (const subAction of testStep.subActions) {
        subAction.stateBefore = { ...subAction.stateBefore, timestamp: 1_725_000_000 }
      }
    }
  }
  new FsHandoffStore({ root, runId }).save(handoff)
}

/**
 * Commit the recorded runs into the fixture's committed root through eval core's seeding plan,
 * minting one partition manifest per product on first use. Returns the seeded case count.
 */
function seedCommittedRoot(session: EvalSession, run?: string): number {
  const agentQaRoot = resolve(session.configDir, '.agent-qa')
  const committedRoot = resolve(session.configDir, 'agent-qa-eval')
  const runsRoot = join(agentQaRoot, RUNS_SUBDIR)
  const manifests = new Map(
    readPartitionManifests(committedRoot).manifests.map(manifest => [manifest.product, manifest]),
  )
  let seeded = 0
  for (const slug of fs.readdirSync(runsRoot).sort()) {
    if (run !== undefined && slug !== slugBranch(run)) continue
    const handoff = loadCompletedRunHandoff(join(runsRoot, slug, HANDOFF_FILE))
    const product = resolveProductPartition(handoff.scope)
    let manifest = manifests.get(product)
    if (manifest === undefined) {
      manifest = projectPartitionManifest({
        product, saltHex: randomBytes(32).toString('hex'), ...TEST_FRACTIONS,
      })
      expect(writePartitionManifest({ manifest, committedRoot }).kind).toBe('written')
      manifests.set(product, manifest)
    }
    const committed = readCommittedCorpus(committedRoot)
    const evidence = loadLabelEvidence({ snapshot: committed.snapshot, agentQaRoot, incoming: handoff })
    const incoming = maskCorpusText(handoff, session.mask)
    const { cassettes } = extractRunCassettes({
      handoff: incoming,
      artifacts: new FsRunArtifactSource({ root: agentQaRoot, runId: handoff.runId }),
    })
    const plan = buildSeedingPlan({
      handoff: incoming,
      populationContext: {
        snapshot: committed.snapshot,
        handoffs: evidence.handoffs.map(source =>
          source.runId === handoff.runId ? incoming : maskCorpusText(source, session.mask)),
        marks: evidence.marks,
      },
      cassettes,
      partition: partitionParamsOf(manifest),
      capturedAt: new Date(handoff.endedAt).toISOString(),
      mask: session.mask,
    })
    seeded += seedCommittedCorpus({ plan, cassettes, committedRoot, mask: session.mask }).seededCount
  }
  return seeded
}

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

describe('createEvalCommand registers extract, replay and report', () => {
  it('names the family "eval" with extract, replay and report', () => {
    const cmd = createEvalCommand()
    expect(cmd.name()).toBe('eval')
    expect(cmd.commands.map(sub => sub.name())).toEqual(['extract', 'replay', 'report'])
    expect(cmd.description()).toContain('extract, replay, report')
  })

  it('declares the D-02 filter vocabulary on extract: --run, --product, --json', () => {
    const extract = createEvalCommand().commands.find(sub => sub.name() === 'extract')
    const flags = extract?.options.map(option => option.long) ?? []
    expect(flags).toEqual(expect.arrayContaining(['--run', '--product', '--json']))
  })

  it('declares the replay flags: --run, --cassette, --product, --judge, --k, --seed, --json', () => {
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
})

function parseEval(args: string[]): Promise<{ code: string | undefined; stderr: string }> {
  const evalCommand = createEvalCommand()
  const program = new Command().option('--config <path>', 'config file path').addCommand(evalCommand)
  let stderr = ''
  for (const command of [program, evalCommand, ...evalCommand.commands]) {
    command.exitOverride().configureOutput({
      writeErr: (text) => { stderr += text },
      writeOut: () => {},
    })
  }
  return program.parseAsync(['eval', ...args], { from: 'user' }).then(
    () => ({ code: undefined, stderr }),
    (error: unknown) => {
      if (!(error instanceof CommanderError)) throw error
      return { code: error.code, stderr }
    },
  )
}

describe('eval subcommands that were removed', () => {
  it.each(['gate', 'floor', 'census', 'replay-gate', 'seed', 'adversarial', 'calibrate'])(
    'refuses eval %s as an unknown command',
    async (verb) => {
      const { code, stderr } = await parseEval([verb])
      expect(code).toBe('commander.unknownCommand')
      expect(stderr).toContain(`error: unknown command '${verb}'`)
    },
  )
})

describe('eval options that were removed', () => {
  it.each([
    ['replay', '--source', 'committed'],
  ])('refuses eval %s %s as an unknown option', async (verb, option, ...rest) => {
    const { code, stderr } = await parseEval([verb, option, ...rest])
    expect(code).toBe('commander.unknownOption')
    expect(stderr).toContain(`unknown option '${option}'`)
  })
})

describe('agent-qa eval report renders and exits from its DTO', () => {
  afterEach(() => {
    vi.restoreAllMocks()
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

describe('agent-qa eval replay renders and exits from its DTO', () => {
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

/** A same-family judge identity block as a committed report records it. */
const FIXTURE_JUDGE_BLOCK: JudgeIdentityBlock = {
  confidenceThreshold: 'high',
  familyOverride: 'same-family-allowed',
  judgeFamily: 'openai',
  judgeModelId: 'gpt-5.6-sol',
  judgeVersion: 1,
}

/** A seeded committed root holding exactly the two fixture cassettes. */
async function seededCorpusFixture(): Promise<{
  dir: string
  configPath: string
  session: EvalSession
}> {
  const { dir, configPath } = await writeFixture()
  saveSeedRun(dir, 'run-alpha')
  saveSeedRun(dir, 'run-beta')
  const session = await sessionFor(configPath)
  expect(seedCommittedRoot(session)).toBe(2)
  return { dir, configPath, session }
}

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
    seedCommittedRoot(session, 'run-seed')
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
