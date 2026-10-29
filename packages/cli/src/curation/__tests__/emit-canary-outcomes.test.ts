import { emptyCanaryCreditCounters } from '../canary-credit.js'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

import { HANDOFF_FILE, loadCompletedRunHandoff } from '@vostride/agent-qa-runner-local'
import {
  CURRENT_HANDOFF_SCHEMA_VERSION,
  ANALYSIS_FILE,
  asRecordId,
  asRef,
  asRunId,
  canonicalJson,
  CURRENT_ANALYSIS_SCHEMA_VERSION,
  normalizeAnchor,
  type Anchor,
  type CanaryOutcome,
  type CompletedRunHandoff,
  type ElementInfo,
  type PerTestOutcome,
  type RunAnalysisArtifact,
  type ScreenState,
  type StepEvidence,
  type StepPlanSource,
  type SubActionEvidence,
  type Verdict,
} from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const lookupSpy = vi.hoisted(() => ({
  anchorsById: new Map<string, Anchor[]>(),
  invalidById: new Map<string, string>(),
  openCalls: [] as string[],
}))

vi.mock('@vostride/agent-qa-knowledge-local', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('@vostride/agent-qa-knowledge-local')
  >()
  return {
    ...actual,
    readCanonicalBundleAnchors: vi.fn((input: { knowledgeRoot: string; bundleId: string }) => {
      lookupSpy.openCalls.push(input.knowledgeRoot)
      const invalid = lookupSpy.invalidById.get(input.bundleId)
      if (invalid !== undefined) {
        return { kind: 'unresolved' as const, reason: 'invalid' as const, detail: invalid }
      }
      const anchors = lookupSpy.anchorsById.get(input.bundleId)
      return anchors === undefined
        ? { kind: 'unresolved' as const, reason: 'not-found' as const }
        : {
            kind: 'resolved' as const,
            bundleId: asRecordId(input.bundleId),
            product: 'storefront',
            anchors,
          }
    }),
  }
})

import {
  emitCanaryOutcomes,
  NON_SIGNAL_CLASSES,
  isNonSignalClass,
  projectCanaryOutcomes,
} from '../emit-canary-outcomes.js'

const CANDIDATE = asRecordId('candidate-checkout')
const OTHER_CANDIDATE = asRecordId('candidate-other')
const PROCEDURE = asRecordId('procedure-sign-in')
const PROCEDURE_ANCHORS: Anchor[] = [
  { t: 'flow', name: 'Sign in flow' },
  { t: 'page', route: '/login' },
]

describe('the shipped positive-on-any-anchor-match fixture earns no credit', () => {
  let creditRunDir: string
  afterEach(() => rmSync(creditRunDir, { recursive: true, force: true }))
  it('declares exactly the three non-signal classes, in declaration order', () => {
    expect([...NON_SIGNAL_CLASSES]).toEqual(['environment', 'timeout', 'flake'])
    for (const value of ['environment', 'timeout', 'flake'] as const) expect(isNonSignalClass(value)).toBe(true)
    for (const value of ['unknown', 'app_bug'] as const) expect(isNonSignalClass(value)).toBe(false)
    expect(isNonSignalClass('product')).toBe(false)
  })

  it.each(['passed', 'failed'] as const)('excludes all sources of a %s rerun member while its sibling attributes', async outcome => {
    const input = handoff([step({ pass: outcome === 'passed', planSource: replaySource() })], rootCause('app_bug'))
    input.tests[0] = { ...input.tests[0], outcome, isRerun: true, rerunAttempt: 2 }
    input.tests.push({ ...input.tests[0], isRerun: undefined, rerunAttempt: undefined,
      testIndex: 1, testId: 'checkout::sibling', steps: [step()] })
    const emit = vi.fn()
    const report = await emitCanaryOutcomes({ handoff: input,
      knowledgeRoot: '/tmp/agent-qa-knowledge', runDir: creditRunDir, emit })
    expect(report.canary.rerunExcluded).toBe(1)
    expect(report.details[0]).toEqual({ testId: input.tests[0].testId, testIndex: 0,
      outcome: { kind: 'rerun-excluded' } })
    expect(emit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ testIndex: 1 }))
    expect(report).toMatchObject({ refused: 0, unresolved: 0, procedure: { emitted: 0 } })
  })

  it('counts typed non-signal classes and keeps unknown failures visible', async () => {
    const input = handoff([step({ pass: false })], rootCause('environment'))
    input.tests = (['environment', 'timeout', 'flake', 'unknown'] as const).map((value, index) => ({
      ...input.tests[0], testIndex: index, testId: `checkout::class-${index}`,
      rootCause: { ...rootCause(value), perTest: index },
    }))
    const emit = vi.fn()
    const report = await emitCanaryOutcomes({ handoff: input,
      knowledgeRoot: '/tmp/agent-qa-knowledge', runDir: creditRunDir, emit })
    expect(report.canary.nonSignal.environment).toBe(1)
    expect(report.canary.nonSignal.timeout).toBe(1)
    expect(report.canary.nonSignal.flake).toBe(1)
    expect(report.details.slice(0, 3).map(row => row.outcome)).toEqual([
      { kind: 'non-signal', class: 'environment' },
      { kind: 'non-signal', class: 'timeout' },
      { kind: 'non-signal', class: 'flake' },
    ])
    expect(emit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ testIndex: 3, runOutcome: 'negative' }))
    expect(report).toMatchObject({ refused: 0, unresolved: 0 })
    expect(project(input, lookupSpy.anchorsById)).toHaveLength(1)
  })
  beforeEach(() => {
    creditRunDir = mkdtempSync(join(tmpdir(), 'agent-qa-credit-completion-'))
    lookupSpy.anchorsById.clear()
    lookupSpy.invalidById.clear()
    lookupSpy.anchorsById.set(CANDIDATE, [{ t: 'el', role: 'button', name: 'checkout', ordinal: 0 }])
  })
  it('emits a positive served row as uncredited ride-along with unknown state validity', async () => {
    const emit = vi.fn()
    const report = await emitCanaryOutcomes({
      handoff: handoff([step()]), knowledgeRoot: '/tmp/agent-qa-knowledge', runDir: creditRunDir, emit,
    })
    expect(emit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ benefit: 'rode-along' }))
    expect(report.canary.rideAlongUncredited).toBe(1)
    expect(report.refused).toBe(0)
    expect(report.details[0]).toEqual(expect.objectContaining({ benefit: 'rode-along', outcome: { kind: 'emitted' } }))
  })
})

