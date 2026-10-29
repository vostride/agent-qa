// Each leg folds a twin handoff differing only by the markers and asserts that side moved.

import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ConfigReaderPort, JobModelCapability } from '@vostride/agent-qa-agent'
import {
  composeLocalAgent,
  DIGEST_JOB_ID_SOURCE,
  LOCAL_CURATION_CAPABILITIES,
  type LocalAgentHost,
} from '@vostride/agent-qa-agent-local'
import {
  fingerprintRecurrence,
  openIndexWriter,
  readFingerprintWindow,
  readTestOutcomeHistory,
  SUITE_FINGERPRINTS_TABLE,
} from '@vostride/agent-qa-knowledge-local'
import { HANDOFF_FILE, RUNS_SUBDIR, slugBranch } from '@vostride/agent-qa-runner-local'
import {
  asRef,
  asRunId,
  canonicalJson,
  CURRENT_HANDOFF_SCHEMA_VERSION,
  type CompletedRunHandoff,
  type ElementInfo,
  type PerTestOutcome,
  type ScreenState,
  type StepEvidence,
  type SubActionEvidence,
  type Verdict,
  MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { emitCurationCandidates, type EmitReport } from '../curation/emit-candidates.js'
import { exercisedAnchors } from '../curation/handoff-anchors.js'
import { createPostVerdictStep } from '../curation/post-verdict-step.js'
import { defaultCurationTailOperations } from '../curation/curation-tail.js'

const RUN_ID = 'run-393-05-gate-exclusion'
const BUILD_ORDINAL = 7
const PASSING_FILE = 'tests/checkout.yaml'
const PASSING_NAME = 'checkout completes the payment sheet'
const FAILING_FILE = 'tests/login.yaml'
const FAILING_NAME = 'login accepts a returning customer'

// The composition's required quarantine identity mint, passed through.
const MINT_IDENTITY = (filePath: string): string => filePath

const TEST_MODEL: JobModelCapability = {
  modelId: 'test:post-run-gate-run-exclusion',
  generate: async () => ({ text: 'not an author payload' }),
}

const TEST_CONFIG: ConfigReaderPort = {
  getMasked: () => Promise.resolve({
    schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
    configPath: '/tmp/post-run-gate-run-exclusion.config.yaml',
    entries: [],
  }),
}

// ---- the twin fixture -------------------------------------------------------------------------

function sha(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

const ARTIFACT_BYTES = Buffer.from('gate-run evidence bytes')
const ARTIFACT_SHA = sha(ARTIFACT_BYTES)

function element(ref: string, name: string, attributes: Record<string, string>): ElementInfo {
  return {
    ref: asRef(ref),
    role: 'button',
    name,
    nameNormalized: name.toLowerCase(),
    bounds: { x: 10, y: 20, width: 100, height: 40 },
    center: { x: 60, y: 40 },
    state: { enabled: true, focused: false, visible: true, clickable: true },
    labels: { ariaLabel: name },
    attributes,
  }
}

function screen(elements: ElementInfo[], url: string): ScreenState {
  return {
    platform: 'web',
    tree: elements.map((entry) => `${entry.role} ${entry.name}`).join('\n'),
    elements,
    refMap: Object.fromEntries(
      elements.map((entry) => [entry.ref, { bounds: entry.bounds!, center: entry.center! }]),
    ),
    url,
    timestamp: 1_750_000_000_000,
    metadata: {
      captureMode: 'textOnly',
      coordSpace: 'viewport',
      viewportWidth: 1_280,
      viewportHeight: 720,
      scroll: { offsetX: 0, offsetY: 0, contentWidth: 1_280, contentHeight: 1_440 },
    },
  }
}

function subAction(ref: string, name: string, testid: string): SubActionEvidence {
  const elements = [element(ref, name, { 'data-testid': testid })]
  return {
    plan: `Use ${ref}`,
    plannedAction: { type: 'click', ref: asRef(ref) },
    stateBefore: screen(elements, 'https://shop.example/cart'),
    stateAfter: screen(elements, 'https://shop.example/cart'),
    result: { success: true },
    decisionScreenshotRef: { id: `decision-screenshot:${ARTIFACT_SHA}`, sha: ARTIFACT_SHA },
  }
}

function step(stepIndex: number, ref: string, name: string, testid: string): StepEvidence {
  return {
    stepIndex,
    stepText: `Open ${name}`,
    cacheStatus: 'miss',
    servedBrief: {
      scope: { tier: 'product', key: 'storefront' },
      asOfBuild: BUILD_ORDINAL,
      budget: 1_000,
      truncation: 'none',
      channel1: [],
      channel2: [],
      channel3: [],
      briefDigest: 'brief-digest',
    },
    subActions: [subAction(ref, name, testid)],
    verifierVerdict: { pass: true, reasoning: `${name} opened` },
  }
}

const FAILURE_VERDICT: Verdict = {
  class: 'app_bug',
  producer: 'deterministic-classifier',
  confidence: 1,
  evidence: {
    citedSteps: [0],
    citedAnchors: [],
    citedArtifacts: [],
    rationale: 'the login form rejected a valid session',
  },
  memoryMisdirectionRuledOut: true,
  perTest: 1,
}

function members(): PerTestOutcome[] {
  return [
    {
      testId: 'checkout::happy-path',
      testName: PASSING_NAME,
      filePath: PASSING_FILE,
      testIndex: 0,
      outcome: 'passed',
      steps: [step(0, 'checkout', 'Checkout', 'checkout')],
    } as unknown as PerTestOutcome,
    {
      testId: 'login::returning',
      testName: FAILING_NAME,
      filePath: FAILING_FILE,
      testIndex: 1,
      // A failed member puts a row in `run_fingerprint_windows`, so leg 3 is observable.
      outcome: 'failed',
      steps: [step(0, 'signin', 'Sign in', 'signin')],
      rootCause: FAILURE_VERDICT,
    } as unknown as PerTestOutcome,
  ]
}

/**
 * The twins. Everything is a shared constant; the ONLY parameter is which markers get stamped.
 *
 * `markers` is spread with the same conditional idiom the carriers use, so an "unflagged" twin
 * carries no key at all rather than `undefined` — a handoff with `excludedFromOutcomes:
 * undefined` would serialise to the same bytes but is not the shape a runner ever writes.
 */
function fixtureHandoff(markers: {
  gateRun?: true
  excludedFromOutcomes?: true
} = {}): CompletedRunHandoff {
  return {
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: asRunId(RUN_ID),
    scope: { tier: 'product', key: 'storefront' },
    buildOrdinal: BUILD_ORDINAL,
    executionContext: 'local-headless',
    aggregateVerdict: 'failed',
    configDigests: { suiteConfigDigest: 'suite-digest', testConfigDigest: 'test-digest' },
    startedAt: 1_750_000_000_000,
    endedAt: 1_750_000_001_000,
    tests: members(),
    ...(markers.gateRun === undefined ? {} : { gateRun: markers.gateRun }),
    ...(markers.excludedFromOutcomes === undefined
      ? {}
      : { excludedFromOutcomes: markers.excludedFromOutcomes }),
  } as unknown as CompletedRunHandoff
}

const FLAGGED = { gateRun: true, excludedFromOutcomes: true } as const

// ---- roots ------------------------------------------------------------------------------------

const roots: string[] = []
const hosts: LocalAgentHost[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface Side {
  agentQaRoot: string
  knowledgeRoot: string
  runDir: string
  handoff: CompletedRunHandoff
}

/**
 * One side of a differential, in its OWN roots.
 *
 * Separate knowledge roots rather than one shared root are what let both twins keep the same
 * `runId`: the applied-runs marker is per-store, so an identical id in two stores is two
 * independent first folds, while in one store the second would answer `already-applied` and the
 * differential would be measuring idempotency instead of exclusion.
 */
function side(label: string, markers: { gateRun?: true; excludedFromOutcomes?: true }): Side {
  // Turbo can omit TMPDIR, yielding macOS's /tmp symlink. Canonicalize only our owned fixture.
  const agentQaRoot = realpathSync(mkdtempSync(join(tmpdir(), `agent-qa-393-05-${label}-`)))
  roots.push(agentQaRoot)
  writeFileSync(join(agentQaRoot, 'agent-qa.config.yaml'), 'workspace:\n  testMatch: [tests/**/*.yaml]\n  suiteMatch: [suites/**/*.suite.yaml]\n  hooksFile: hooks.yaml\n  envFile: .env\n  secretsFile: .env.secrets.local\nuse:\n  mobile:\n    appState: preserve\n')
  const knowledgeRoot = join(agentQaRoot, 'knowledge')
  mkdirSync(knowledgeRoot, { recursive: true })
  const runDir = join(agentQaRoot, RUNS_SUBDIR, slugBranch(RUN_ID))
  mkdirSync(join(runDir, 'blobs'), { recursive: true })
  writeFileSync(join(runDir, 'blobs', ARTIFACT_SHA), ARTIFACT_BYTES)
  const handoff = fixtureHandoff(markers)
  writeFileSync(join(runDir, HANDOFF_FILE), `${JSON.stringify(handoff)}\n`, 'utf8')
  return { agentQaRoot, knowledgeRoot, runDir, handoff }
}

function twins(): { flagged: Side; plain: Side } {
  return { flagged: side('flagged', FLAGGED), plain: side('plain', {}) }
}

/** The REAL fold, through the same capability the post-verdict tail uses. */
function fold(target: Side): void {
  LOCAL_CURATION_CAPABILITIES.foldRunOutcomes({
    knowledgeRoot: target.knowledgeRoot,
    handoff: target.handoff,
    runDir: target.runDir,
    extractAnchors: exercisedAnchors,
  })
}

interface Tables {
  outcomes: { product: string; file_path: string; test_name: string }[]
  fingerprintRows: number
  windows: { product: string; fingerprint: string }[]
  appliedRuns: number
}

function readTables(target: Side): Tables {
  const handle = openIndexWriter(target.knowledgeRoot)
  try {
    return {
      outcomes: handle.db.prepare(
        'SELECT product, file_path, test_name FROM run_test_outcomes ORDER BY file_path',
      ).all() as unknown as Tables['outcomes'],
      fingerprintRows: Number(
        (handle.db.prepare(
          `SELECT COUNT(*) AS n FROM ${SUITE_FINGERPRINTS_TABLE}`,
        ).get() as { n: number }).n,
      ),
      windows: handle.db.prepare(
        'SELECT product, fingerprint FROM run_fingerprint_windows ORDER BY fingerprint',
      ).all() as unknown as Tables['windows'],
      appliedRuns: Number(
        (handle.db.prepare(
          'SELECT COUNT(*) AS n FROM run_outcome_applied_runs',
        ).get() as { n: number }).n,
      ),
    }
  } finally {
    handle.close()
  }
}

/** Run a read against one side's index, with the connection closed either way. */
function withIndex<T>(target: Side, read: (db: ReturnType<typeof openIndexWriter>['db']) => T): T {
  const handle = openIndexWriter(target.knowledgeRoot)
  try {
    return read(handle.db)
  } finally {
    handle.close()
  }
}

// ---- the step, and what it did or did not queue --------------------------------------------------

function openTargetHost(target: Side): LocalAgentHost {
  const host = composeLocalAgent({
    mask: (text) => text,
    mintQuarantineIdentityPath: MINT_IDENTITY,
    agentQaRoot: target.agentQaRoot,
    config: TEST_CONFIG,
    knowledgeRoot: () => target.knowledgeRoot,
    model: () => TEST_MODEL,
    idSource: DIGEST_JOB_ID_SOURCE,
    postRun: {
      curateRun: async () => ({ curated: 0, deprecated: 0, complete: true }),
      candidateProse: 'masker-active',
    },
  })
  hosts.push(host)
  return host
}

// The markers go on the step input, as `shell.ts` spreads them, not read back from the handoff.
async function runStepOver(
  target: Side,
  markers: { gateRun?: true; excludedFromOutcomes?: true } = {},
): Promise<string> {
  const step = createPostVerdictStep({
    runId: RUN_ID,
    agentQaRoot: target.agentQaRoot,
    knowledgeRoot: target.knowledgeRoot,
    configPath: join(target.agentQaRoot, 'agent-qa.config.yaml'),
    log: { warn: vi.fn() },
    operations: {
      loadCompletedRunHandoff: defaultCurationTailOperations().loadCompletedRunHandoff,
      composeHost: () => openTargetHost(target),
      // Nobody holds this fixture's lease, so the ordinary path would read `drained`. That makes
      // `detached` on the flagged side a real differential rather than a shared default.
      readWriterLease: (() => ({ kind: 'absent' })) as never,
      nudgeDaemon: (async () => undefined) as never,
    },
  })
  const outcome = await step.port.run({
    runId: RUN_ID as never,
    verdict: 'failed' as never,
    ...markers,
  })
  const expected = markers.gateRun || markers.excludedFromOutcomes ? 'detached' : 'drained'
  if (outcome.disposition !== expected) {
    // Only the production-safe outcome/category is disclosed; the original assertions stay below.
    console.error('Unexpected exclusion differential disposition', JSON.stringify({
      outcome, enqueue: step.handoff.enqueueState, failureDetail: step.handoff.failureDetail,
    }))
  }
  expect(step.handoff.failureDetail, 'the exclusion differential must not hide a preparation refusal').toBeUndefined()
  return outcome.disposition
}

/** Every `analyze-run` row this side's queue holds, read through a SECOND composition. */
async function analyzeRunRows(target: Side): Promise<Record<string, unknown>[]> {
  const host = composeLocalAgent({
    mask: (text) => text,
    mintQuarantineIdentityPath: MINT_IDENTITY,
    agentQaRoot: target.agentQaRoot,
    config: TEST_CONFIG,
    knowledgeRoot: () => target.knowledgeRoot,
    model: () => TEST_MODEL,
    idSource: DIGEST_JOB_ID_SOURCE,
  })
  try {
    const dump = await (await host.jobs()).store.dumpState()
    return dump.jobs
      .filter((row) => row.kind === 'analyze-run')
      .map((row) => row.payload as Record<string, unknown>)
  } finally {
    await host.close()
  }
}

// ---- the premise ------------------------------------------------------------------------------

describe('the exclusion differential premise', () => {
  it('the twins differ ONLY by the markers', () => {
    const { flagged, plain } = twins()
    const stripped = { ...(flagged.handoff as unknown as Record<string, unknown>) }
    delete stripped.gateRun
    delete stripped.excludedFromOutcomes

    expect(canonicalJson(stripped)).toBe(
      canonicalJson(plain.handoff as unknown as Record<string, unknown>),
    )
    // …and the markers really are on the flagged side. Without this the equality above would
    // also hold for two identical unflagged handoffs, and every leg would compare a run to
    // itself.
    expect(flagged.handoff.gateRun).toBe(true)
    expect(flagged.handoff.excludedFromOutcomes).toBe(true)
    expect(plain.handoff.gateRun).toBeUndefined()
    expect(plain.handoff.excludedFromOutcomes).toBeUndefined()
  })
})

// ---- the four legs ----------------------------------------------------------------------------

describe('leg-1-flake-counters — a flagged run moves no run_test_outcomes row', () => {
  it('writes zero counter rows for the flagged twin while the unflagged twin writes two', () => {
    const { flagged, plain } = twins()
    fold(flagged)
    fold(plain)

    const flaggedTables = readTables(flagged)
    const plainTables = readTables(plain)

    // THE MOVING CELL first: without this the zero below is consistent with a fixture that
    // could never have produced a counter at all.
    expect(plainTables.outcomes.map((row) => row.file_path)).toEqual([
      PASSING_FILE,
      FAILING_FILE,
    ].sort())
    expect(flaggedTables.outcomes).toEqual([])

    // The applied-runs marker IS written on both sides. Exclusion is "this run contributes
    // nothing", not "this run was never folded" — a skipped fold would refold on the next pass
    // and the rebuild would disagree with the incremental path.
    expect(flaggedTables.appliedRuns).toBe(1)
    expect(plainTables.appliedRuns).toBe(1)

    // The identity the unflagged twin created, probed against the flagged store: typed absence.
    const identity = {
      product: plainTables.outcomes[0]!.product,
      filePath: PASSING_FILE,
      testName: PASSING_NAME,
    }
    expect(withIndex(plain, (db) => readTestOutcomeHistory(db, identity))).toMatchObject({
      passes: 1,
    })
    expect(withIndex(flagged, (db) => readTestOutcomeHistory(db, identity))).toBeUndefined()
  })
})

describe('leg-2-exemplar-ranking — a flagged run seeds no suite_fingerprints row', () => {
  it('writes zero ranking-substrate rows for the flagged twin while the unflagged twin writes some', () => {
    // Another table and module behind the same gate; a seeded row would let a draft match itself.
    const { flagged, plain } = twins()
    fold(flagged)
    fold(plain)

    expect(readTables(plain).fingerprintRows).toBeGreaterThan(0)
    expect(readTables(flagged).fingerprintRows).toBe(0)
  })
})

describe('leg-3-quarantine-window — a flagged FAILURE never advances the detection window', () => {
  it('records no window row for the flagged twin while the unflagged twin records one', () => {
    const { flagged, plain } = twins()
    fold(flagged)
    fold(plain)

    const plainWindows = readTables(plain).windows
    // The moving cell: the failed member DID reach the window on the unflagged side.
    expect(plainWindows).toHaveLength(1)
    expect(readTables(flagged).windows).toEqual([])

    // …and the live recurrence computation the quarantine ladder actually reads answers zero on
    // the flagged store for the very fingerprint the unflagged store recorded. A row count alone
    // would not rule out the ladder reaching the failure by some other key.
    const identity = plainWindows[0]!
    expect(
      withIndex(plain, (db) => fingerprintRecurrence(db, identity, BUILD_ORDINAL)),
    ).toMatchObject({ occurrenceOrdinals: 1 })
    expect(
      withIndex(flagged, (db) => fingerprintRecurrence(db, identity, BUILD_ORDINAL)),
    ).toMatchObject({ occurrenceOrdinals: 0, windowOrdinals: 0 })
    expect(withIndex(flagged, (db) => readFingerprintWindow(db, identity, BUILD_ORDINAL))).toEqual(
      [],
    )
  })
})

describe('leg-4-curation-candidates-emitted — knowledge curation still consumes a gate run', () => {
  it('emits candidates FROM the flagged handoff, identically to the unflagged twin', () => {
    // POSITIVE by design. `emitCurationCandidates` has zero occurrences of either marker today,
    // so C8 currently holds by accident of omission — an "asserts no exclusion" test would pass
    // against a build that had grown one. This asserts EMISSION, so adding a flag read here
    // reds it.
    const { flagged, plain } = twins()

    const flaggedReport = emitCurationCandidates({
      handoff: flagged.handoff,
      runDir: flagged.runDir,
      knowledgeRoot: flagged.knowledgeRoot,
    })
    const plainReport = emitCurationCandidates({
      handoff: plain.handoff,
      runDir: plain.runDir,
      knowledgeRoot: plain.knowledgeRoot,
    })

    expect(flaggedReport.enqueued).toBeGreaterThan(0)
    expect(flaggedReport.refused).toBe(0)
    // Equality over the whole report, candidate ids included: the candidates are
    // content-addressed, so identical ids are the evidence that the marker did not enter the
    // projected content at all — the strongest available phrasing of "flag-blind".
    const shape = (report: EmitReport): unknown => ({
      enqueued: report.enqueued,
      coalesced: report.coalesced,
      capExceeded: report.capExceeded,
      refused: report.refused,
      details: report.details.map((detail) => ({
        candidateId: detail.candidateId,
        kind: detail.kind,
        outcome: detail.outcome,
      })),
    })
    expect(shape(flaggedReport)).toEqual(shape(plainReport))
  })
})

describe('leg-5-analyze-run-queue — a flagged run is never queued at all', () => {
  it('queues ZERO rows for the flagged twin and exactly one for the unflagged twin', async () => {
    const { flagged, plain } = twins()

    // The DIFFERENTIAL, and the reason this leg is a twin comparison rather than a zero-check:
    // "no analyze-run row" is satisfied just as well by a fixture that could never have produced
    // one. The unflagged side, byte-identical but for the markers, is what proves the queue was
    // reachable and the skip is a decision.
    expect(
      await runStepOver(flagged, { gateRun: true, excludedFromOutcomes: true }),
      'no strong-model analysis is queued per keep-gate iteration, so nothing promises a drain',
    ).toBe('detached')
    expect(
      await analyzeRunRows(flagged),
      'a gate-run reaches curation through the FOLD, never through the chain (D-08)',
    ).toHaveLength(0)

    expect(
      await runStepOver(plain),
      'nobody holds this fixture\'s lease, so an ordinary run takes it and pumps',
    ).toBe('drained')
    const plainRows = await analyzeRunRows(plain)
    expect(plainRows).toHaveLength(1)
    const payload = plainRows[0]!
    expect(payload).toMatchObject({
      runId: RUN_ID,
      handoffSchemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
      executionContext: 'local-headless',
    })
    expect(typeof payload.handoffDigest).toBe('string')
    // ABSENT, not false and not null. `in` rather than a value comparison, because
    // `payload.gateRun === undefined` is also true of a payload carrying the key explicitly set
    // to undefined — a shape a queue inspector would render as present.
    expect('gateRun' in payload).toBe(false)
    expect('excludedFromOutcomes' in payload).toBe(false)
  })

  it('each marker suppresses the queue INDEPENDENTLY — the flags are distinct axes', async () => {
    // The flags are distinct axes: a counting gate run and an excluded non-gate run are both real.
    const gateOnly = side('gate-only', { gateRun: true })
    expect(await runStepOver(gateOnly, { gateRun: true })).toBe('detached')
    expect(await analyzeRunRows(gateOnly)).toHaveLength(0)

    const excludedOnly = side('excluded-only', { excludedFromOutcomes: true })
    expect(await runStepOver(excludedOnly, { excludedFromOutcomes: true })).toBe('detached')
    expect(await analyzeRunRows(excludedOnly)).toHaveLength(0)
  })

  it('and the fold exclusion keys ONLY on excludedFromOutcomes, never on gateRun', () => {
    // The other half of "distinct axes", on the fold side: a `gateRun` run with no exclusion
    // marker COUNTS. Without this the whole suite would be consistent with an implementation
    // that excluded on either flag — which would silently stop C8-eligible gate runs from
    // contributing the outcome evidence they are supposed to contribute.
    const gateOnly = side('gate-only-fold', { gateRun: true })
    fold(gateOnly)
    expect(readTables(gateOnly).outcomes).toHaveLength(2)
    expect(readTables(gateOnly).fingerprintRows).toBeGreaterThan(0)
  })
})
