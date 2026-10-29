// Drives the real fold: detection hangs off the `applied` arm, so a refold never re-quarantines.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CURRENT_HANDOFF_SCHEMA_VERSION,
  CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION,
  QUARANTINE_UNASSIGNED_OWNER,
  canonicalJson,
} from '@vostride/agent-qa-schema'
import type {
  Anchor,
  CompletedRunHandoff,
  PerTestOutcome,
  QuarantineLedgerEvent,
  ScopeKey,
  StepEvidence,
  Verdict,
  VerdictClass,
} from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it } from 'vitest'

import {
  classifyRootCause,
  createTimeoutAbortReason,
  deriveMemberOutcome,
} from '@vostride/agent-qa-runner'
import type { TestResult } from '@vostride/agent-qa-runner'

import { QUARANTINE_WINDOW_ORDINALS } from '../../projection/fingerprint-window-read.js'
import { foldRunOutcomes } from '../../projection/run-outcomes.js'
import type { FoldRunOutcomesReport } from '../../projection/run-outcomes.js'
import {
  AUTO_QUARANTINE_CLASSES,
  QUARANTINE_CLASS_DISPOSITIONS,
  QUARANTINE_ESCALATE_THRESHOLD,
  QUARANTINE_FLOOR_AUTO_QUARANTINE_CAP,
} from '../detection.js'
import {
  QUARANTINE_LEDGER_FILENAME,
  appendQuarantineEvents,
  foldQuarantineLedgerState,
  readQuarantineLedger,
} from '../ledger.js'

const SHOP_SCOPE: ScopeKey = { tier: 'product', key: 'shop-web' }
const PRODUCT = 'shop-web'
const FILE_PATH = 'suite/checkout.test.ts'
const TEST_NAME = 'checkout retries the payment sheet'
const ERROR_TEXT = 'the payment sheet never opened'
const NOW = '2026-08-05T12:00:00.000Z'
const EXPECTED_EXPIRY = '2026-09-04T12:00:00.000Z'

const payAnchor: Anchor = { t: 'el', role: 'button', name: 'pay now', ordinal: 1 }
const extractAnchors = (step: StepEvidence): Anchor[] =>
  (step as unknown as { anchors?: Anchor[] }).anchors ?? []

const tempDirs: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function failingStep(): StepEvidence {
  return {
    stepIndex: 0,
    stepText: 'pay now',
    cacheStatus: 'miss',
    servedBrief: {
      scope: SHOP_SCOPE,
      asOfBuild: 1,
      budget: 1,
      truncation: 'none',
      channel1: [],
      channel2: [],
      channel3: [],
      briefDigest: 'detection-fixture-digest',
    },
    subActions: [],
    verifierVerdict: { pass: false, reasoning: ERROR_TEXT },
    anchors: [payAnchor],
  } as unknown as StepEvidence
}

// Floor verdicts come from `classifyRootCause` on a scripted result; authored ones name a class.

// From the runner's own mint, so the test follows the message if its format changes.
const TEST_DEADLINE_ERROR = createTimeoutAbortReason('test', 30_000).message

/** A member that blew the hard test budget ⇒ `deriveMemberOutcome` answers `'timeout'`. */
function timedOutResult(): TestResult {
  return {
    name: TEST_NAME,
    filePath: FILE_PATH,
    status: 'failed',
    steps: [{ name: 'pay now', status: 'failed', duration: 1, error: TEST_DEADLINE_ERROR }],
    duration: 1,
  }
}

/** A member whose failing step carries a connect token ⇒ the classifier answers `'environment'`. */
function connectFailureResult(): TestResult {
  return {
    name: TEST_NAME,
    filePath: FILE_PATH,
    status: 'failed',
    steps: [{
      name: 'pay now',
      status: 'failed',
      duration: 1,
      error: 'connect ECONNREFUSED 127.0.0.1:4173',
    }],
    duration: 1,
  }
}

/** A member that PASSED on retry — the ONLY shape `classifyRootCause` mints `flake` for. */
function passedOnRetryResult(): TestResult {
  return {
    name: TEST_NAME,
    filePath: FILE_PATH,
    status: 'passed',
    steps: [{ name: 'pay now', status: 'passed', duration: 1 }],
    duration: 1,
    retryCount: 1,
  }
}

/**
 * The verdict THE RUNNER ANSWERS for a scripted member — the same three inputs the shell coexists
 * with at its one classification seam (`run/shell.ts`): the result, the derived member outcome,
 * and the member index.
 */
function producedVerdict(result: TestResult, perTest = 0): Verdict {
  const verdict = classifyRootCause({
    result,
    outcome: deriveMemberOutcome(result),
    testIndex: perTest,
  })
  if (verdict === undefined) {
    throw new Error('the classifier declined to classify this scripted member')
  }
  return verdict
}

/** An `analyze-run` verdict: a model output, so the class IS the input (see the note above). */
function authoredVerdict(verdictClass: VerdictClass, perTest = 0): Verdict {
  return {
    class: verdictClass,
    producer: 'analyze-run',
    confidence: 0.6,
    evidence: { citedSteps: [0], citedAnchors: [], citedArtifacts: [], rationale: ERROR_TEXT },
    memoryMisdirectionRuledOut: false,
    perTest,
  } as Verdict
}

/**
 * WHICH PRODUCER a fixture's verdict comes from — and the compile-time guard of this whole file.
 *
 * The two arms are mutually exclusive by TYPE (`?: undefined` on the opposite key), so
 * `{ produced: timedOutResult(), authored: 'flake' }` — scripting a failing member and forcing the
 * class the floor mints only on a PASS — does not compile. There is no longer any way in this file
 * to hand-write a `deterministic-classifier` verdict at all: the floor arm's class is whatever the
 * classifier answers for the scripted result, and nothing else.
 */
type FoldVerdictSpec =
  | { readonly authored: VerdictClass; readonly produced?: undefined }
  | { readonly produced: TestResult; readonly authored?: undefined }

function verdictFor(spec: FoldVerdictSpec, perTest = 0): Verdict {
  return spec.produced === undefined
    ? authoredVerdict(spec.authored, perTest)
    : producedVerdict(spec.produced, perTest)
}

// Plumbing legs use an authored verdict: with no same-ordinal pass, the floor would refuse.
const AUTHORED_FLAKE: FoldVerdictSpec = { authored: 'flake' }