type GuardMissReason = NonNullable<
  Extract<StepPlanSource, { kind: 'procedure-replay' }>['guard']['miss']
>['reason']

function replaySource(miss?: GuardMissReason): StepPlanSource {
  return {
    kind: 'procedure-replay',
    procedureId: PROCEDURE,
    guard: {
      checksPassed: miss === undefined ? 3 : 1,
      total: 3,
      ...(miss === undefined
        ? {}
        : { miss: { procedureStepIndex: 1, reason: miss } }),
    },
  }
}

function replayExecutionFailureSource(procedureStepIndex = 0): StepPlanSource {
  return {
    kind: 'procedure-replay',
    procedureId: PROCEDURE,
    guard: {
      checksPassed: 0,
      total: 3,
      executionFailure: { procedureStepIndex },
    },
  }
}

function replayVerifierRejectionSource(procedureStepIndex = 0): StepPlanSource {
  return {
    kind: 'procedure-replay',
    procedureId: PROCEDURE,
    guard: {
      checksPassed: procedureStepIndex + 1,
      total: 3,
      verifierRejection: { procedureStepIndex },
    },
  }
}

function replayIncompleteSource(checksPassed = 1): StepPlanSource {
  return {
    kind: 'procedure-replay',
    procedureId: PROCEDURE,
    guard: { checksPassed, total: 3 },
  }
}

function element(ref = 'checkout'): ElementInfo {
  return {
    ref: asRef(ref),
    role: 'button',
    name: 'Checkout',
    nameNormalized: 'checkout',
    bounds: { x: 10, y: 20, width: 100, height: 40 },
    center: { x: 60, y: 40 },
    state: { enabled: true, focused: false, visible: true, clickable: true },
    labels: { ariaLabel: 'Checkout' },
    attributes: { 'data-testid': ref },
  }
}

function screen(elements: ElementInfo[], url?: string): ScreenState {
  return {
    platform: 'web',
    tree: elements.map((entry) => `${entry.role} ${entry.name}`).join('\n'),
    elements,
    refMap: Object.fromEntries(elements.map((entry) => [entry.ref, {
      bounds: entry.bounds!,
      center: entry.center!,
    }])),
    ...(url === undefined ? {} : { url }),
    timestamp: 1_750_000_000_000,
    metadata: {
      captureMode: 'textOnly',
      coordSpace: 'viewport',
      viewportWidth: 1_280,
      viewportHeight: 720,
      scroll: {
        offsetX: 0,
        offsetY: 0,
        contentWidth: 1_280,
        contentHeight: 1_440,
      },
    },
  }
}

function subAction(input: {
  ref?: string
  beforeUrl?: string
  afterUrl?: string
} = {}): SubActionEvidence {
  const elements = input.ref === undefined ? [] : [element(input.ref)]
  return {
    plan: input.ref === undefined ? 'Navigate' : `Use ${input.ref}`,
    exchanges: [],
    plannedAction: input.ref === undefined
      ? { type: 'navigate', to: 'reload' }
      : { type: 'click', ref: asRef(input.ref) },
    stateBefore: screen(elements, input.beforeUrl),
    stateAfter: screen(elements, input.afterUrl ?? input.beforeUrl),
    result: { success: true },
  }
}

function step(input: {
  stepIndex?: number
  pass?: boolean
  candidateIds?: readonly string[]
  subActions?: SubActionEvidence[]
  planSource?: StepPlanSource
} = {}): StepEvidence {
  const stepIndex = input.stepIndex ?? 0
  return {
    ...(input.planSource === undefined ? {} : { planSource: input.planSource }),
    stepIndex,
    stepText: `Step ${stepIndex}`,
    cacheStatus: 'miss',
    servedBrief: {
      scope: { tier: 'product', key: 'storefront' },
      asOfBuild: 42,
      budget: 1_000,
      truncation: 'none',
      channel1: (input.candidateIds ?? [CANDIDATE]).map((id) => ({
        id: asRecordId(id),
        kind: 'fact',
        summary: `Canary ${id}`,
        trust: 0.2,
        status: 'candidate',
        servedAsCanary: true,
        tier: 'L2',
      })),
      channel2: [],
      channel3: [],
      briefDigest: `brief-digest-${stepIndex}`,
    },
    subActions: input.subActions ?? [subAction({ ref: 'checkout', beforeUrl: '/cart' })],
    verifierVerdict: {
      pass: input.pass ?? true,
      reasoning: input.pass === false ? 'Checkout did not open' : 'Checkout opened',
    },
  }
}

function rootCause(kind: Verdict['class']): Verdict {
  return {
    class: kind,
    producer: 'deterministic-classifier',
    confidence: 1,
    evidence: {
      citedSteps: [0],
      citedAnchors: [{ t: 'flow', name: 'checkout' }],
      citedArtifacts: [],
      rationale: `${kind} failure`,
    },
    memoryMisdirectionRuledOut: true,
    perTest: 0,
  }
}

function handoff(steps: StepEvidence[], cause?: Verdict): CompletedRunHandoff {
  const aggregateVerdict = steps.every((entry) => entry.verifierVerdict.pass)
    ? 'passed'
    : 'failed'
  const test: PerTestOutcome = {
    testId: 'checkout::happy-path',
    testName: 'Checkout happy path',
    filePath: 'checkout.spec.yaml',
    testIndex: 0,
    outcome: aggregateVerdict,
    steps,
    ...(cause === undefined ? {} : { rootCause: cause }),
  }
  return {
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: asRunId('run-canary-1'),
    scope: { tier: 'product', key: 'storefront' },
    buildOrdinal: 42,
    executionContext: 'local-interactive',
    aggregateVerdict,
    configDigests: { suiteConfigDigest: 'suite', testConfigDigest: 'test' },
    startedAt: 1_750_000_000_000,
    endedAt: 1_750_000_001_000,
    tests: [test],
  }
}

