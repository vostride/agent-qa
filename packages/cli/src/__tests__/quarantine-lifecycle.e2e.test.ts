// Runs over one knowledge root through the real machinery; only member outcomes are scripted.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { invokeFunction } from '@vostride/agent-qa-agent'
import {
  CURRENT_ANALYSIS_SCHEMA_VERSION,
  QUARANTINE_UNASSIGNED_OWNER,
  asRef,
  exercisedAnchors,
  slugBranch,
  CURRENT_BUS_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import type {
  CompletedRunHandoff,
  ElementInfo,
  FunctionCaller,
  MemberTestOutcome,
  QuarantineAppliedEntry,
  RunAnalysisArtifact,
  RunEventEnvelope,
  RunEventType,
  RunStatus,
  ScreenState,
  StepEvidence,
} from '@vostride/agent-qa-schema'
import {
  LOCAL_CURATION_CAPABILITIES,
  composeLocalAgent,
  resolveRunQuarantineSnapshot,
} from '@vostride/agent-qa-agent-local'
import type { LocalAgentHost } from '@vostride/agent-qa-agent-local'
import { RUNS_SUBDIR } from '@vostride/agent-qa-runner-local'
import { createTimeoutAbortReason, mapVerdictToExitCode, startRun } from '@vostride/agent-qa-runner'
import type { RunConfig, RunMemberDescriptor, TestResult } from '@vostride/agent-qa-runner'
import { afterEach, describe, expect, it } from 'vitest'

import { createConsoleReporter, QUARANTINE_TEST_ANNOTATION } from '../reporters/console-reporter.js'
import { JUNIT_QUARANTINE_MARKER_BLOCK, createJunitReporter } from '../reporters/junit-reporter.js'

// Passthrough: the fixture speaks canonical workspace-relative bytes, and core pins the recipe.
const MINT_IDENTITY = (filePath: string): string => filePath

// The committed ledger's path is spelled here as a LITERAL rather than imported from the package
// that owns it: this suite is asserting on the artifact a human will find in their repository, and
// a constant imported from the writer would move with the writer and keep every assertion green.
const QUARANTINE_LEDGER_FILE = 'quarantine.jsonl'

const PRODUCT = 'shop-web'
const FILE_PATH = 'tests/checkout.yaml'
const TEST_NAME = 'checkout completes the payment sheet'
const ANCHOR_NAME = 'pay now'

/**
 * The suite this run's members belong to.
 *
 * `cli/src/commands/run.ts:1961` sets `failFastGroup: prepared.suiteKey` on EVERY member of every
 * suite, unconditionally — so a real suite run always has a shared group, and a fixture without one
 * is drawn from outside the shape production ever produces. Both members below carry it.
 */
const SUITE_GROUP = 'tests/checkout.suite.yaml'

// A sibling in the same suite, so a poisoned group has a member behind the tracked test to skip.
const SIBLING_FILE_PATH = 'tests/login.yaml'
const SIBLING_TEST_NAME = 'login accepts a returning customer'

/**
 * The tracked member's position in the `members` array, which is what the shell stamps as
 * `PerTestOutcome.testIndex` and therefore what an authored `Verdict.perTest` has to key on.
 * Named once so the descriptor and the analysis artifact cannot drift apart.
 */
const TRACKED_TEST_INDEX = 0

const TRACKED_MEMBER: RunMemberDescriptor = {
  testId: 'checkout',
  testIndex: TRACKED_TEST_INDEX,
  name: TEST_NAME,
  filePath: FILE_PATH,
  failFastGroup: SUITE_GROUP,
}

const SIBLING_MEMBER: RunMemberDescriptor = {
  testId: 'login',
  testIndex: 1,
  name: SIBLING_TEST_NAME,
  filePath: SIBLING_FILE_PATH,
  failFastGroup: SUITE_GROUP,
}

/** The run-start instant every run in the A..H timeline is driven at. */
const NOW = '2026-08-05T12:00:00.000Z'
/** `NOW` + QUARANTINE_DEFAULT_EXPIRY_DAYS (30), which is what the ledger must stamp. */
const EXPECTED_EXPIRY = '2026-09-04T12:00:00.000Z'

const CALLER: FunctionCaller = {
  surface: 'cli',
  origin: 'agent',
}

interface LedgerLine {
  kind: string
  product: string
  filePath: string
  testName: string
  /** Present on every `entered` event; the class the run's verdict for the member carried. */
  verdictClass?: string
  owner?: string
  expiresAt?: string
  reason?: string
}

const roots: string[] = []
const hosts: LocalAgentHost[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close?.()
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// ---- fixture shapes ---------------------------------------------------------------------------

/**
 * One failing step carrying a real anchor through the PRODUCTION extractor (`exercisedAnchors`).
 *
 * The evidence shape is what makes the failure fingerprint real: the same anchor + step text + error
 * across runs is what lets `fingerprintRecurrence` count three occurrences of ONE failure rather
 * than three unrelated reds.
 */
function failingStep(buildOrdinal: number): StepEvidence {
  const element: ElementInfo = {
    ref: asRef('e1'),
    role: 'button',
    name: ANCHOR_NAME,
    nameNormalized: ANCHOR_NAME,
    state: { enabled: true, focused: false, visible: true },
    labels: {},
    attributes: {},
  }
  const stateBefore: ScreenState = {
    platform: 'web',
    tree: '',
    elements: [element],
    refMap: {},
    url: '/checkout',
    timestamp: 1,
    metadata: {
      coordSpace: 'viewport',
      viewportWidth: 1280,
      viewportHeight: 720,
      scroll: { offsetX: 0, offsetY: 0, contentWidth: 1280, contentHeight: 720 },
      captureMode: 'textOnly',
    },
  }
  return {
    stepIndex: 0,
    stepText: `click the ${ANCHOR_NAME} button`,
    cacheStatus: 'miss',
    servedBrief: {
      scope: { tier: 'product', key: PRODUCT },
      asOfBuild: buildOrdinal,
      budget: 0,
      truncation: 'none',
      channel1: [],
      channel2: [],
      channel3: [],
      briefDigest: 'lifecycle-brief-digest',
    },
    subActions: [{
      plan: `click ${ANCHOR_NAME}`,
      plannedAction: { type: 'click', ref: element.ref },
      stateBefore,
      result: { success: false, error: `Error: element "${ANCHOR_NAME}" not found` },
    }],
    verifierVerdict: { pass: false, reasoning: `the ${ANCHOR_NAME} button never appeared` },
  } as unknown as StepEvidence
}

/** The ordinary element-not-found failure the lifecycle timeline is driven with. */
const ELEMENT_NOT_FOUND = `Error: element "${ANCHOR_NAME}" not found`

// Minted by the runner's own helper, because `deriveMemberOutcome` matches this exact string.
const TEST_DEADLINE_ERROR = createTimeoutAbortReason('test', 30_000).message

// An authored verdict reaches a consumer only through `analysis.json`, never the persisted handoff.
function authoredFlakeArtifact(runId: string): RunAnalysisArtifact {
  return {
    schemaVersion: CURRENT_ANALYSIS_SCHEMA_VERSION,
    runId,
    verdicts: [{
      class: 'flake',
      producer: 'analyze-run',
      confidence: 0.6,
      evidence: {
        citedSteps: [0],
        citedAnchors: [],
        citedArtifacts: [],
        rationale: `the ${ANCHOR_NAME} button never appeared`,
      },
      memoryMisdirectionRuledOut: false,
      perTest: TRACKED_TEST_INDEX,
    }],
    parts: [{
      perTest: TRACKED_TEST_INDEX,
      groundingQuote: { stepIndex: 0, quote: `the ${ANCHOR_NAME} button never appeared` },
      discriminator: 'the same step fails intermittently across builds',
      nextAction: 'stabilise the payment sheet wait',
      links: [],
    }],
  }
}

interface RunScript {
  runId: string
  buildOrdinal: number
  outcome: Extract<MemberTestOutcome, 'passed' | 'failed'>
  /** The tracked member's failing-step error. Defaults to the element-not-found string. */
  failureError?: string
  /**
   * `false` ⇒ NO `analysis.json` is written for this run, so the deterministic floor is the only
   * verdict there is. That is the no-analysis-budget posture, asserted POSITIVELY at the leg that
   * uses it by reading the producer off the handoff the run produced.
   */
  analysisBudget?: false
}

// The failing step carries rich `StepEvidence`, so the fold extracts real anchors and fingerprints.
function shellResult(
  testId: string,
  outcome: 'passed' | 'failed',
  buildOrdinal: number,
  failureError: string = ELEMENT_NOT_FOUND,
): TestResult {
  return {
    name: testId,
    filePath: `${testId}.test.ts`,
    status: outcome,
    steps: [{
      name: `click the ${ANCHOR_NAME} button`,
      status: outcome,
      duration: 1,
      ...(outcome === 'failed'
        ? { error: failureError, evidence: failingStep(buildOrdinal) }
        : {}),
    }],
    duration: 1,
  }
}

interface ShellLeg {
  aggregate: RunStatus
  exitCode: number
  /** The disposition the SHELL matched for the tracked member, read off its handoff. */
  memberQuarantined: boolean
  /** Which members the executor was actually reached for, in order. */
  executed: readonly string[]
  // The handoff this run produced, which is the object written and folded.
  handoff: CompletedRunHandoff
}

// The aggregate, exit code and disposition come off one real session; the snapshot is plain data.
async function runThroughShell(
  script: RunScript,
  snapshotAtStart: readonly QuarantineAppliedEntry[],
  siblingOutcome: 'passed' | 'failed',
): Promise<ShellLeg> {
  const executed: string[] = []
  const session = startRun({
    runId: script.runId as RunConfig['runId'],
    scope: { tier: 'product', key: PRODUCT },
    executionContext: 'ci',
    buildOrdinal: script.buildOrdinal,
    configDigests: { suiteConfigDigest: 'suite', testConfigDigest: 'test' },
    members: [TRACKED_MEMBER, SIBLING_MEMBER],
    executor: async (member) => {
      executed.push(member.testId)
      const tracked = member.testId === TRACKED_MEMBER.testId
      return shellResult(
        member.testId,
        tracked ? script.outcome : siblingOutcome,
        script.buildOrdinal,
        // Only the TRACKED member is scripted with a chosen failure text. The sibling always fails
        // ordinarily, which is what keeps it off the floor-admission path (see the no-budget leg).
        tracked ? script.failureError ?? ELEMENT_NOT_FOUND : ELEMENT_NOT_FOUND,
      )
    },
    quarantined: snapshotAtStart,
  })
  const { verdict, handoff } = await session.done
  const tracked = handoff.tests.find((test) => test.testId === TRACKED_MEMBER.testId)
  return {
    aggregate: verdict,
    exitCode: mapVerdictToExitCode(verdict),
    memberQuarantined: tracked?.quarantined === true,
    executed,
    handoff,
  }
}

/** The bus stream a real run of this one member would publish. */
function envelopesFor(script: RunScript, aggregate: RunStatus): RunEventEnvelope[] {
  let seq = 0
  const env = <P>(type: RunEventType, payload: P): RunEventEnvelope =>
    ({ seq: ++seq, ts: 1_000 + seq, runId: script.runId, type, payload }) as RunEventEnvelope
  const failed = script.outcome === 'failed'
  return [
    env('runStarted', {
      busSchemaVersion: CURRENT_BUS_SCHEMA_VERSION,
      scope: { tier: 'product', key: PRODUCT },
      executionContext: 'ci',
      buildOrdinal: script.buildOrdinal,
      configDigests: { suiteConfigDigest: 'suite', testConfigDigest: 'test' },
      memberTestCount: 1,
    }),
    env('testStarted', {
      testId: `${script.runId}-checkout`,
      testIndex: 0,
      name: TEST_NAME,
      filePath: FILE_PATH,
      totalSteps: 1,
    }),
    env('stepStarted', { testIndex: 0, stepIndex: 0, stepText: `click the ${ANCHOR_NAME} button` }),
    env('stepFinalized', {
      testIndex: 0,
      stepIndex: 0,
      cacheStatus: 'miss',
      verifierVerdict: { pass: !failed, reasoning: 'checkout' },
      selfHealOccurred: false,
      briefDigest: 'lifecycle-brief-digest',
      status: failed ? 'failed' : 'passed',
      durationMs: 1_200,
      ...(failed ? { error: `Error: element "${ANCHOR_NAME}" not found` } : {}),
    }),
    env('testFinished', {
      testId: `${script.runId}-checkout`,
      testIndex: 0,
      outcome: script.outcome,
      durationMs: 1_500,
      ...(failed ? { failureSummary: `${ANCHOR_NAME} never appeared` } : {}),
    }),
    env('runFinished', { aggregateVerdict: aggregate, disposition: 'detached', finalSeq: seq }),
  ]
}

// ---- the harness ------------------------------------------------------------------------------

interface Harness {
  root: string
  agentQaRoot: string
  knowledgeRoot: string
}

function harness(prefix: string): Harness {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  const agentQaRoot = join(root, '.agent-qa')
  const knowledgeRoot = join(root, 'knowledge')
  mkdirSync(agentQaRoot, { recursive: true })
  mkdirSync(knowledgeRoot, { recursive: true })
  return { root, agentQaRoot, knowledgeRoot }
}

function ledgerLines(env: Harness): LedgerLine[] {
  const path = join(env.knowledgeRoot, QUARANTINE_LEDGER_FILE)
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as LedgerLine)
}

type FoldReport = ReturnType<typeof LOCAL_CURATION_CAPABILITIES.foldRunOutcomes>

interface DrivenRun {
  runId: string
  buildOrdinal: number
  // What the ledger licensed for this run, read once before any member could execute.
  snapshotAtStart: readonly QuarantineAppliedEntry[]
  memberQuarantined: boolean
  aggregate: RunStatus
  exitCode: number
  /** Which members the run shell actually reached the executor for. */
  executed: readonly string[]
  // The handoff the run produced, the same object written to the run dir and folded.
  handoff: CompletedRunHandoff
  /** What the post-run fold answered — the detection events and the loud refusals it reported. */
  fold: FoldReport
  junitXml: string
  consoleOutput: string
  ledgerBefore: LedgerLine[]
  ledgerAfter: LedgerLine[]
}

/**
 * One whole run, start to fold, through the production path at every hop.
 *
 * The ORDER matters and mirrors `run.ts`: the snapshot is resolved BEFORE the member executes, the
 * verdict is derived from the snapshot the run started with, and the fold — which is where a new
 * crossing is detected — happens strictly AFTER the exit code is decided. That ordering is what
 * makes detection one run behind, and it is reproduced here rather than assumed.
 */
async function driveRun(env: Harness, script: RunScript, now = NOW): Promise<DrivenRun> {
  const ledgerBefore = ledgerLines(env)

  // (1) run start — fold the committed ledger ONCE
  const snapshotAtStart = resolveRunQuarantineSnapshot({
    knowledgeRoot: env.knowledgeRoot,
    product: PRODUCT,
    now,
  })
  // The run: aggregate, exit code and disposition off one session, so fail-fast is on the path.
  const { aggregate, exitCode, memberQuarantined, executed, handoff } = await runThroughShell(
    script,
    snapshotAtStart,
    'passed',
  )

  // (3) both reporters, over the run's real envelope stream
  const envelopes = envelopesFor(script, aggregate)
  let junitXml = ''
  const junit = createJunitReporter({
    outputPath: join(env.root, `junit-${script.runId}.xml`),
    write: async (_path, content) => { junitXml = content },
    quarantined: snapshotAtStart,
  })
  const consoleChunks: string[] = []
  const consoleReporter = createConsoleReporter({
    plain: true,
    colorize: false,
    isTTY: false,
    write: (chunk) => consoleChunks.push(chunk),
    quarantined: snapshotAtStart,
  })
  for (const envelope of envelopes) {
    junit.handler(envelope)
    consoleReporter.handler(envelope)
  }
  await junit.flush()

  // The durable handoff the run produced, so the bytes on disk and the object folded are one value.
  const runDir = join(env.agentQaRoot, RUNS_SUBDIR, slugBranch(script.runId))
  mkdirSync(runDir, { recursive: true })
  writeFileSync(join(runDir, 'handoff.json'), `${JSON.stringify(handoff)}\n`, 'utf8')

  // (4b) the `analyze-run` job's artifact, beside it, when this run had an analysis budget and
  //      something to analyse. This is the ONLY place an authored verdict can enter — the handoff
  //      above carries the deterministic floor's answer and nothing else.
  if (script.analysisBudget !== false && script.outcome === 'failed') {
    writeFileSync(
      join(runDir, 'analysis.json'),
      `${JSON.stringify(authoredFlakeArtifact(script.runId))}\n`,
      'utf8',
    )
  }

  // (5) the post-run fold — where THIS run's outcome enters the window and detection runs. It is
  //     handed the run DIRECTORY, exactly as the post-verdict tail does, so the artifact above is
  //     resolved through the same loader production uses rather than injected as data.
  const fold = LOCAL_CURATION_CAPABILITIES.foldRunOutcomes({
    knowledgeRoot: env.knowledgeRoot,
    handoff,
    runDir,
    extractAnchors: exercisedAnchors,
    quarantine: { now },
  })

  return {
    runId: script.runId,
    buildOrdinal: script.buildOrdinal,
    snapshotAtStart,
    memberQuarantined,
    aggregate,
    exitCode,
    executed,
    handoff,
    fold,
    junitXml,
    consoleOutput: consoleChunks.join(''),
    ledgerBefore,
    ledgerAfter: ledgerLines(env),
  }
}

// ---- the signature differential: runs A..H ----------------------------------------------------

describe('the quarantine lifecycle, end to end', () => {
  it('runs A..H: in at the crossing, suppressed-but-visible, auto-out after 5, honest again', async () => {
    const env = harness('agent-qa-lifecycle-')

    // --- ordinals 1 and 2: the failure recurs, below the escalate threshold ---------------------
    const pre1 = await driveRun(env, { runId: 'run-lifecycle-1', buildOrdinal: 1, outcome: 'failed' })
    expect(pre1.ledgerBefore).toEqual([])
    expect(pre1.ledgerAfter).toEqual([])
    expect(pre1.exitCode).toBe(1)

    const pre2 = await driveRun(env, { runId: 'run-lifecycle-2', buildOrdinal: 2, outcome: 'failed' })
    // Occurrences under the entry threshold flag for visibility and write no ledger byte.
    expect(pre2.ledgerBefore).toEqual([])
    expect(pre2.ledgerAfter).toEqual([])
    expect(pre2.exitCode).toBe(1)

    // --- RUN A (ordinal 3): the crossing. Enters the ledger, and STILL FAILS -------------------
    const runA = await driveRun(env, { runId: 'run-lifecycle-A', buildOrdinal: 3, outcome: 'failed' })

    // before: nothing licensed this run's failure
    expect(runA.ledgerBefore).toEqual([])
    expect(runA.snapshotAtStart).toEqual([])
    expect(runA.memberQuarantined).toBe(false)
    // The run that discovers the flake fails honestly.
    expect(runA.aggregate).toBe('failed')
    expect(runA.exitCode).toBe(1)
    // Unlicensed, the failure poisons its suite group, so the sibling behind it never runs.
    expect(runA.executed).toEqual(['checkout'])
    expect(runA.junitXml).toContain('<failure')
    expect(runA.junitXml).not.toContain(JUNIT_QUARANTINE_MARKER_BLOCK)
    expect(runA.consoleOutput).not.toContain(QUARANTINE_TEST_ANNOTATION)
    // after: the entry exists, unassigned, with a stamped deadline
    expect(runA.ledgerAfter).toHaveLength(1)
    expect(runA.ledgerAfter[0]).toMatchObject({
      kind: 'entered',
      product: PRODUCT,
      filePath: FILE_PATH,
      testName: TEST_NAME,
      owner: QUARANTINE_UNASSIGNED_OWNER,
      expiresAt: EXPECTED_EXPIRY,
    })

    // --- RUN B (ordinal 4): fails again, and the build goes GREEN ------------------------------
    const runB = await driveRun(env, { runId: 'run-lifecycle-B', buildOrdinal: 4, outcome: 'failed' })

    // before: the entry run A wrote is exactly what run B started under
    expect(runB.ledgerBefore).toEqual(runA.ledgerAfter)
    expect(runB.snapshotAtStart).toEqual([{
      product: PRODUCT,
      filePath: FILE_PATH,
      testName: TEST_NAME,
      expiresAt: EXPECTED_EXPIRY,
    }])
    expect(runB.memberQuarantined).toBe(true)
    // the member outcome is untouched; the AGGREGATE is what the disposition changed
    expect(runB.aggregate).toBe('passed')
    expect(runB.exitCode).toBe(0)
    // The licensed failure changes only the aggregate rule, so the sibling behind it still runs.
    expect(runB.executed).toEqual(['checkout', 'login'])
    // The correct amount of red on a green build.
    expect(runB.junitXml).toContain('<failure')
    expect(runB.junitXml).toContain(JUNIT_QUARANTINE_MARKER_BLOCK)
    expect(runB.junitXml).toContain('failures="1"')
    expect(runB.junitXml).not.toContain('<skipped')
    expect(runB.consoleOutput).toContain(`FAIL ${TEST_NAME} 1s ${QUARANTINE_TEST_ANNOTATION}`)
    expect(runB.consoleOutput).toContain('Tests:  0 of 1 passed · 1 quarantined failure')
    // Suppression writes nothing, because the entry is already open.
    expect(runB.ledgerAfter).toEqual(runB.ledgerBefore)

    // --- RUNS C..G (ordinals 5..9): five consecutive passing ordinals --------------------------
    const passing: DrivenRun[] = []
    for (const [index, buildOrdinal] of [5, 6, 7, 8, 9].entries()) {
      passing.push(await driveRun(env, {
        runId: `run-lifecycle-${'CDEFG'[index]!}`,
        buildOrdinal,
        outcome: 'passed',
      }))
    }
    const [runC, runD, runE, runF, runG] = passing as [
      DrivenRun, DrivenRun, DrivenRun, DrivenRun, DrivenRun,
    ]

    // the entry stays open through all four sub-threshold passes — asserted at EVERY hop, not
    // only at the boundary, so "released only at 5" is a measurement and not a single sample
    for (const run of [runC, runD, runE, runF]) {
      expect(run.exitCode).toBe(0)
      expect(run.ledgerAfter.map((line) => line.kind)).toEqual(['entered'])
      // nothing failed, so nothing poisoned: both members ran
      expect(run.executed).toEqual(['checkout', 'login'])
    }
    // The release boundary, one step either side: not after the fourth passing ordinal.
    expect(runF.ledgerAfter.some((line) => line.kind === 'released-auto')).toBe(false)
    // …and released after the fifth
    expect(runG.ledgerBefore).toEqual(runF.ledgerAfter)
    expect(runG.ledgerAfter).toHaveLength(2)
    expect(runG.ledgerAfter[1]).toMatchObject({
      kind: 'released-auto',
      product: PRODUCT,
      filePath: FILE_PATH,
      testName: TEST_NAME,
    })

    // --- RUN H (ordinal 10): fails after release — the build reds again ------------------------
    const runH = await driveRun(env, { runId: 'run-lifecycle-H', buildOrdinal: 10, outcome: 'failed' })

    expect(runH.ledgerBefore).toEqual(runG.ledgerAfter)
    // the released entry licenses nothing: the exit path is real, not decorative
    expect(runH.snapshotAtStart).toEqual([])
    expect(runH.memberQuarantined).toBe(false)
    expect(runH.aggregate).toBe('failed')
    expect(runH.exitCode).toBe(1)
    // the exit path restored the fail-fast too: with no disposition, the failure poisons again
    expect(runH.executed).toEqual(['checkout'])
    expect(runH.junitXml).toContain('<failure')
    expect(runH.junitXml).not.toContain(JUNIT_QUARANTINE_MARKER_BLOCK)
    expect(runH.consoleOutput).not.toContain(QUARANTINE_TEST_ANNOTATION)
    expect(runH.consoleOutput).toContain('Tests:  0 of 1 passed\n')
  }, 120_000)
})

// An unlicensed failure behind a licensed one must still reach the aggregate and the exit code.

describe('a quarantined failure never silences an un-quarantined one', () => {
  it('the failing sibling runs AND fails the build at exit 1, behind a licensed failure', async () => {
    const env = harness('agent-qa-antisilencing-')

    // three failing ordinals — the same crossing runs A..H drive, through the same fold
    for (const buildOrdinal of [1, 2, 3]) {
      await driveRun(env, {
        runId: `run-silence-${String(buildOrdinal)}`,
        buildOrdinal,
        outcome: 'failed',
      })
    }
    // the committed ledger now licenses the tracked test, and only the tracked test
    const snapshotAtStart = resolveRunQuarantineSnapshot({
      knowledgeRoot: env.knowledgeRoot,
      product: PRODUCT,
      now: NOW,
    })
    expect(snapshotAtStart).toEqual([{
      product: PRODUCT,
      filePath: FILE_PATH,
      testName: TEST_NAME,
      expiresAt: EXPECTED_EXPIRY,
    }])

    // the next run: the licensed test fails again, and so does its un-licensed suite sibling
    const { aggregate, exitCode, memberQuarantined, executed } = await runThroughShell(
      { runId: 'run-silence-4', buildOrdinal: 4, outcome: 'failed' },
      snapshotAtStart,
      'failed',
    )

    // Asserted as ONE shape: execution without the verdict would pass on a build that runs the
    // sibling and swallows it, and the verdict without execution would pass on a build that
    // skipped the sibling and failed for some other reason.
    expect({ executed, memberQuarantined, aggregate, exitCode }).toEqual({
      executed: ['checkout', 'login'],
      memberQuarantined: true,
      aggregate: 'failed',
      exitCode: 1,
    })
  }, 120_000)
})

// With no budget, a failing member is quarantined only if applied runs pass and fail at an ordinal.

describe('a failing member with no analysis budget can still be quarantined', () => {
  /** Every run here is scripted to blow the test deadline, and none of them gets an analyst. */
  const NO_BUDGET = {
    failureError: TEST_DEADLINE_ERROR,
    analysisBudget: false,
  } as const

  /**
   * Three failing ordinals — the crossing — optionally with a SECOND applied run at ordinal 1 in
   * which the same member PASSED. That extra run is the entire difference between the two legs
   * below, and it is the whole signature.
   */
  async function driveCrossing(
    env: Harness,
    opts: { sameOrdinalPass: boolean },
  ): Promise<DrivenRun> {
    await driveRun(env, { runId: 'run-floor-1', buildOrdinal: 1, outcome: 'failed', ...NO_BUDGET })
    if (opts.sameOrdinalPass) {
      // The CI job re-run: same build, same member, opposite answer. `mergeOutcomeEntries` pushes
      // one entry per applied run, so ordinal 1 now carries two.
      await driveRun(env, {
        runId: 'run-floor-1-rerun',
        buildOrdinal: 1,
        outcome: 'passed',
        ...NO_BUDGET,
      })
    }
    await driveRun(env, { runId: 'run-floor-2', buildOrdinal: 2, outcome: 'failed', ...NO_BUDGET })
    return driveRun(env, { runId: 'run-floor-3', buildOrdinal: 3, outcome: 'failed', ...NO_BUDGET })
  }

  it('authors an entered line NAMING the member, on the floor, with no analyst in the run', async () => {
    const env = harness('agent-qa-nobudget-')

    const crossing = await driveCrossing(env, { sameOrdinalPass: true })

    // (1) The handoff carries the floor producer: an identity pin, not a budget control.
    const tracked = crossing.handoff.tests.find((test) => test.testId === TRACKED_MEMBER.testId)
    expect(tracked?.rootCause).toMatchObject({
      class: 'timeout',
      producer: 'deterministic-classifier',
    })
    for (const test of crossing.handoff.tests) {
      expect(test.rootCause?.producer ?? 'deterministic-classifier')
        .toBe('deterministic-classifier')
    }

    // (2) THE ENTERED LINE NAMES THIS MEMBER'S OWN IDENTITY — never a count of entered lines. A
    //     count is exactly what makes a cap-induced failure and a gate-induced one look alike.
    if (crossing.fold.quarantine.kind !== 'evaluated') throw new Error('expected an evaluation')
    const entered = crossing.fold.quarantine.events.filter((event) => event.kind === 'entered')
    expect(entered.map((event) => ({
      product: event.product,
      filePath: event.filePath,
      testName: event.testName,
    }))).toEqual([{ product: PRODUCT, filePath: FILE_PATH, testName: TEST_NAME }])
    expect(crossing.ledgerAfter).toHaveLength(1)
    expect(crossing.ledgerAfter[0]).toMatchObject({
      kind: 'entered',
      product: PRODUCT,
      filePath: FILE_PATH,
      testName: TEST_NAME,
      owner: QUARANTINE_UNASSIGNED_OWNER,
      expiresAt: EXPECTED_EXPIRY,
      // The floor minted this class with no analyst in the run. An authored verdict would make it
      // `flake` — so this one field is the leg's own budget control (see block (1)).
      verdictClass: 'timeout',
    })

    // (3) THE PER-RUN FLOOR CAP IS NOT THE BINDING CONSTRAINT, by construction rather than by
    //     arithmetic. The tracked member's failure poisons its suite group, so the sibling is never
    //     reached and lands in the handoff as `skipped` — a skipped member contributes no failure
    //     row, so it is not a floor-admission candidate at all. This run therefore has exactly ONE
    //     candidate, strictly below the cap, and NOTHING was withheld for any cause. Without this
    //     the leg would sit on the cap's boundary and a later retune would red it with the same
    //     symptom as a genuine reachability regression.
    expect(crossing.executed).toEqual(['checkout'])
    expect(crossing.handoff.tests.find((test) => test.testId === SIBLING_MEMBER.testId)?.outcome)
      .toBe('skipped')
    expect(crossing.fold.quarantine.escalatedNotQuarantined).toEqual([])

    // The run that discovers it still fails honestly.
    expect(crossing.aggregate).toBe('failed')
    expect(crossing.exitCode).toBe(1)
  }, 120_000)

  it('authors NOTHING for the same crossing without the same-ordinal pass', async () => {
    const env = harness('agent-qa-nobudget-nosig-')

    // The ONLY delta from the leg above: no second applied run at ordinal 1. Same class, same
    // producer, same three occurrence ordinals, same absent analyst — so the refusal is the
    // signature's doing and not a sub-threshold window.
    const crossing = await driveCrossing(env, { sameOrdinalPass: false })

    if (crossing.fold.quarantine.kind !== 'evaluated') throw new Error('expected an evaluation')
    expect(crossing.fold.quarantine.events).toEqual([])
    expect(crossing.ledgerAfter).toEqual([])
    // Loud, not silent: the crossing is reported and the build still fails.
    expect(crossing.fold.quarantine.escalatedNotQuarantined).toHaveLength(1)
    expect(crossing.fold.quarantine.escalatedNotQuarantined[0]).toMatchObject({
      product: PRODUCT,
      testName: TEST_NAME,
      verdictClass: 'timeout',
      producer: 'deterministic-classifier',
    })
    expect(crossing.exitCode).toBe(1)
  }, 120_000)
})

// A lapsed deadline buys one red build; that run's fold re-enters with a fresh deadline.

describe('the expiry lapse: what one lapsed deadline buys', () => {
  // The crossing's 30-day deadline is behind both the run-start instant and the
  // composition's injected clock, independent of the date this test is executed.
  const PAST_NOW = '2026-06-01T12:00:00.000Z'
  const LAPSED_EXPIRY = '2026-07-01T12:00:00.000Z'

  it('a lapsed deadline fails the run again AND reads as expired in the sentence', async () => {
    const env = harness('agent-qa-expiry-')

    // Failing ordinals at the past instant give an entry whose deadline has passed.
    for (const buildOrdinal of [1, 2, 3]) {
      await driveRun(
        env,
        { runId: `run-expiry-${String(buildOrdinal)}`, buildOrdinal, outcome: 'failed' },
        PAST_NOW,
      )
    }
    const entered = ledgerLines(env)
    expect(entered).toHaveLength(1)
    expect(entered[0]).toMatchObject({ kind: 'entered', expiresAt: LAPSED_EXPIRY })

    let sentenceNow = NOW
    const host = composeLocalAgent({
      mask: (text) => text,
      mintQuarantineIdentityPath: MINT_IDENTITY,
      agentQaRoot: env.agentQaRoot,
      clock: { now: () => sentenceNow },
      config: { getMasked: () => Promise.reject(new Error('no config in this fixture')) },
      knowledgeRoot: () => env.knowledgeRoot,
      model: () => { throw new Error('no model in this fixture') },
    })
    hosts.push(host)
    const sentenceFor = async (runId: string): Promise<string> => {
      const answer = await invokeFunction(
        host.registry, 'analysis.get', { runId }, CALLER,
      ) as { sentences: readonly { sentence: string }[] }
      return answer.sentences[0]?.sentence ?? ''
    }

    // CONSEQUENCE 1 — the sentence says the suppression has lapsed, read from THESE ledger bytes.
    // The deadline is quoted so the reader knows which fact changed, and the clause spells out what
    // it means for them: failures count again.
    expect(await sentenceFor('run-expiry-3'))
      .toContain('quarantine expired Jul 1 — failures count again')

    // CONSEQUENCE 2 — the same lapsed entry stops suppressing. The run-start snapshot EXCLUDES an
    // expired entry, so the test that was green-listed is red again with no ledger edit at all: the
    // lapse is a consequence of the deadline passing, never of anyone acting. Which is also why it
    // bounds nothing — nobody is required to act for the suppression to come straight back.
    const afterLapse = await driveRun(
      env,
      { runId: 'run-expiry-lapsed', buildOrdinal: 4, outcome: 'failed' },
      NOW,
    )
    expect(afterLapse.snapshotAtStart).toEqual([])
    expect(afterLapse.memberQuarantined).toBe(false)
    expect(afterLapse.aggregate).toBe('failed')
    expect(afterLapse.exitCode).toBe(1)
    expect(afterLapse.junitXml).toContain('<failure')
    expect(afterLapse.junitXml).not.toContain(JUNIT_QUARANTINE_MARKER_BLOCK)
    expect(afterLapse.consoleOutput).not.toContain(QUARANTINE_TEST_ANNOTATION)

    // The lapse buys one failing build; its fold re-enters with a fresh deadline, then green.
    const afterReentry = ledgerLines(env)
    expect(afterReentry.map((line) => line.kind)).toEqual(['entered', 'entered'])
    expect(afterReentry[0]).toMatchObject({ kind: 'entered', expiresAt: LAPSED_EXPIRY })
    expect(afterReentry[1]).toMatchObject({
      kind: 'entered',
      product: PRODUCT,
      filePath: FILE_PATH,
      testName: TEST_NAME,
      owner: QUARANTINE_UNASSIGNED_OWNER,
      expiresAt: EXPECTED_EXPIRY,
    })
    // Nothing is released: an expired entry is a visible state, never a deletion.
    expect(afterReentry.some((line) => line.kind.startsWith('released'))).toBe(false)

    // The differential closes on ONE surface: the SAME accessor over the SAME ledger file now reads
    // the other arm. Two readings of one live computation, which is what makes the expired clause a
    // fact about the ledger rather than a string somebody remembered to print.
    expect(await sentenceFor('run-expiry-3')).toContain('quarantined until Sep 4')
    expect(await sentenceFor('run-expiry-3')).not.toContain('quarantine expired')

    // Advancing only the read clock expires that same re-entry without changing its ledger.
    sentenceNow = EXPECTED_EXPIRY
    expect(await sentenceFor('run-expiry-3'))
      .toContain('quarantine expired Sep 4 — failures count again')
    expect(await sentenceFor('run-expiry-3')).not.toContain('quarantined until')
    expect(ledgerLines(env)).toEqual(afterReentry)
  }, 120_000)

  // A characterization pin, not an endorsement: entries repeat with fresh deadlines, no release.
  describe('the loop it repeats, characterized over four cycles', () => {
    // One day past each preceding deadline, so every cycle starts on a genuinely lapsed entry.
    // Deadlines are hand-computed from QUARANTINE_DEFAULT_EXPIRY_DAYS = 30 so the constant is
    // pinned rather than re-derived by the assertion.
    const CYCLE_1_AT = '2026-01-05T12:00:00.000Z'
    const CYCLE_1_DEADLINE = '2026-02-04T12:00:00.000Z'
    const CYCLE_2_AT = '2026-02-05T12:00:00.000Z'
    const CYCLE_2_DEADLINE = '2026-03-07T12:00:00.000Z'
    /** One day INSIDE cycle 2's fresh window — the build right after the single red one. */
    const CYCLE_2_NEXT_DAY = '2026-02-06T12:00:00.000Z'
    const CYCLE_3_AT = '2026-03-08T12:00:00.000Z'
    const CYCLE_3_DEADLINE = '2026-04-07T12:00:00.000Z'
    const CYCLE_4_AT = '2026-04-08T12:00:00.000Z'
    const CYCLE_4_DEADLINE = '2026-05-08T12:00:00.000Z'

    it('re-enters on every lapse with a fresh deadline, releases nothing, and never attenuates', async () => {
      const env = harness('agent-qa-cycles-')

      // CYCLE 1 — the crossing. Three failing ordinals mint the first entry.
      for (const buildOrdinal of [1, 2, 3]) {
        await driveRun(
          env,
          { runId: `run-cycle1-${String(buildOrdinal)}`, buildOrdinal, outcome: 'failed' },
          CYCLE_1_AT,
        )
      }
      expect(ledgerLines(env)).toHaveLength(1)

      // CYCLE 2 — the deadline has lapsed. THE ONE RED BUILD: the run-start snapshot withholds
      // suppression, so the build fails…
      const lapsed = await driveRun(
        env,
        { runId: 'run-cycle2-lapsed', buildOrdinal: 4, outcome: 'failed' },
        CYCLE_2_AT,
      )
      expect(lapsed.snapshotAtStart).toEqual([])
      expect(lapsed.memberQuarantined).toBe(false)
      expect(lapsed.exitCode).toBe(1)

      // …and that SAME run's post-run fold re-suppressed it. The very next build — one day later,
      // no ledger edit by anyone, no human notified — is green again. That is the whole cost of a
      // lapse: exactly ONE red build, then the heartbeat resets.
      const dayAfter = await driveRun(
        env,
        { runId: 'run-cycle2-next', buildOrdinal: 5, outcome: 'failed' },
        CYCLE_2_NEXT_DAY,
      )
      expect(dayAfter.snapshotAtStart).toEqual([{
        product: PRODUCT,
        filePath: FILE_PATH,
        testName: TEST_NAME,
        expiresAt: CYCLE_2_DEADLINE,
      }])
      expect(dayAfter.memberQuarantined).toBe(true)
      expect(dayAfter.exitCode).toBe(0)
      expect(dayAfter.ledgerAfter).toEqual(dayAfter.ledgerBefore)

      // CYCLES 3 and 4 — one lapsed build each. Nothing distinguishes them from cycle 2.
      for (const [buildOrdinal, at] of [[6, CYCLE_3_AT], [7, CYCLE_4_AT]] as const) {
        const cycle = await driveRun(
          env,
          { runId: `run-cycle-${String(buildOrdinal)}`, buildOrdinal, outcome: 'failed' },
          at,
        )
        expect(cycle.snapshotAtStart).toEqual([])
        expect(cycle.exitCode).toBe(1)
      }

      const lines = ledgerLines(env)

      // Nothing is released: the exit path declines each lapsed entry, as the test never recovers.
      expect(lines.map((line) => line.kind)).toEqual(['entered', 'entered', 'entered', 'entered'])
      expect(lines.some((line) => line.kind.startsWith('released'))).toBe(false)

      // FACT 2 — four DISTINCT full-lifetime deadlines. Each re-entry MINTS one from its own
      // `now`; none is inherited, capped or shortened.
      const deadlines = lines.map((line) => line.expiresAt)
      expect(deadlines).toEqual([
        CYCLE_1_DEADLINE,
        CYCLE_2_DEADLINE,
        CYCLE_3_DEADLINE,
        CYCLE_4_DEADLINE,
      ])
      expect(new Set(deadlines).size).toBe(4)

      // FACT 3 — no attenuation: cycle 4's line is indistinguishable from cycle 2's in every field
      // except the two instants. Same unassigned owner, same identity, same event kind. There is
      // no lap counter, no escalation, no forced owner assignment — nothing that a reader of the
      // committed file could use to tell a test on its fourth lap from one on its first.
      for (const line of lines) {
        expect(line).toMatchObject({
          kind: 'entered',
          product: PRODUCT,
          filePath: FILE_PATH,
          testName: TEST_NAME,
          owner: QUARANTINE_UNASSIGNED_OWNER,
        })
      }
    }, 120_000)
  })
})