function handoffFixture(input: {
  runId: string
  buildOrdinal: number
  passed?: boolean
  verdict?: FoldVerdictSpec
  testName?: string
  filePath?: string
}): CompletedRunHandoff {
  const passed = input.passed === true
  return {
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: input.runId,
    buildOrdinal: input.buildOrdinal,
    scope: SHOP_SCOPE,
    executionContext: 'ci',
    aggregateVerdict: passed ? 'passed' : 'failed',
    configDigests: {
      suiteConfigDigest: 'detection-suite-digest',
      testConfigDigest: 'detection-test-digest',
    },
    startedAt: input.buildOrdinal * 1_000,
    endedAt: input.buildOrdinal * 1_000 + 1,
    tests: [{
      testId: `${input.runId}-checkout`,
      testName: input.testName ?? TEST_NAME,
      filePath: input.filePath ?? FILE_PATH,
      testIndex: 0,
      outcome: passed ? 'passed' : 'failed',
      steps: [failingStep()],
      ...(passed
        ? {}
        : { rootCause: verdictFor(input.verdict ?? AUTHORED_FLAKE) }),
    } as unknown as PerTestOutcome],
  } as unknown as CompletedRunHandoff
}

/**
 * ONE run carrying TWO failing members whose ONLY difference is the resolved verdict class.
 * Same step, same anchor, same error text, same ordinal — so the class is genuinely the only
 * varied input, which is what makes the pair a differential rather than two examples.
 */
function twoClassHandoff(input: {
  runId: string
  buildOrdinal: number
  classA: VerdictClass
  classB: VerdictClass
}): CompletedRunHandoff {
  const member = (index: number, verdictClass: VerdictClass) => ({
    testId: `${input.runId}-${String(index)}`,
    testName: `${TEST_NAME} [${verdictClass}]`,
    filePath: `suite/${verdictClass}.test.ts`,
    testIndex: index,
    outcome: 'failed',
    steps: [failingStep()],
    // The AUTHORED path specifically: this differential varies the RESOLVED class directly,
    // which only an `analyze-run` verdict lets a fixture do (see the two-builders note above).
    rootCause: authoredVerdict(verdictClass, index),
  } as unknown as PerTestOutcome)
  return {
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: input.runId,
    buildOrdinal: input.buildOrdinal,
    scope: SHOP_SCOPE,
    executionContext: 'ci',
    aggregateVerdict: 'failed',
    configDigests: {
      suiteConfigDigest: 'detection-suite-digest',
      testConfigDigest: 'detection-test-digest',
    },
    startedAt: input.buildOrdinal * 1_000,
    endedAt: input.buildOrdinal * 1_000 + 1,
    tests: [member(0, input.classA), member(1, input.classB)],
  } as unknown as CompletedRunHandoff
}

interface FoldHarness {
  knowledgeRoot: string
}

function harness(prefix: string): FoldHarness {
  return {
    knowledgeRoot: tempDir(`${prefix}-knowledge-`),
  }
}

function fold(
  env: FoldHarness,
  handoff: CompletedRunHandoff,
  overrides: { now?: string; withoutQuarantine?: true } = {},
): FoldRunOutcomesReport {
  return foldRunOutcomes({
    knowledgeRoot: env.knowledgeRoot,
    handoff,
    extractAnchors,
    ...(overrides.withoutQuarantine === true ? {} : {
      quarantine: {
        now: overrides.now ?? NOW,
      },
    }),
  })
}

function ledgerPath(env: FoldHarness): string {
  return join(env.knowledgeRoot, QUARANTINE_LEDGER_FILENAME)
}