function project(
  input: CompletedRunHandoff,
  anchorsById: ReadonlyMap<string, Anchor[]>,
) {
  return projectCanaryOutcomes({
    handoff: input,
    resolveCandidateAnchors: (id) => {
      const anchors = anchorsById.get(id)
      return anchors === undefined
        ? { kind: 'unresolved', reason: 'not-found' }
        : { kind: 'resolved', anchors }
    },
  })
}

describe('projectCanaryOutcomes', () => {
  it('attributes a normalized resolved-element contact to one positive step outcome', async () => {
    const outcomes = project(handoff([step()]), new Map([[CANDIDATE, [{
      t: 'el',
      role: ' Button ',
      name: ' CHECKOUT ',
      ordinal: 0,
    }]]]))

    expect(outcomes).toEqual([{
      candidateId: CANDIDATE,
      runOutcome: 'positive',
      benefit: 'rode-along',
      runId: 'run-canary-1',
      testId: 'checkout::happy-path',
      testIndex: 0,
      buildOrdinal: 42,
      stepIndex: 0,
      briefDigest: 'brief-digest-0',
      attribution: expect.stringContaining('candidate-checkout'),
      exercisedAnchor: { t: 'el', role: 'button', name: 'checkout', ordinal: 0 },
    }])
  })

  it('produces no outcome when a served canary never contacts a matching anchor', async () => {
    const outcomes = project(handoff([step()]), new Map([[CANDIDATE, [{
      t: 'el',
      role: 'button',
      name: 'place order',
      ordinal: 0,
    }]]]))

    expect(outcomes).toEqual([])
  })

  it('uses the live grounding resolution instead of a stale planned ref', async () => {
    const grounded = subAction({ ref: 'stale', beforeUrl: '/cart' })
    grounded.stateBefore = screen([element('checkout'), element('stale')], '/cart')
    grounded.grounding = {
      descriptor: { role: 'button', name: 'Checkout' },
      attempts: [{ stage: 'tree-search', outcome: 'resolved', resolvedRef: asRef('checkout') }],
    }
    const outcomes = project(
      handoff([step({ subActions: [grounded] })]),
      new Map([[CANDIDATE, [{
        t: 'el',
        role: 'button',
        name: 'checkout',
        ordinal: 0,
      }]]]),
    )

    expect(outcomes).toEqual([
      expect.objectContaining({
        candidateId: CANDIDATE,
        exercisedAnchor: { t: 'el', role: 'button', name: 'checkout', ordinal: 0 },
      }),
    ])
  })

  it('excludes environment, timeout, and flake failures but attributes other failures', async () => {
    const candidateAnchors = new Map([[CANDIDATE, [{
      t: 'el' as const,
      role: 'button',
      name: 'checkout',
      ordinal: 0,
    }]]])

    for (const excluded of ['environment', 'timeout', 'flake'] as const) {
      expect(project(handoff([step({ pass: false })], rootCause(excluded)), candidateAnchors))
        .toEqual([])
    }

    for (const cause of [undefined, rootCause('app_bug')]) {
      const outcomes = project(handoff([step({ pass: false })], cause), candidateAnchors)
      expect(outcomes).toEqual([
        expect.objectContaining({ candidateId: CANDIDATE, runOutcome: 'negative' }),
      ])
    }
  })

  it('attributes a candidate whose page anchor matches the classified route', async () => {
    const routeStep = step({
      subActions: [subAction({ beforeUrl: '/cart', afterUrl: '/Checkout/?Mode=FAST#receipt' })],
    })
    const outcomes = project(handoff([routeStep]), new Map([[CANDIDATE, [{
      t: 'page',
      route: ' /checkout/?mode=fast ',
    }]]]))

    expect(outcomes).toEqual([
      expect.objectContaining({
        runOutcome: 'positive',
        benefit: 'rode-along',
        exercisedAnchor: { t: 'page', route: '/checkout?mode=fast' },
      }),
    ])
  })

  it('is byte-deterministic and emits once per candidate and exercised step', async () => {
    const firstStep = step({
      stepIndex: 0,
      candidateIds: [CANDIDATE, CANDIDATE],
    })
    const secondStep = step({ stepIndex: 1 })
    const input = handoff([firstStep, secondStep])
    const anchors = new Map([[CANDIDATE, [{
      t: 'el' as const,
      role: 'button',
      name: 'checkout',
      ordinal: 0,
    }]]])

    const first = project(input, anchors)
    const second = project(input, anchors)

    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
    expect(first).toHaveLength(2)
    expect(first.map((outcome) => outcome.stepIndex)).toEqual([0, 1])
  })

  it('keeps same-index steps from different tests independently attributable', async () => {
    const input = handoff([step({ stepIndex: 0 })])
    input.aggregateVerdict = 'failed'
    input.tests.push({
      testId: 'checkout::declined-card',
      testName: 'Checkout with a declined card',
      filePath: 'checkout.spec.yaml',
      testIndex: 1,
      outcome: 'failed',
      steps: [step({ stepIndex: 0, pass: false })],
    })
    const outcomes = project(input, new Map([[CANDIDATE, [{
      t: 'el',
      role: 'button',
      name: 'checkout',
      ordinal: 0,
    }]]]))

    expect(outcomes).toEqual([
      expect.objectContaining({
        testId: 'checkout::happy-path',
        testIndex: 0,
        stepIndex: 0,
        runOutcome: 'positive',
        benefit: 'rode-along',
      }),
      expect.objectContaining({
        testId: 'checkout::declined-card',
        testIndex: 1,
        stepIndex: 0,
        runOutcome: 'negative',
        benefit: 'rode-along',
      }),
    ])
    expect(outcomes[0]?.attribution).toContain('test 0 (checkout::happy-path) step 0')
    expect(outcomes[1]?.attribution).toContain('test 1 (checkout::declined-card) step 0')
  })
})

describe('emitCanaryOutcomes', () => {
  beforeEach(() => {
    lookupSpy.anchorsById.clear()
    lookupSpy.invalidById.clear()
    lookupSpy.openCalls.length = 0
  })

  it('resolves stored anchors and isolates a failed emit from the remaining projections', async () => {
    lookupSpy.anchorsById.set(CANDIDATE, [{
      t: 'el',
      role: 'button',
      name: 'checkout',
      ordinal: 0,
    }])
    const emitted: number[] = []
    const input = handoff([step({ stepIndex: 0 }), step({ stepIndex: 1 })])

    const report = await emitCanaryOutcomes({
      handoff: input,
      knowledgeRoot: '/tmp/agent-qa-knowledge',
      runDir: '/tmp/runs/run-canary-1',
      emit(outcome) {
        if (outcome.stepIndex === 0) throw new Error('simulated queue failure')
        emitted.push(outcome.stepIndex)
      },
    })

    expect(lookupSpy.openCalls).toEqual([
      '/tmp/agent-qa-knowledge',
    ])
    expect(emitted).toEqual([1])
    expect(report).toEqual({
      canary: { ...emptyCanaryCreditCounters(), rideAlongUncredited: 2 },
      emitted: 1,
      refused: 1,
      unresolved: 0,
      procedure: { emitted: 0, refused: 0, unresolved: 0 },
      details: [
        {
          benefit: 'rode-along',
          candidateId: CANDIDATE,
          testId: 'checkout::happy-path',
          testIndex: 0,
          stepIndex: 0,
          outcome: { kind: 'refused', reason: 'emit-error' },
        },
        {
          benefit: 'rode-along',
          candidateId: CANDIDATE,
          testId: 'checkout::happy-path',
          testIndex: 0,
          stepIndex: 1,
          outcome: { kind: 'emitted' },
        },
      ],
    })
  })

  it('guards both host paths before opening the reader', async () => {
    const input = handoff([step()])
    const base = {
      handoff: input,
      emit: vi.fn(),
    }

    await expect(emitCanaryOutcomes({
      ...base,
      knowledgeRoot: 'relative-knowledge',
      runDir: '/tmp/runs/run-canary-1',
    })).rejects.toThrow(new TypeError('knowledgeRoot must be absolute'))
    await expect(emitCanaryOutcomes({
      ...base,
      knowledgeRoot: '/tmp/agent-qa-knowledge',
      runDir: 'relative-run',
    })).rejects.toThrow(new TypeError('runDir must be absolute'))
    expect(lookupSpy.openCalls).toEqual([])
  })

  it.each([
    ['missing', 'not-found', undefined],
    ['corrupt', 'invalid', 'record.md: content hash mismatch'],
  ] as const)(
    'reports a %s served record as unresolved instead of certifying a zero/zero success',
    async (_condition, reason, detail) => {
      if (detail !== undefined) lookupSpy.invalidById.set(OTHER_CANDIDATE, detail)
      const report = await emitCanaryOutcomes({
        handoff: handoff([step({ candidateIds: [OTHER_CANDIDATE] })]),
        knowledgeRoot: '/tmp/agent-qa-knowledge',
        runDir: '/tmp/runs/run-canary-1',
        emit: vi.fn(),
      })

      expect(report).toEqual({
      canary: emptyCanaryCreditCounters(),
        emitted: 0,
        refused: 0,
        unresolved: 1,
        procedure: { emitted: 0, refused: 0, unresolved: 0 },
        details: [{
          benefit: 'rode-along',
          candidateId: OTHER_CANDIDATE,
          testId: 'checkout::happy-path',
          testIndex: 0,
          stepIndex: 0,
          outcome: {
            kind: 'unresolved',
            reason,
            ...(detail === undefined ? {} : { detail }),
          },
        }],
      })
    },
  )
})