function ledgerLines(env: FoldHarness): Record<string, unknown>[] {
  if (!existsSync(ledgerPath(env))) return []
  return readFileSync(ledgerPath(env), 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

/** The A3 crossing, driven through three real folds: ordinals 1, 2, then the 3rd that escalates. */
function crossThreeInFive(env: FoldHarness, opts: {
  verdict?: FoldVerdictSpec
  testName?: string
  filePath?: string
} = {}): FoldRunOutcomesReport {
  let last: FoldRunOutcomesReport | undefined
  for (const buildOrdinal of [1, 2, 3]) {
    last = fold(env, handoffFixture({
      runId: `run-${opts.testName ?? 'default'}-${String(buildOrdinal)}`,
      buildOrdinal,
      ...(opts.verdict === undefined ? {} : { verdict: opts.verdict }),
      ...(opts.testName === undefined ? {} : { testName: opts.testName }),
      ...(opts.filePath === undefined ? {} : { filePath: opts.filePath }),
    }))
  }
  if (last === undefined) throw new Error('no fold ran')
  return last
}

function enteredEvent(overrides: Partial<Record<string, unknown>> = {}): QuarantineLedgerEvent {
  return {
    schemaVersion: CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION,
    kind: 'entered',
    at: '2026-07-06T12:00:00.000Z',
    product: PRODUCT,
    filePath: FILE_PATH,
    testName: TEST_NAME,
    fingerprint: 'seeded-fingerprint',
    verdictClass: 'flake',
    owner: QUARANTINE_UNASSIGNED_OWNER,
    expiresAt: '2026-12-01T12:00:00.000Z',
    ...overrides,
  } as QuarantineLedgerEvent
}

describe('detection is gated on the applied arm', () => {
  it('appends exactly one entered line when a run crosses 3-in-5 as a flake', () => {
    const env = harness('agent-qa-detect-cross')

    const report = crossThreeInFive(env)

    expect(report.kind).toBe('applied')
    expect(report.quarantine.kind).toBe('evaluated')
    expect(ledgerLines(env)).toEqual([{
      schemaVersion: CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION,
      kind: 'entered',
      at: NOW,
      product: PRODUCT,
      filePath: FILE_PATH,
      testName: TEST_NAME,
      fingerprint: expect.stringContaining('::flake') as unknown as string,
      verdictClass: 'flake',
      owner: QUARANTINE_UNASSIGNED_OWNER,
      expiresAt: EXPECTED_EXPIRY,
    }])
  })

  it('flags at the second ordinal and writes NOT ONE BYTE of ledger', () => {
    const env = harness('agent-qa-detect-flag')

    fold(env, handoffFixture({ runId: 'run-flag-1', buildOrdinal: 1 }))
    const report = fold(env, handoffFixture({ runId: 'run-flag-2', buildOrdinal: 2 }))

    if (report.quarantine.kind !== 'evaluated') throw new Error('expected an evaluation')
    expect(report.quarantine.flagged).toHaveLength(1)
    expect(report.quarantine.events).toEqual([])
    expect(existsSync(ledgerPath(env))).toBe(false)
  })

  it('re-draining the SAME run appends nothing — the marker short-circuits detection', () => {
    const env = harness('agent-qa-detect-refold')
    crossThreeInFive(env)
    const afterFirst = readFileSync(ledgerPath(env), 'utf8')

    // The exact bytes the tail would replay after a withheld receipt: the same handoff, again.
    const refold = fold(env, handoffFixture({ runId: 'run-default-3', buildOrdinal: 3 }))

    expect(refold).toEqual({
      kind: 'already-applied',
      tests: 0,
      quarantine: { kind: 'not-evaluated', reason: 'already-applied' },
    })
    expect(readFileSync(ledgerPath(env), 'utf8')).toBe(afterFirst)
  })

  it('does not evaluate at all when the caller asks for no detection', () => {
    const env = harness('agent-qa-detect-off')

    let report: FoldRunOutcomesReport | undefined
    for (const buildOrdinal of [1, 2, 3]) {
      report = fold(
        env,
        handoffFixture({ runId: `run-off-${String(buildOrdinal)}`, buildOrdinal }),
        { withoutQuarantine: true },
      )
    }

    expect(report?.quarantine).toEqual({ kind: 'not-evaluated', reason: 'not-requested' })
    expect(existsSync(ledgerPath(env))).toBe(false)
  })
})

describe('the append orders AFTER the commit, and self-heals', () => {
  it('appends no SECOND entered once the window is open — re-entry is suppressed', () => {
    const env = harness('agent-qa-detect-once')
    crossThreeInFive(env)

    const again = fold(env, handoffFixture({ runId: 'run-again-4', buildOrdinal: 4 }))

    if (again.quarantine.kind !== 'evaluated') throw new Error('expected an evaluation')
    expect(again.quarantine.events).toEqual([])
    expect(ledgerLines(env)).toHaveLength(1)
  })
})

describe('the fold report surfaces every failure mode as data', () => {
  function writeLedger(env: FoldHarness, text: string): void {
    mkdirSync(env.knowledgeRoot, { recursive: true })
    writeFileSync(ledgerPath(env), text, 'utf8')
  }

  it('carries refused ledger lines rather than healing them away', () => {
    const env = harness('agent-qa-detect-refused')
    // One good line and one damaged by hand; humans may edit this file.
    writeLedger(env, `${canonicalJson(enteredEvent())}\n{"kind":"entered"\n`)

    const report = fold(env, handoffFixture({ runId: 'run-refused-1', buildOrdinal: 1 }))

    if (report.quarantine.kind !== 'evaluated') throw new Error('expected an evaluation')
    expect(report.quarantine.refusedLines).toHaveLength(1)
    expect(report.quarantine.refusedLines[0]?.lineNumber).toBe(2)
  })

  it('refuses to evaluate against a ledger it cannot read, and says so', () => {
    const env = harness('agent-qa-detect-unreadable')
    writeLedger(env, `${canonicalJson({ ...enteredEvent(), schemaVersion: 99 })}\n`)

    const report = fold(env, handoffFixture({ runId: 'run-unreadable-1', buildOrdinal: 1 }))

    // The counters still applied — the projection is derived and rebuildable. What must NOT happen
    // is detection guessing at committed truth it cannot parse.
    expect(report.kind).toBe('applied')
    expect(report.quarantine.kind).toBe('ledger-unreadable')
  })
})

describe('auto-exit through the real fold', () => {
  function seedQuarantined(env: FoldHarness): void {
    appendQuarantineEvents(env.knowledgeRoot, [enteredEvent()])
  }

  it('releases after the 5th passing ordinal and NOT after the 4th', () => {
    const env = harness('agent-qa-detect-exit')
    seedQuarantined(env)

    for (const buildOrdinal of [1, 2, 3, 4]) {
      const partial = fold(env, handoffFixture({
        runId: `run-pass-${String(buildOrdinal)}`,
        buildOrdinal,
        passed: true,
      }))
      if (partial.quarantine.kind !== 'evaluated') throw new Error('expected an evaluation')
      expect(partial.quarantine.events).toEqual([])
    }
    expect(ledgerLines(env)).toHaveLength(1)

    const released = fold(env, handoffFixture({
      runId: 'run-pass-5',
      buildOrdinal: 5,
      passed: true,
    }))

    if (released.quarantine.kind !== 'evaluated') throw new Error('expected an evaluation')
    expect(released.quarantine.events).toHaveLength(1)
    expect(ledgerLines(env)[1]).toEqual({
      schemaVersion: CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION,
      kind: 'released-auto',
      at: NOW,
      product: PRODUCT,
      filePath: FILE_PATH,
      testName: TEST_NAME,
    })
  })

  // A lapsed entry still exits; the rule spans two filters, so only a fold-level test sees both.
  it('releases an entry whose deadline has already LAPSED, at the 5th passing ordinal and not the 4th', () => {
    const env = harness('agent-qa-detect-exit-expired')
    appendQuarantineEvents(
      env.knowledgeRoot,
      [enteredEvent({ expiresAt: '2026-07-10T12:00:00.000Z' })],
    )

    for (const buildOrdinal of [1, 2, 3, 4]) {
      const partial = fold(env, handoffFixture({
        runId: `run-lapsed-${String(buildOrdinal)}`,
        buildOrdinal,
        passed: true,
      }))
      if (partial.quarantine.kind !== 'evaluated') throw new Error('expected an evaluation')
      expect(partial.quarantine.events).toEqual([])
    }
    expect(ledgerLines(env)).toHaveLength(1)

    const released = fold(env, handoffFixture({
      runId: 'run-lapsed-5',
      buildOrdinal: 5,
      passed: true,
    }))
    if (released.quarantine.kind !== 'evaluated') throw new Error('expected an evaluation')
    expect(released.quarantine.events).toHaveLength(1)
    expect(ledgerLines(env)[1]).toEqual({
      schemaVersion: CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION,
      kind: 'released-auto',
      at: NOW,
      product: PRODUCT,
      filePath: FILE_PATH,
      testName: TEST_NAME,
    })

    // The probe fed a SIXTH ordinal; the release must not repeat, because the window it closed is
    // now CLOSED — the same complement asserted on the pure rule, here against committed bytes.
    const sixth = fold(env, handoffFixture({
      runId: 'run-lapsed-6',
      buildOrdinal: 6,
      passed: true,
    }))
    if (sixth.quarantine.kind !== 'evaluated') throw new Error('expected an evaluation')
    expect(sixth.quarantine.events).toEqual([])
    expect(ledgerLines(env)).toHaveLength(2)

    // …and the entry reads CLOSED rather than still-lapsed: `released-auto` over a lapsed window
    // folds to `released` because the computed-`expired` arm only ever reaches an OPEN one. No
    // further change was needed in `foldQuarantineLedgerState`, and this is what says so.
    const state = foldQuarantineLedgerState(readQuarantineLedger(env.knowledgeRoot).events, NOW)
    expect(state.map((entry) => entry.state)).toEqual(['released'])
  })

  it('COMPLEMENT: never re-releases a window a human already CLOSED', () => {
    const env = harness('agent-qa-detect-exit-released')
    appendQuarantineEvents(
      env.knowledgeRoot,
      [
        enteredEvent({ expiresAt: '2026-07-10T12:00:00.000Z' }),
        {
          schemaVersion: CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION,
          kind: 'released-manual',
          at: '2026-07-20T12:00:00.000Z',
          product: PRODUCT,
          filePath: FILE_PATH,
          testName: TEST_NAME,
        },
      ],
    )

    let report: FoldRunOutcomesReport | undefined
    for (const buildOrdinal of [1, 2, 3, 4, 5, 6]) {
      report = fold(env, handoffFixture({
        runId: `run-closed-${String(buildOrdinal)}`,
        buildOrdinal,
        passed: true,
      }))
    }

    if (report?.quarantine.kind !== 'evaluated') throw new Error('expected an evaluation')
    expect(report.quarantine.events).toEqual([])
    expect(ledgerLines(env)).toHaveLength(2)
  })

  // The two arms do not interfere: a lapsed entry whose test keeps FAILING authors nothing on the
  // exit path and still re-enters on the crossing path. Without this, "the exit path now admits a
  // lapsed window" could have been read as "a lapsed window leaves on any evidence at all".
  it('a LAPSED entry whose test keeps failing re-enters and is never released', () => {
    const env = harness('agent-qa-detect-exit-still-failing')
    appendQuarantineEvents(
      env.knowledgeRoot,
      [enteredEvent({ expiresAt: '2026-07-10T12:00:00.000Z' })],
    )

    crossThreeInFive(env)

    const lines = ledgerLines(env)
    expect(lines.map((line) => line.kind)).toEqual(['entered', 'entered'])
    expect(lines[1]).toMatchObject({ kind: 'entered', expiresAt: EXPECTED_EXPIRY })
  })
})

// Entries come from the committed ledger's fold, so a hand-written owner survives the round trip.

describe("the auto-entry's owner through the real fold", () => {
  it("carries a human's claim across a LAPSE and re-entry", () => {
    const env = harness('agent-qa-detect-owner-lapse')
    appendQuarantineEvents(
      env.knowledgeRoot,
      [enteredEvent({ owner: 'alice', expiresAt: '2026-07-10T12:00:00.000Z' })],
    )

    crossThreeInFive(env)

    const lines = ledgerLines(env)
    expect(lines.map((line) => line.kind)).toEqual(['entered', 'entered'])
    expect(lines[1]).toMatchObject({ kind: 'entered', owner: 'alice', expiresAt: EXPECTED_EXPIRY })
    // And the folded row a surface reads answers the claim too, not just the committed line.
    const { events } = readQuarantineLedger(env.knowledgeRoot)
    const state = foldQuarantineLedgerState(events, NOW)
    expect(state).toHaveLength(1)
    expect(state[0]).toMatchObject({ owner: 'alice', state: 'quarantined', enteredCount: 2 })
  })

  it('COMPLEMENT: starts unassigned after a window a human deliberately RELEASED', () => {
    const env = harness('agent-qa-detect-owner-released')
    appendQuarantineEvents(
      env.knowledgeRoot,
      [
        enteredEvent({ owner: 'alice' }),
        {
          schemaVersion: CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION,
          kind: 'released-manual',
          at: '2026-07-20T12:00:00.000Z',
          product: PRODUCT,
          filePath: FILE_PATH,
          testName: TEST_NAME,
        } as QuarantineLedgerEvent,
      ],
    )

    crossThreeInFive(env)

    const lines = ledgerLines(env)
    expect(lines.map((line) => line.kind)).toEqual(['entered', 'released-manual', 'entered'])
    expect(lines[2]).toMatchObject({ kind: 'entered', owner: QUARANTINE_UNASSIGNED_OWNER })
  })
})

describe('the anti-silencing differential in BOTH directions: flake and app_bug', () => {
  const FLAKE_TEST = `${TEST_NAME} [flake]`
  const APP_BUG_TEST = `${TEST_NAME} [app_bug]`

  /** The run-start snapshot rule, spelled the way agent-local spells it: state === open. */
  function activeQuarantineSet(env: FoldHarness): string[] {
    const read = readQuarantineLedger(env.knowledgeRoot)
    return foldQuarantineLedgerState(read.events, NOW)
      .filter((entry) => entry.state === 'quarantined')
      .map((entry) => entry.testName)
      .sort()
  }

  function crossBothClasses(env: FoldHarness): FoldRunOutcomesReport {
    let last: FoldRunOutcomesReport | undefined
    for (const buildOrdinal of [1, 2, 3]) {
      last = fold(env, twoClassHandoff({
        runId: `run-anti-silencing-${String(buildOrdinal)}`,
        buildOrdinal,
        classA: 'flake',
        classB: 'app_bug',
      }))
    }
    if (last === undefined) throw new Error('no fold ran')
    return last
  }

  it('quarantines the flake and REFUSES to quarantine the app_bug at the same recurrence', () => {
    const env = harness('agent-qa-anti-silencing')

    const report = crossBothClasses(env)

    if (report.quarantine.kind !== 'evaluated') throw new Error('expected an evaluation')

    // Both halves genuinely crossed: the negative half is not passing for want of recurrence
    // (an assertion that something did NOT happen is load-bearing only if the input could have
    // made it happen). Both sightings answer the same occurrence count.
    const escalated = report.quarantine.escalatedNotQuarantined
    expect(escalated.map((sight) => sight.testName)).toEqual([APP_BUG_TEST])
    expect(escalated[0]?.verdictClass).toBe('app_bug')
    expect(escalated[0]?.occurrenceOrdinals).toBe(QUARANTINE_ESCALATE_THRESHOLD)

    expect(report.quarantine.events).toHaveLength(1)
    expect(report.quarantine.events[0]).toMatchObject({
      kind: 'entered',
      testName: FLAKE_TEST,
      verdictClass: 'flake',
    })
    // The occurrence count the POSITIVE half acted on, so the two halves are comparable.
    expect(ledgerLines(env).map((line) => line.testName)).toEqual([FLAKE_TEST])
  })

  it('closes the loop to the run-start snapshot: the app_bug test is absent from the active set', () => {
    const env = harness('agent-qa-anti-silencing-snapshot')

    crossBothClasses(env)

    // The ledger the detection wrote, folded as a run start reads it: the app_bug test is absent.
    expect(activeQuarantineSet(env)).toEqual([FLAKE_TEST])
  })

  it('names AUTO_QUARANTINE_CLASSES as the thing under test', () => {
    // Both mutations this differential must detect, stated as data so the reason a reader can
    // check is the same one the probe checks: deleting 'flake' from the auto set must red the
    // positive half; adding 'app_bug' must red the negative half.
    expect(AUTO_QUARANTINE_CLASSES).toContain('flake')
    expect(AUTO_QUARANTINE_CLASSES).not.toContain('app_bug')
    expect(QUARANTINE_CLASS_DISPOSITIONS.flake).toBe('auto-quarantine')
    expect(QUARANTINE_CLASS_DISPOSITIONS.app_bug).toBe('escalate-only')
  })
})

// Each pair varies only `rootCause.producer`; everything else is held the same.
describe('a floor-produced crossing cannot buy a committed entry', () => {
  // `environment` needs an authored verdict; `timeout` lacks a same-build pass and fail here.
  const FLOOR_PRODUCED_CROSSINGS = [
    { verdictClass: 'environment' as VerdictClass, script: connectFailureResult },
    { verdictClass: 'timeout' as VerdictClass, script: timedOutResult },
  ]

  it.each(FLOOR_PRODUCED_CROSSINGS)(
    'the runner really does answer $verdictClass on the floor for that scripted member',
    ({ verdictClass, script }) => {
      expect(producedVerdict(script())).toMatchObject({
        class: verdictClass,
        producer: 'deterministic-classifier',
      })
    },
  )

  it.each(FLOOR_PRODUCED_CROSSINGS)(
    'writes ZERO ledger bytes for a floor-produced $verdictClass crossing, and escalates it instead',
    ({ verdictClass, script }) => {
      const env = harness(`agent-qa-floor-refuse-${verdictClass}`)

      const report = crossThreeInFive(env, { verdict: { produced: script() } })

      expect(report.kind).toBe('applied')
      if (report.quarantine.kind !== 'evaluated') throw new Error('expected an evaluation')
      expect(report.quarantine.events).toEqual([])
      expect(ledgerLines(env)).toEqual([])
      expect(report.quarantine.escalatedNotQuarantined).toHaveLength(1)
      expect(report.quarantine.escalatedNotQuarantined[0]).toMatchObject({
        product: PRODUCT,
        testName: TEST_NAME,
        verdictClass,
        producer: 'deterministic-classifier',
        occurrenceOrdinals: QUARANTINE_ESCALATE_THRESHOLD,
      })
      // Nothing suppresses, so the next failure still fails the build.
      expect(foldQuarantineLedgerState(readQuarantineLedger(env.knowledgeRoot).events, NOW))
        .toEqual([])
    },
  )

  it.each(FLOOR_PRODUCED_CROSSINGS)(
    'commits ONE entered line for the same $verdictClass crossing when analyze-run authored it',
    ({ verdictClass }) => {
      const env = harness(`agent-qa-floor-accept-${verdictClass}`)

      const report = crossThreeInFive(env, { verdict: { authored: verdictClass } })

      if (report.quarantine.kind !== 'evaluated') throw new Error('expected an evaluation')
      expect(report.quarantine.escalatedNotQuarantined).toEqual([])
      expect(report.quarantine.events).toHaveLength(1)
      expect(ledgerLines(env)).toEqual([{
        schemaVersion: CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION,
        kind: 'entered',
        at: NOW,
        product: PRODUCT,
        filePath: FILE_PATH,
        testName: TEST_NAME,
        fingerprint: expect.stringContaining(`::${verdictClass}`) as unknown as string,
        verdictClass,
        owner: QUARANTINE_UNASSIGNED_OWNER,
        expiresAt: EXPECTED_EXPIRY,
      }])
    },
  )

  it('mints `flake` only on a member that PASSED, so no failure row can carry it', () => {
    const passedOnRetry = passedOnRetryResult()
    expect(deriveMemberOutcome(passedOnRetry)).toBe('passed')
    expect(producedVerdict(passedOnRetry)).toMatchObject({
      class: 'flake',
      producer: 'deterministic-classifier',
    })
    // Without the retry the member gets no verdict: a clean pass is not a failure to explain.
    expect(classifyRootCause({
      result: { ...passedOnRetry, retryCount: 0 },
      outcome: deriveMemberOutcome({ ...passedOnRetry, retryCount: 0 }),
      testIndex: 0,
    })).toBeUndefined()
    // And the FAILING members the floor path is actually about are never flakes.
    expect(producedVerdict(timedOutResult())).toMatchObject({ class: 'timeout' })
    expect(producedVerdict(connectFailureResult())).toMatchObject({ class: 'environment' })

    // The consequence, through the REAL fold: three passing runs contribute no failure row at all,
    // so nothing crosses and not one byte is written — there is no crossing for a floor-produced
    // `flake` to be attached to.
    const env = harness('agent-qa-floor-flake-unbuildable')
    for (const buildOrdinal of [1, 2, 3]) {
      const report = fold(env, handoffFixture({
        runId: `run-flake-pass-${String(buildOrdinal)}`,
        buildOrdinal,
        passed: true,
      }))
      if (report.quarantine.kind !== 'evaluated') throw new Error('expected an evaluation')
      expect(report.quarantine.events).toEqual([])
      expect(report.quarantine.escalatedNotQuarantined).toEqual([])
    }
    expect(ledgerLines(env)).toEqual([])
  })
})

// Two entries at one ordinal need two applied runs; an in-run retry collapses into one outcome.
describe('a CROSSING test carries its own same-build pass∧fail into the gate', () => {
  /** One fold at `buildOrdinal`, floor-produced `timeout`, pass or fail. */
  function foldTimeout(env: FoldHarness, input: {
    runId: string
    buildOrdinal: number
    passed?: boolean
    testName?: string
    filePath?: string
  }): FoldRunOutcomesReport {
    return fold(env, handoffFixture({ ...input, verdict: { produced: timedOutResult() } }))
  }

  it('AUTO-QUARANTINES a floor-produced timeout whose window carries a same-build pass', () => {
    const env = harness('agent-qa-390-21-signature-set')

    // Ordinal 1 is driven TWICE — two separate applied runs, one failing and one passing, at ONE
    // build ordinal. That pair IS the signature; the ordinal-2 and ordinal-3 failures only carry
    // the fingerprint across the escalate threshold.
    foldTimeout(env, { runId: 'run-sig-1-fail', buildOrdinal: 1 })
    foldTimeout(env, { runId: 'run-sig-1-pass', buildOrdinal: 1, passed: true })
    foldTimeout(env, { runId: 'run-sig-2', buildOrdinal: 2 })
    const report = foldTimeout(env, { runId: 'run-sig-3', buildOrdinal: 3 })

    if (report.quarantine.kind !== 'evaluated') throw new Error('expected an evaluation')
    // No authored verdict participated anywhere: the producer on the crossing is the floor's.
    expect(report.quarantine.escalatedNotQuarantined).toEqual([])
    expect(report.quarantine.events).toHaveLength(1)
    expect(ledgerLines(env)).toEqual([{
      schemaVersion: CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION,
      kind: 'entered',
      at: NOW,
      product: PRODUCT,
      filePath: FILE_PATH,
      testName: TEST_NAME,
      fingerprint: expect.stringContaining('::timeout') as unknown as string,
      verdictClass: 'timeout',
      owner: QUARANTINE_UNASSIGNED_OWNER,
      expiresAt: EXPECTED_EXPIRY,
    }])
  })

  it('REFUSES the same crossing when every ordinal carries one answer — signature clear', () => {
    const env = harness('agent-qa-390-21-signature-clear')

    // The ONLY delta from the leg above: no second run at ordinal 1. Three failing ordinals still
    // cross, so the refusal is the signature's doing and not a sub-threshold window.
    foldTimeout(env, { runId: 'run-nosig-1', buildOrdinal: 1 })
    foldTimeout(env, { runId: 'run-nosig-2', buildOrdinal: 2 })
    const report = foldTimeout(env, { runId: 'run-nosig-3', buildOrdinal: 3 })

    if (report.quarantine.kind !== 'evaluated') throw new Error('expected an evaluation')
    expect(report.quarantine.events).toEqual([])
    expect(ledgerLines(env)).toEqual([])
    expect(report.quarantine.escalatedNotQuarantined).toHaveLength(1)
    expect(report.quarantine.escalatedNotQuarantined[0]).toMatchObject({
      testName: TEST_NAME,
      verdictClass: 'timeout',
      producer: 'deterministic-classifier',
      occurrenceOrdinals: QUARANTINE_ESCALATE_THRESHOLD,
    })
  })

  it('REFUSES a crossing for a test this run is the FIRST to count — one entry, no signature', () => {
    const env = harness('agent-qa-390-21-first-sighting')

    // Recurrence is keyed (product, fingerprint); a quarantine ENTRY is keyed on test identity.
    // So a test the projection has never counted can cross on its very first appearance, carried
    // over the threshold by a sibling that shares its failure signature. Its window then holds
    // exactly ONE entry — this run — and one entry can never be a same-build pass∧fail.
    //
    // This is the reachable form of the typed-absence case. The fold applies the projection BEFORE
    // it evaluates detection, so the crossing test ALWAYS has a row by the time the signature is
    // read; `readTestOutcomeHistory` returning `undefined` is a defensive branch the fold's own
    // ordering makes unreachable in-tree, pinned directly in
    // `projection/__tests__/run-outcome-read.test.ts` ("answers undefined for a missing row").
    const NEWCOMER = 'checkout retries the payment sheet [newcomer]'
    foldTimeout(env, { runId: 'run-first-1', buildOrdinal: 1 })
    foldTimeout(env, { runId: 'run-first-2', buildOrdinal: 2 })
    const report = foldTimeout(env, {
      runId: 'run-first-3',
      buildOrdinal: 3,
      testName: NEWCOMER,
      filePath: 'suite/newcomer.test.ts',
    })

    if (report.quarantine.kind !== 'evaluated') throw new Error('expected an evaluation')
    expect(report.quarantine.events).toEqual([])
    expect(ledgerLines(env)).toEqual([])
    expect(report.quarantine.escalatedNotQuarantined).toHaveLength(1)
    expect(report.quarantine.escalatedNotQuarantined[0]).toMatchObject({
      testName: NEWCOMER,
      verdictClass: 'timeout',
      occurrenceOrdinals: QUARANTINE_ESCALATE_THRESHOLD,
    })
  })

  // The crossing at 8 has window [4, 8]; nothing crosses earlier, and the ordinal-1 pair is below.
  it('REFUSES a crossing whose only pass-and-fail is OLDER than its own recurrence window', () => {
    const env = harness('agent-qa-390-24-stale-signature')

    const CROSSING_ORDINAL = 8
    const WINDOW_FLOOR = CROSSING_ORDINAL - QUARANTINE_WINDOW_ORDINALS + 1
    const STALE_ORDINAL = WINDOW_FLOOR - 3
    expect(STALE_ORDINAL).toBeLessThan(WINDOW_FLOOR)

    // The since-fixed flake episode: two applied runs at ONE ordinal, one failing, one passing.
    foldTimeout(env, { runId: 'run-stale-fail', buildOrdinal: STALE_ORDINAL })
    foldTimeout(env, { runId: 'run-stale-pass', buildOrdinal: STALE_ORDINAL, passed: true })

    // The NEW hard regression: threshold-many consecutive failing ordinals, all inside the window.
    let report!: FoldRunOutcomesReport
    for (let back = QUARANTINE_ESCALATE_THRESHOLD - 1; back >= 0; back -= 1) {
      const buildOrdinal = CROSSING_ORDINAL - back
      report = foldTimeout(env, { runId: `run-hard-${String(buildOrdinal)}`, buildOrdinal })
    }

    if (report.quarantine.kind !== 'evaluated') throw new Error('expected an evaluation')
    expect(report.quarantine.events).toEqual([])
    expect(ledgerLines(env)).toEqual([])
    expect(report.quarantine.escalatedNotQuarantined).toHaveLength(1)
    expect(report.quarantine.escalatedNotQuarantined[0]).toMatchObject({
      testName: TEST_NAME,
      verdictClass: 'timeout',
      producer: 'deterministic-classifier',
      occurrenceOrdinals: QUARANTINE_ESCALATE_THRESHOLD,
    })
  })

  // The pair sits exactly at the window floor, pinning the inclusive `>=` bound.
  it('ADMITS a pass-and-fail exactly AT the window floor — the boundary is inclusive', () => {
    const env = harness('agent-qa-390-24-floor-boundary')

    const CROSSING_ORDINAL = 8
    const WINDOW_FLOOR = CROSSING_ORDINAL - QUARANTINE_WINDOW_ORDINALS + 1

    // The flake episode, at the oldest ordinal the crossing's window still admits.
    foldTimeout(env, { runId: 'run-floor-fail', buildOrdinal: WINDOW_FLOOR })
    foldTimeout(env, { runId: 'run-floor-pass', buildOrdinal: WINDOW_FLOOR, passed: true })
    foldTimeout(env, { runId: 'run-floor-mid', buildOrdinal: CROSSING_ORDINAL - 1 })
    const report = foldTimeout(env, {
      runId: 'run-floor-crossing',
      buildOrdinal: CROSSING_ORDINAL,
    })

    if (report.quarantine.kind !== 'evaluated') throw new Error('expected an evaluation')
    expect(report.quarantine.escalatedNotQuarantined).toEqual([])
    expect(report.quarantine.events).toHaveLength(1)
    expect(ledgerLines(env)).toEqual([{
      schemaVersion: CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION,
      kind: 'entered',
      at: NOW,
      product: PRODUCT,
      filePath: FILE_PATH,
      testName: TEST_NAME,
      fingerprint: expect.stringContaining('::timeout') as unknown as string,
      verdictClass: 'timeout',
      owner: QUARANTINE_UNASSIGNED_OWNER,
      expiresAt: EXPECTED_EXPIRY,
    }])
  })

  // The pair at ordinal 12 sits above the crossing's window [4, 8]; folds may arrive out of order.
  it('REFUSES a crossing whose only pass-and-fail is ABOVE the crossing ordinal — the window is closed on both ends', () => {
    const env = harness('agent-qa-390-29-future-signature')

    const CROSSING_ORDINAL = 8
    const WINDOW_FLOOR = CROSSING_ORDINAL - QUARANTINE_WINDOW_ORDINALS + 1
    const FUTURE_ORDINAL = CROSSING_ORDINAL + QUARANTINE_WINDOW_ORDINALS - 1
    expect(FUTURE_ORDINAL).toBeGreaterThan(CROSSING_ORDINAL)
    expect(WINDOW_FLOOR).toBeLessThan(CROSSING_ORDINAL)

    // The flake episode recorded ABOVE the crossing: two applied runs at ONE ordinal, one failing,
    // one passing — folded first, exactly as an out-of-order build ordinal arrives.
    foldTimeout(env, { runId: 'run-future-fail', buildOrdinal: FUTURE_ORDINAL })
    foldTimeout(env, { runId: 'run-future-pass', buildOrdinal: FUTURE_ORDINAL, passed: true })

    // The hard regression BELOW it: threshold-many consecutive failing ordinals, no pass near them.
    let report!: FoldRunOutcomesReport
    for (let back = QUARANTINE_ESCALATE_THRESHOLD - 1; back >= 0; back -= 1) {
      const buildOrdinal = CROSSING_ORDINAL - back
      report = foldTimeout(env, { runId: `run-below-${String(buildOrdinal)}`, buildOrdinal })
    }

    if (report.quarantine.kind !== 'evaluated') throw new Error('expected an evaluation')
    expect(report.quarantine.events).toEqual([])
    expect(ledgerLines(env)).toEqual([])
    expect(report.quarantine.escalatedNotQuarantined).toHaveLength(1)
    expect(report.quarantine.escalatedNotQuarantined[0]).toMatchObject({
      testName: TEST_NAME,
      verdictClass: 'timeout',
      producer: 'deterministic-classifier',
      occurrenceOrdinals: QUARANTINE_ESCALATE_THRESHOLD,
    })
  })
})

// A floor `environment` verdict comes from the shared probe; authored ones still enter.
describe('one down dependency cannot blanket-quarantine a suite', () => {
  const SUITE_SIZE = 6

  /** N distinct failing members in ONE run — distinct TESTS, one shared failure signature. */
  function suiteHandoff(input: {
    runId: string
    buildOrdinal: number
    verdict: FoldVerdictSpec
  }): CompletedRunHandoff {
    const member = (index: number) => ({
      testId: `${input.runId}-${String(index)}`,
      testName: `${TEST_NAME} ${String(index)}`,
      filePath: `suite/member-${String(index)}.test.ts`,
      testIndex: index,
      outcome: 'failed',
      steps: [{
        ...failingStep(),
        // MEASURED note, verified against the committed bytes rather than assumed: the error-text
        // normalizer scrubs digits, so `(member 0)`…`(member 5)` collapse to ONE fingerprint. That
        // is faithful, not a fixture accident — a down dependency produces the same failure
        // signature on every member, which is what the 6/6 event looked like. Six distinct
        // ENTRIES still result, because a quarantine entry is keyed on test identity
        // (product, filePath, testName) while recurrence is keyed on (product, fingerprint).
        verifierVerdict: { pass: false, reasoning: `${ERROR_TEXT} (member ${String(index)})` },
      } as unknown as StepEvidence],
      rootCause: verdictFor(input.verdict, index),
    } as unknown as PerTestOutcome)
    return {
      schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
      runId: input.runId,
      buildOrdinal: input.buildOrdinal,
      scope: SHOP_SCOPE,
      executionContext: 'ci',
      aggregateVerdict: 'failed',
      configDigests: {
        suiteConfigDigest: 'detection-suite-digest',
        testConfigDigest: 'detection-test-digest',
      },
      startedAt: input.buildOrdinal * 1_000,
      endedAt: input.buildOrdinal * 1_000 + 1,
      tests: Array.from({ length: SUITE_SIZE }, (_unused, index) => member(index)),
    } as unknown as CompletedRunHandoff
  }

  function crossWholeSuite(
    env: FoldHarness,
    label: string,
    verdict: FoldVerdictSpec,
  ): FoldRunOutcomesReport {
    let last: FoldRunOutcomesReport | undefined
    for (const buildOrdinal of [1, 2, 3]) {
      last = fold(env, suiteHandoff({
        runId: `run-mass-${label}-${String(buildOrdinal)}`,
        buildOrdinal,
        verdict,
      }))
    }
    if (last === undefined) throw new Error('no fold ran')
    return last
  }

  it('writes ZERO entered lines for six floor-produced environment failures', () => {
    const env = harness('agent-qa-mass-floor')

    // PRODUCED: six members each scripted with a connect failure — one down dependency, which is
    // exactly the shape the measured 6-of-6 event took.
    const report = crossWholeSuite(env, 'floor', { produced: connectFailureResult() })

    expect(report.kind).toBe('applied')
    if (report.quarantine.kind !== 'evaluated') throw new Error('expected an evaluation')
    expect(report.quarantine.events).toEqual([])
    expect(ledgerLines(env)).toEqual([])

    // All six are LOUD, and every one of them genuinely crossed — a zero that came from six
    // sub-threshold windows would prove nothing about the gate.
    const escalated = report.quarantine.escalatedNotQuarantined
    expect(escalated).toHaveLength(SUITE_SIZE)
    for (const sighting of escalated) {
      expect(sighting.verdictClass).toBe('environment')
      expect(sighting.producer).toBe('deterministic-classifier')
      expect(sighting.occurrenceOrdinals).toBe(QUARANTINE_ESCALATE_THRESHOLD)
    }
    // Nothing suppresses anything: the whole suite still fails the next build.
    expect(foldQuarantineLedgerState(readQuarantineLedger(env.knowledgeRoot).events, NOW))
      .toEqual([])
  })

  it('writes SIX entered lines for the same six failures once analyze-run authored them', () => {
    const env = harness('agent-qa-mass-authored')

    const report = crossWholeSuite(env, 'authored', { authored: 'environment' })

    if (report.quarantine.kind !== 'evaluated') throw new Error('expected an evaluation')
    expect(report.quarantine.escalatedNotQuarantined).toEqual([])
    expect(report.quarantine.events).toHaveLength(SUITE_SIZE)

    const lines = ledgerLines(env)
    expect(lines).toHaveLength(SUITE_SIZE)
    expect(lines.map((line) => line.testName).sort()).toEqual(
      Array.from({ length: SUITE_SIZE }, (_unused, index) => `${TEST_NAME} ${String(index)}`).sort(),
    )
    // The measured event's signature: one shared 30-day deadline across the whole suite. The
    // fixture is genuinely capable of mass-quarantining, so the zero above is the gate's doing.
    expect(new Set(lines.map((line) => line.expiresAt))).toEqual(new Set([EXPECTED_EXPIRY]))
    expect(new Set(lines.map((line) => line.verdictClass))).toEqual(new Set(['environment']))
  })
})

// The cap rate-limits: the next applied run admits the member the previous one refused.
describe('the floor cap rate-limits a multi-member fan-out', () => {
  // CAP + 1 — the SMALLEST suite that can overflow, so a refusal here is the cap's doing and not
  // an arbitrary surplus. Derived from the constant, never a literal 3: if the cap is ever retuned
  // the fixture resizes with it and the leg keeps measuring the same property.
  const CAP_SUITE_SIZE = QUARANTINE_FLOOR_AUTO_QUARANTINE_CAP + 1

  const capMemberName = (index: number): string => `${TEST_NAME} [cap ${String(index)}]`
  const capMemberPath = (index: number): string => `suite/cap-member-${String(index)}.test.ts`

  // Digits are normalized away, so members share one fingerprint but each gets its own entry.
  function capSuiteHandoff(input: {
    runId: string
    buildOrdinal: number
    passed?: boolean
    reversed?: boolean
  }): CompletedRunHandoff {
    const passed = input.passed === true
    const member = (index: number) => ({
      testId: `${input.runId}-${String(index)}`,
      testName: capMemberName(index),
      filePath: capMemberPath(index),
      testIndex: index,
      outcome: passed ? 'passed' : 'failed',
      steps: [{
        ...failingStep(),
        verifierVerdict: { pass: false, reasoning: `${ERROR_TEXT} (member ${String(index)})` },
      } as unknown as StepEvidence],
      // The FLOOR arm, produced: the classifier is asked what a member that blew its deadline is,
      // and answers `timeout` / `deterministic-classifier`. The `FoldVerdictSpec` compile-guard is
      // intact — no verdict in this leg is hand-written, and the passing branch carries none at all.
      ...(passed ? {} : { rootCause: verdictFor({ produced: timedOutResult() }, index) }),
    } as unknown as PerTestOutcome)
    return {
      schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
      runId: input.runId,
      buildOrdinal: input.buildOrdinal,
      scope: SHOP_SCOPE,
      executionContext: 'ci',
      aggregateVerdict: passed ? 'passed' : 'failed',
      configDigests: {
        suiteConfigDigest: 'detection-suite-digest',
        testConfigDigest: 'detection-test-digest',
      },
      startedAt: input.buildOrdinal * 1_000,
      endedAt: input.buildOrdinal * 1_000 + 1,
      tests: Array.from(
        { length: CAP_SUITE_SIZE },
        (_unused, index) => member(input.reversed === true ? CAP_SUITE_SIZE - 1 - index : index),
      ),
    } as unknown as CompletedRunHandoff
  }

  function foldCapSuite(env: FoldHarness, input: {
    runId: string
    buildOrdinal: number
    passed?: boolean
    reversed?: boolean
  }): FoldRunOutcomesReport {
    return fold(env, capSuiteHandoff(input))
  }

  // Ordinal 1 runs twice, failing then passing, which is each member's same-build signature.
  function driveToCrossing(
    env: FoldHarness,
    options: { reversed?: boolean } = {},
  ): FoldRunOutcomesReport {
    const reversed = options.reversed === true
    expect(3 - QUARANTINE_WINDOW_ORDINALS + 1).toBeLessThanOrEqual(1)
    foldCapSuite(env, { runId: 'run-cap-1-fail', buildOrdinal: 1, reversed })
    foldCapSuite(env, { runId: 'run-cap-1-pass', buildOrdinal: 1, passed: true, reversed })
    foldCapSuite(env, { runId: 'run-cap-2', buildOrdinal: 2, reversed })
    return foldCapSuite(env, { runId: 'run-cap-3', buildOrdinal: 3, reversed })
  }

  it('admits exactly CAP of three floor-admissible crossings in ONE evaluation, by identity order — handed to the fold BACK TO FRONT', () => {
    const env = harness('agent-qa-390-28-cap-domain')

    const report = driveToCrossing(env, { reversed: true })

    expect(report.kind).toBe('applied')
    if (report.quarantine.kind !== 'evaluated') throw new Error('expected an evaluation')

    // THE DOMAIN IS REAL: all CAP_SUITE_SIZE members crossed the escalate threshold on the floor
    // arm in this one call, so the cap had something to refuse. A leg where only CAP crossed would
    // measure nothing.
    expect(report.quarantine.events.length + report.quarantine.escalatedNotQuarantined.length)
      .toBe(CAP_SUITE_SIZE)

    // Members arrive back to front, so admitting by identity order is what this assertion pins.
    expect(report.quarantine.events).toHaveLength(QUARANTINE_FLOOR_AUTO_QUARANTINE_CAP)
    expect(report.quarantine.events.map((event) => event.testName)).toEqual([
      'checkout retries the payment sheet [cap 0]',
      'checkout retries the payment sheet [cap 1]',
    ])

    // AND THE OVERFLOW IS LOUD, never dropped: the third member is refused as DATA, still failing.
    expect(report.quarantine.escalatedNotQuarantined).toHaveLength(1)
    expect(report.quarantine.escalatedNotQuarantined[0]).toMatchObject({
      testName: 'checkout retries the payment sheet [cap 2]',
      verdictClass: 'timeout',
      producer: 'deterministic-classifier',
      occurrenceOrdinals: QUARANTINE_ESCALATE_THRESHOLD,
    })

    // The committed bytes agree with the report — the cap is not merely a reporting artifact.
    expect(ledgerLines(env).map((line) => line.testName)).toEqual([
      'checkout retries the payment sheet [cap 0]',
      'checkout retries the payment sheet [cap 1]',
    ])
  })

  it('drains the refused member on the NEXT applied run — the cap rate-limits, it does not contain', () => {
    const env = harness('agent-qa-390-28-cap-drain')

    driveToCrossing(env)
    const report = foldCapSuite(env, { runId: 'run-cap-4', buildOrdinal: 4 })

    if (report.quarantine.kind !== 'evaluated') throw new Error('expected an evaluation')

    // The two OPEN entries do not re-enter — an already-quarantined test is skipped before the
    // ladder — so this run's single admission is the previously-refused member and nothing else.
    // Its window at the crossing ordinal 4 is [0, 4], which still holds the ordinal-1 signature.
    expect(report.quarantine.events).toHaveLength(1)
    expect(report.quarantine.events[0]).toMatchObject({
      kind: 'entered',
      testName: 'checkout retries the payment sheet [cap 2]',
      verdictClass: 'timeout',
    })
    // Nothing is refused any more: one admission is under the cap, so the counter that bit last
    // run is silent this run. That asymmetry between two identical suites one ordinal apart is the
    // rate-limit, stated as a measurement.
    expect(report.quarantine.escalatedNotQuarantined).toEqual([])

    // THE HEADLINE NUMBER: the whole suite is quarantined after all, one run later. The cap bought
    // one build of visibility per overflow member and no ceiling whatsoever.
    expect(ledgerLines(env).map((line) => line.testName)).toEqual([
      'checkout retries the payment sheet [cap 0]',
      'checkout retries the payment sheet [cap 1]',
      'checkout retries the payment sheet [cap 2]',
    ])
    expect(ledgerLines(env)).toHaveLength(CAP_SUITE_SIZE)
    expect(foldQuarantineLedgerState(readQuarantineLedger(env.knowledgeRoot).events, NOW))
      .toHaveLength(CAP_SUITE_SIZE)
  })
})