describe('projectCanaryOutcomes planSource attribution', () => {
  const procedureAnchors = new Map([[PROCEDURE, PROCEDURE_ANCHORS]])

  it('projects a positive procedure outcome for a verified-PASS replayed step', async () => {
    const outcomes = project(
      handoff([step({ candidateIds: [], planSource: replaySource() })]),
      procedureAnchors,
    )

    expect(outcomes).toEqual([{
      candidateId: PROCEDURE,
      runOutcome: 'positive',
      benefit: 'rode-along',
      runId: 'run-canary-1',
      testId: 'checkout::happy-path',
      testIndex: 0,
      buildOrdinal: 42,
      stepIndex: 0,
      briefDigest: 'brief-digest-0',
      attribution: expect.stringContaining('procedure-sign-in'),
      exercisedAnchor: normalizeAnchor({ t: 'flow', name: 'Sign in flow' }),
    }])
  })

  it('projects only a positive procedure outcome for a clean navigating replay', async () => {
    // Contract pin: navigation in the completed evidence is not a staleness signal when the
    // pre-action replay guard passed cleanly.
    const navigating = subAction({
      ref: 'checkout',
      beforeUrl: '/login',
      afterUrl: '/dashboard',
    })
    expect(navigating.stateAfter?.url).not.toBe(navigating.stateBefore.url)

    const outcomes = project(
      handoff([step({
        candidateIds: [],
        planSource: replaySource(),
        subActions: [navigating],
      })]),
      procedureAnchors,
    )

    expect(outcomes.filter(({ runOutcome }) => runOutcome === 'positive')).toHaveLength(1)
    expect(outcomes.filter(({ runOutcome }) => runOutcome === 'negative')).toHaveLength(0)
    expect(outcomes).toEqual([
      expect.objectContaining({
        candidateId: PROCEDURE,
        runOutcome: 'positive',
        benefit: 'rode-along',
      }),
    ])
  })

  it('never projects a positive procedure outcome after replay execution failed', async () => {
    const outcomes = project(
      handoff([step({
        candidateIds: [],
        pass: true,
        planSource: replayExecutionFailureSource(),
      })]),
      procedureAnchors,
    )

    expect(outcomes.filter(({ runOutcome }) => runOutcome === 'positive')).toHaveLength(0)
    expect(outcomes).toEqual([
      expect.objectContaining({ candidateId: PROCEDURE, runOutcome: 'negative' }),
    ])
  })

  it('projects an execution-failed replay as negative for an attributable failed run', async () => {
    const outcomes = project(
      handoff(
        [step({
          candidateIds: [],
          pass: false,
          planSource: replayExecutionFailureSource(),
        })],
        rootCause('app_bug'),
      ),
      procedureAnchors,
    )

    expect(outcomes).toEqual([
      expect.objectContaining({ candidateId: PROCEDURE, runOutcome: 'negative' }),
    ])
  })

  it('keeps execution-failed replays behind the non-attributable classifier gate', async () => {
    for (const excluded of ['environment', 'timeout', 'flake'] as const) {
      expect(project(
        handoff(
          [step({
            candidateIds: [],
            pass: false,
            planSource: replayExecutionFailureSource(),
          })],
          rootCause(excluded),
        ),
        procedureAnchors,
      )).toEqual([])
    }
  })

  it('attributes a verifier-rejected replay negatively even after live recovery passes', async () => {
    const outcomes = project(
      handoff([step({
        candidateIds: [],
        pass: true,
        planSource: replayVerifierRejectionSource(),
      })]),
      procedureAnchors,
    )

    expect(outcomes).toEqual([
      expect.objectContaining({ candidateId: PROCEDURE, runOutcome: 'negative' }),
    ])
  })

  it('keeps verifier-rejected replays behind the non-attributable classifier gate', async () => {
    for (const excluded of ['environment', 'timeout', 'flake'] as const) {
      expect(project(
        handoff(
          [step({
            candidateIds: [],
            pass: false,
            planSource: replayVerifierRejectionSource(),
          })],
          rootCause(excluded),
        ),
        procedureAnchors,
      )).toEqual([])
    }
  })

  it('does not certify a clean incomplete replay from a later passing verdict', async () => {
    expect(project(
      handoff([step({
        candidateIds: [],
        pass: true,
        planSource: replayIncompleteSource(),
      })]),
      procedureAnchors,
    )).toEqual([])
  })

  it('keeps clean incomplete replay failures on the existing classifier path', async () => {
    const outcomes = project(
      handoff(
        [step({
          candidateIds: [],
          pass: false,
          planSource: replayIncompleteSource(),
        })],
        rootCause('app_bug'),
      ),
      procedureAnchors,
    )

    expect(outcomes).toEqual([
      expect.objectContaining({ candidateId: PROCEDURE, runOutcome: 'negative' }),
    ])
  })

  it('gates failed replayed steps behind the shared root-cause classifier', async () => {
    for (const excluded of ['environment', 'timeout', 'flake'] as const) {
      expect(project(
        handoff(
          [step({ candidateIds: [], pass: false, planSource: replaySource() })],
          rootCause(excluded),
        ),
        procedureAnchors,
      )).toEqual([])
    }

    const outcomes = project(
      handoff(
        [step({ candidateIds: [], pass: false, planSource: replaySource() })],
        rootCause('app_bug'),
      ),
      procedureAnchors,
    )
    expect(outcomes).toEqual([
      expect.objectContaining({ candidateId: PROCEDURE, runOutcome: 'negative' }),
    ])
  })

  it('attributes staleness guard misses as negatives even when the step passed via planning', async () => {
    const reasons = [
      'descriptor-ambiguous',
      'descriptor-missing',
      'page-anchor-mismatch',
    ] as const
    for (const reason of reasons) {
      const outcomes = project(
        handoff([step({
          candidateIds: [],
          planSource: replaySource(reason),
          subActions: [subAction()],
        })]),
        procedureAnchors,
      )
      expect(outcomes).toEqual([
        expect.objectContaining({ candidateId: PROCEDURE, runOutcome: 'negative' }),
      ])
    }
  })

  it('never attributes policy-wall guard misses', async () => {
    for (const reason of ['gate-refused', 'non-replayable-action'] as const) {
      expect(project(
        handoff([step({ candidateIds: [], planSource: replaySource(reason) })]),
        procedureAnchors,
      )).toEqual([])
    }
  })

  it('keeps the classifier gate over staleness misses on non-attributable failures', async () => {
    for (const excluded of ['environment', 'timeout', 'flake'] as const) {
      expect(project(
        handoff(
          [step({
            candidateIds: [],
            pass: false,
            planSource: replaySource('descriptor-missing'),
          })],
          rootCause(excluded),
        ),
        procedureAnchors,
      )).toEqual([])
    }
  })

  it('projects channel1 and planSource outcomes independently from one step', async () => {
    const outcomes = project(
      handoff([step({ planSource: replaySource() })]),
      new Map<string, Anchor[]>([
        [CANDIDATE, [{ t: 'el', role: 'button', name: 'checkout', ordinal: 0 }]],
        [PROCEDURE, PROCEDURE_ANCHORS],
      ]),
    )

    expect(outcomes).toEqual([
      expect.objectContaining({
        candidateId: CANDIDATE,
        runOutcome: 'positive',
        benefit: 'rode-along',
        exercisedAnchor: { t: 'el', role: 'button', name: 'checkout', ordinal: 0 },
      }),
      expect.objectContaining({
        candidateId: PROCEDURE,
        runOutcome: 'positive',
        benefit: 'rode-along',
        exercisedAnchor: normalizeAnchor({ t: 'flow', name: 'Sign in flow' }),
      }),
    ])
  })

  it('records nothing for procedure-hint exposure', async () => {
    expect(project(
      handoff([step({
        candidateIds: [],
        planSource: { kind: 'procedure-hint', procedureId: PROCEDURE },
      })]),
      procedureAnchors,
    )).toEqual([])
  })
})

/**
 * F-381-51-1 observation 3 (Plan 381-53, G-381-2 round 13): the FAILED round-12 rung-D
 * run r_meng-mater-con-seit-acle-lade-gor-craft-abies-extern still recorded a POSITIVE
 * `confirmed` canary event (buildOrdinal 31) because step 0's verifier passed before the
 * test died at step 1. The fixture is the VERBATIM handoff of that run (byte-identical
 * copy, digest-asserted below). The rows assert the DESIRED contract — positive
 * procedure-replay canaries adopt D-01's per-trajectory passing gate — so the
 * failed-test row is RED on the shipped build. Polarity pins P1-P5 pin what must NOT
 * change: per-step positives on passing tests (380 D-21), guard-earned negatives and
 * the root-cause classifier gate (D-11), the PROC-01 zero-replay empty projection, and
 * Pin 1 (served-brief) attribution.
 */
describe('verdict-gated positive procedure canaries', () => {
  const FIXTURE_PROCEDURE = asRecordId(
    'procedure-flow-t-posing-clock-inject-pill-adds-i-29ff61a3638ac355',
  )
  const FIXTURE_PAGE_FACT = asRecordId(
    'fact-page-http-127-0-0-1-8931-received-html-user-2a650b89fd403728',
  )
  const FIXTURE_EL_FACT = asRecordId('fact-el-textbox-username-20f5876cc5299c11')
  const FIXTURE_RECEIVED_URL =
    'http://127.0.0.1:8931/received.html?username=qa.user%2B381%40example.com'
  /** sha-256 of the fixture's bytes. */
  const FIXTURE_HANDOFF_SHA256 =
    'cf43af997b9aa9e6763fd7444261c839d045d8af59df5f7f5b555251e9ee0814'

  const fixturePath = join(
    dirname(fileURLToPath(import.meta.url)),
    'fixtures',
    'f-381-51-1-run',
    HANDOFF_FILE,
  )

  function fixtureAnchors(): Map<string, Anchor[]> {
    return new Map<string, Anchor[]>([
      [FIXTURE_PROCEDURE, [{ t: 'flow', name: 'form::submit-username' }]],
      [FIXTURE_PAGE_FACT, [{ t: 'page', route: FIXTURE_RECEIVED_URL }]],
      [FIXTURE_EL_FACT, [{ t: 'el', role: 'textbox', name: 'username', ordinal: 0 }]],
    ])
  }

  it('fixture faithfulness: handoff bytes are the failed live run bytes', async () => {
    const digest = createHash('sha256')
      .update(readFileSync(fixturePath))
      .digest('hex')
    expect(digest).toBe(FIXTURE_HANDOFF_SHA256)

    const fixture = loadCompletedRunHandoff(fixturePath)
    expect(fixture.aggregateVerdict).toBe('failed')
    expect(fixture.tests[0]?.outcome).toBe('failed')
    const stepZero = fixture.tests[0]?.steps[0]
    expect(stepZero?.verifierVerdict.pass).toBe(true)
    expect(stepZero?.planSource).toMatchObject({
      kind: 'procedure-replay',
      procedureId: FIXTURE_PROCEDURE,
      guard: { checksPassed: 2, total: 2 },
    })
  })

  it('a failed test projects no positive procedure canary from its verified-PASS replayed steps', async () => {
    const fixture = loadCompletedRunHandoff(fixturePath)
    const outcomes = project(fixture, fixtureAnchors())

    const testsByIndex = new Map(fixture.tests.map((test) => [test.testIndex, test]))
    const positivesFromUnpassedTests = outcomes.filter((outcome) => {
      if (outcome.runOutcome !== 'positive') return false
      const test = testsByIndex.get(outcome.testIndex)
      const evidence = test?.steps.find((entry) => entry.stepIndex === outcome.stepIndex)
      return test?.outcome !== 'passed' && evidence?.planSource?.kind === 'procedure-replay'
    })
    expect(positivesFromUnpassedTests).toEqual([])
    // Suppression, never inversion (D-11): the withheld positive must not surface as a
    // negative either — the failed run contributes NOTHING to the confirmation counter.
    expect(outcomes.filter(({ candidateId }) => candidateId === FIXTURE_PROCEDURE))
      .toEqual([])
  })

  it('a passing test keeps one positive per verified-PASS replayed step', async () => {
    const outcomes = project(
      handoff([
        step({ stepIndex: 0, candidateIds: [], planSource: replaySource() }),
        step({ stepIndex: 1, candidateIds: [], planSource: replaySource() }),
      ]),
      new Map([[PROCEDURE, PROCEDURE_ANCHORS]]),
    )

    expect(outcomes).toEqual([
      expect.objectContaining({
        candidateId: PROCEDURE,
        runOutcome: 'positive',
        benefit: 'rode-along',
        stepIndex: 0,
      }),
      expect.objectContaining({
        candidateId: PROCEDURE,
        runOutcome: 'positive',
        benefit: 'rode-along',
        stepIndex: 1,
      }),
    ])
  })

  it('a staleness miss in a failed test still projects a negative', async () => {
    const outcomes = project(
      handoff(
        [step({
          candidateIds: [],
          pass: false,
          planSource: replaySource('descriptor-missing'),
        })],
        rootCause('app_bug'),
      ),
      new Map([[PROCEDURE, PROCEDURE_ANCHORS]]),
    )

    expect(outcomes).toEqual([
      expect.objectContaining({ candidateId: PROCEDURE, runOutcome: 'negative' }),
    ])
  })

  it('the classifier gate keeps misses silent on non-attributable failures', async () => {
    for (const excluded of ['environment', 'timeout', 'flake'] as const) {
      expect(project(
        handoff(
          [step({
            candidateIds: [],
            pass: false,
            planSource: replaySource('descriptor-missing'),
          })],
          rootCause(excluded),
        ),
        new Map([[PROCEDURE, PROCEDURE_ANCHORS]]),
      )).toEqual([])
    }
  })

  it('zero procedure-replay steps project zero procedure attributions', async () => {
    const outcomes = project(
      handoff([step({ stepIndex: 0 }), step({ stepIndex: 1, pass: false })]),
      new Map<string, Anchor[]>([
        [CANDIDATE, [{ t: 'el', role: 'button', name: 'checkout', ordinal: 0 }]],
        [PROCEDURE, PROCEDURE_ANCHORS],
      ]),
    )

    expect(outcomes.filter(({ candidateId }) => candidateId === PROCEDURE)).toEqual([])
    // Pin 1 stays verdict-ungated by construction: the served-brief lane keeps
    // attributing per-step outcomes even inside this failed test.
    expect(outcomes.filter(({ candidateId }) => candidateId === CANDIDATE))
      .toHaveLength(2)
  })

  it('served-brief attribution over the verbatim fixture keeps its exact counts', async () => {
    const fixture = loadCompletedRunHandoff(fixturePath)
    const outcomes = project(fixture, fixtureAnchors())

    const briefOutcomes = outcomes.filter(
      ({ candidateId }) => candidateId !== FIXTURE_PROCEDURE,
    )
    // Step 0 serves no canaries (empty channel1); step 1 serves two, of which only the
    // page fact contacts an exercised anchor — one attributable negative, byte-unchanged.
    expect(briefOutcomes).toEqual([
      expect.objectContaining({
        candidateId: FIXTURE_PAGE_FACT,
        runOutcome: 'negative',
        benefit: 'rode-along',
        testIndex: 0,
        stepIndex: 1,
      }),
    ])
  })
})

describe('emitCanaryOutcomes procedure counters', () => {
  beforeEach(() => {
    lookupSpy.anchorsById.clear()
    lookupSpy.invalidById.clear()
    lookupSpy.openCalls.length = 0
  })

  it('splits procedure-source counters beside the shared totals', async () => {
    lookupSpy.anchorsById.set(CANDIDATE, [{
      t: 'el',
      role: 'button',
      name: 'checkout',
      ordinal: 0,
    }])
    lookupSpy.anchorsById.set(PROCEDURE, PROCEDURE_ANCHORS)

    const report = await emitCanaryOutcomes({
      handoff: handoff([step({ planSource: replaySource() })]),
      knowledgeRoot: '/tmp/agent-qa-knowledge',
      runDir: '/tmp/runs/run-canary-1',
      emit: vi.fn(),
    })

    expect(report.emitted).toBe(2)
    expect(report.procedure).toEqual({ emitted: 1, refused: 0, unresolved: 0 })
    expect(report.details).toEqual(expect.arrayContaining([
      expect.objectContaining({ candidateId: PROCEDURE, outcome: { kind: 'emitted' } }),
    ]))
  })

  it('reports an unresolved procedure without certifying a zero/zero success', async () => {
    const report = await emitCanaryOutcomes({
      handoff: handoff([step({ candidateIds: [], planSource: replaySource() })]),
      knowledgeRoot: '/tmp/agent-qa-knowledge',
      runDir: '/tmp/runs/run-canary-1',
      emit: vi.fn(),
    })

    expect(report).toEqual({
      canary: emptyCanaryCreditCounters(),
      emitted: 0,
      refused: 0,
      unresolved: 1,
      procedure: { emitted: 0, refused: 0, unresolved: 1 },
      details: [{
        benefit: 'rode-along',
        candidateId: PROCEDURE,
        testId: 'checkout::happy-path',
        testIndex: 0,
        stepIndex: 0,
        outcome: { kind: 'unresolved', reason: 'not-found' },
      }],
    })
  })
})

// ————— 389-06: the D-10 attribution rewire + the SC2 cross-run supersession differential —————

describe('the cross-run supersession differential', () => {
  const RUN_A = 'run-supersession-aaa'
  const RUN_B = 'run-supersession-bbb'
  const CANDIDATE_ANCHOR: Anchor = { t: 'el', role: 'button', name: 'checkout', ordinal: 0 }

  const tempDirs: string[] = []

  beforeEach(() => {
    lookupSpy.anchorsById.clear()
    lookupSpy.invalidById.clear()
    lookupSpy.openCalls.length = 0
    lookupSpy.anchorsById.set(CANDIDATE, [CANDIDATE_ANCHOR])
  })

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function tempRunDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'agent-qa-sc2-run-'))
    tempDirs.push(dir)
    return dir
  }

  /**
   * One failing test (verifier-failed step 0, canary served, anchors matched), NO rootCause
   * — the deterministic floor resolves it to the minted `unknown`, which IS attributable.
   * Both halves of the differential are pinned BY ID (the 388 two-sided-contract law):
   * single-run fixtures cannot see a cross-instance attribution defect.
   */
  function failingHandoffFor(runId: string): CompletedRunHandoff {
    const base = handoff([step({ stepIndex: 0, pass: false })])
    return { ...base, runId: asRunId(runId) }
  }

  /** The 389 supersession: the author upgraded the floor's unknown to flake (non-attributable). */
  function flakeArtifact(runId: string): RunAnalysisArtifact {
    return {
      schemaVersion: CURRENT_ANALYSIS_SCHEMA_VERSION,
      runId,
      verdicts: [{
        class: 'flake',
        producer: 'analyze-run',
        confidence: 0.8,
        evidence: {
          citedSteps: [0],
          citedAnchors: [],
          citedArtifacts: [],
          rationale: 'the same step passed on the immediate re-run',
        },
        memoryMisdirectionRuledOut: true,
        perTest: 0,
      }],
      parts: [{
        perTest: 0,
        groundingQuote: { stepIndex: 0, quote: 'Checkout did not open' },
        discriminator: 'intermittent, no persistent cause',
        nextAction: 're-run to confirm stability',
        links: [],
      }],
    }
  }

  function foldInto(log: CanaryOutcome[], input: CompletedRunHandoff, runDir: string) {
    return emitCanaryOutcomes({
      handoff: input,
      knowledgeRoot: '/tmp/agent-qa-knowledge',
      runDir,
      emit: (outcome) => log.push(outcome),
    })
  }

  it('no-artifact leg: fold output is the handoff-only projection with the credit pass evidence', async () => {
    const collected: CanaryOutcome[] = []
    const report = await foldInto(collected, failingHandoffFor(RUN_A), tempRunDir())

    expect(report.emitted).toBe(1)
    expect(collected[0]).toMatchObject({
      candidateId: CANDIDATE,
      runId: RUN_A,
      runOutcome: 'negative',
      benefit: 'exercised-harmed',
      testId: 'checkout::happy-path',
    })
    // The pure projection over the same handoff, plus the credit pass's benefit.
    expect(collected).toEqual(
      project(failingHandoffFor(RUN_A), new Map([[CANDIDATE, [CANDIDATE_ANCHOR]]]))
        .map(outcome => ({ ...outcome, benefit: 'exercised-harmed' })),
    )
  })

  it('the artifact supersedes the deterministic unknown and the RESOLVED class flips attribution', async () => {
    const runDir = tempRunDir()
    writeFileSync(
      join(runDir, ANALYSIS_FILE),
      `${canonicalJson(flakeArtifact(RUN_A))}\n`,
      'utf8',
    )

    const collected: CanaryOutcome[] = []
    const report = await foldInto(collected, failingHandoffFor(RUN_A), runDir)

    // unknown → flake: flake is non-attributable (D-11), so the fold that reads the
    // resolved verdict emits NOTHING for this test — the outcome log cannot contradict it.
    expect(collected).toEqual([])
    expect(report.emitted).toBe(0)
    expect(report.refused).toBe(0)
    expect(report.unresolved).toBe(0)
  })

  it('two runs and a supersession — exactly ONE attributed observation per (runId, testId)', async () => {
    const log: CanaryOutcome[] = []
    const dirA = tempRunDir()
    const dirB = tempRunDir()
    const runA = failingHandoffFor(RUN_A)
    const runB = failingHandoffFor(RUN_B)

    // Run A folds on its deterministic unknown floor: attributed.
    expect((await foldInto(log, runA, dirA)).emitted).toBe(1)

    // The analysis artifact lands: unknown → flake for run A.
    writeFileSync(join(dirA, ANALYSIS_FILE), `${canonicalJson(flakeArtifact(RUN_A))}\n`, 'utf8')

    // The re-fold reads the RESOLVED verdict: no second observation, ever (the upgrade
    // flips attribution rather than appending beside the original).
    expect((await foldInto(log, runA, dirA)).emitted).toBe(0)

    // Run B folds AFTER the supersession, with run A's artifact on disk — and answers its
    // OWN floor: the artifact is loaded from the fold's own runDir, keyed by the run it
    // folds, never a sibling's (the cross-instance attribution defect class).
    expect((await foldInto(log, runB, dirB)).emitted).toBe(1)

    const observations = new Map<string, number>()
    for (const outcome of log) {
      const key = `${outcome.runId}::${outcome.testId}`
      observations.set(key, (observations.get(key) ?? 0) + 1)
    }
    expect([...observations.entries()].sort()).toEqual([
      [`${RUN_A}::checkout::happy-path`, 1],
      [`${RUN_B}::checkout::happy-path`, 1],
    ])
    expect(log.map((outcome) => outcome.runId)).toEqual([RUN_A, RUN_B])
    // Attribution consistent with each run's RESOLVED class: both surviving observations
    // are the attributable negatives of their own unknown floors.
    for (const outcome of log) expect(outcome.runOutcome).toBe('negative')
  })

  it("a foreign artifact on run B's OWN dir never flips B's attribution", async () => {
    // The two-sided-contract pin law again, at the fold's loader: the file is PRESENT on
    // B's own runDir in BOTH legs — only the recorded runId varies. A copied/restored run
    // directory is run A's bytes on B's path; admission by identity keeps B on its floor.
    const dirB = tempRunDir()
    const runB = failingHandoffFor(RUN_B)

    // Foreign leg: run A's flake bytes at dirB. B's floor unknown IS attributable — the
    // attributed emission STILL occurs; A's flake (non-attributable) is never adopted.
    writeFileSync(join(dirB, ANALYSIS_FILE), `${canonicalJson(flakeArtifact(RUN_A))}\n`, 'utf8')
    const foreignLog: CanaryOutcome[] = []
    const foreignReport = await foldInto(foreignLog, runB, dirB)
    expect(foreignReport.emitted).toBe(1)
    expect(foreignLog.map((outcome) => outcome.runId)).toEqual([RUN_B])
    expect(foreignLog[0]!.runOutcome).toBe('negative')

    // Control leg: the SAME bytes with runId corrected to RUN_B on the SAME path —
    // adopted, unknown → flake, the emission suppressed (the supersession case's shape).
    writeFileSync(join(dirB, ANALYSIS_FILE), `${canonicalJson(flakeArtifact(RUN_B))}\n`, 'utf8')
    const controlLog: CanaryOutcome[] = []
    const controlReport = await foldInto(controlLog, runB, dirB)
    expect(controlLog).toEqual([])
    expect(controlReport.emitted).toBe(0)
    expect(controlReport.refused).toBe(0)
    expect(controlReport.unresolved).toBe(0)
  })

  it('reads verdicts through resolveRunVerdicts only (source pin + grep gate)', async () => {
    const source = readFileSync(
      new URL('../emit-canary-outcomes.ts', import.meta.url),
      'utf8',
    )
    expect(source).toContain('resolveRunVerdicts')
    // The region-scoped grep gate: no fold code path reads the handoff verdict field
    // directly — the accessor is the ONLY supersedable-verdict read.
    expect(source.split('test.rootCause').length - 1).toBe(0)
  })

  it('run_outcome_applied_runs holds through the upgrade — a re-fold never double-counts', async () => {
    const { applyRunOutcomes, indexDbPath, projectRunOutcomes, readTestOutcomeHistory } =
      await vi.importActual<typeof import('@vostride/agent-qa-knowledge-local')>(
        '@vostride/agent-qa-knowledge-local',
      )
    const knowledgeRoot = mkdtempSync(join(tmpdir(), 'agent-qa-sc2-knowledge-'))
    tempDirs.push(knowledgeRoot)
    const dbPath = indexDbPath(knowledgeRoot)
    mkdirSync(dirname(dbPath), { recursive: true })
    const db = new DatabaseSync(dbPath)
    try {
      const projection = projectRunOutcomes(failingHandoffFor(RUN_A), { extractAnchors: () => [] })

      expect(applyRunOutcomes(db, projection).kind).toBe('applied')
      // The supersession lands between the folds. By design it is INVISIBLE to these
      // counters: an upgrade is a re-read of the same observation, never a second one.
      expect(applyRunOutcomes(db, projection)).toEqual({ kind: 'already-applied', tests: 0 })

      const history = readTestOutcomeHistory(db, {
        product: 'storefront',
        filePath: 'checkout.spec.yaml',
        testName: 'Checkout happy path',
      })
      expect(history).toMatchObject({ failures: 1, passes: 0 })
    } finally {
      db.close()
    }
  })
})
