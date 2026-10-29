// The hoisted fingerprint-input derivation.
//
// `failingStepOf`/`errorTextOf` moved here from agent's private `cluster.ts` so knowledge-local
// can compute fingerprint inputs without importing agent. The move must change ZERO observable
// behavior: a drifted hoist silently re-keys every accumulated fingerprint window, so
// the identity is PROVEN here rather than assumed.
//
// Two independent oracles, because either alone is weak:
//   1. Golden fingerprint BYTES — anchored outside the code's own vocabulary (the 383 lesson:
//      closures phrased as relations among a module's own fields do not hold).
//   2. A frozen verbatim snapshot of the pre-hoist cluster.ts bodies (`preHoist*` below), used
//      as a differential oracle over a fixture corpus. It is a TEST-ONLY frozen witness, never
//      a live spelling — production has exactly one spelling, the export under test (388 C13).

import { describe, expect, it } from 'vitest'

import type { PerTestOutcome } from '../handoff/per-test-outcome'
import type { StepEvidence } from '../handoff/step-evidence'
import type { ServedBrief } from '../brief/served-brief'
import type { ElementInfo } from '../screen/element-info'
import { exercisedAnchors } from '../identity/exercised-anchors'
import { asRef } from '../primitives/ref'
import { errorTextOf, failingStepOf } from '../verdict/fingerprint-input'
import { failureFingerprint } from '../verdict/failure-fingerprint'
import type { Verdict } from '../verdict/verdict'

// ---------------------------------------------------------------------------------------
// Frozen pre-hoist witness: cluster.ts:45-64 verbatim as of 390-01 (commit 4c0d445f).
// Kept ONLY as the hoist-fidelity oracle for the differential below.
// ---------------------------------------------------------------------------------------

function preHoistFailingStepOf(test: PerTestOutcome): StepEvidence | undefined {
  if (test.steps.length === 0) return undefined
  return (
    test.steps.find((step) => !step.verifierVerdict.pass)
    ?? test.steps[test.steps.length - 1]
  )
}

function preHoistErrorTextOf(step: StepEvidence | undefined, test: PerTestOutcome): string {
  if (step === undefined) return test.outcome
  const subActionError = step.subActions
    .map((subAction) => subAction.result.error)
    .find((error): error is string => typeof error === 'string' && error !== '')
  return subActionError ?? step.verifierVerdict.reasoning
}

// ---------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------

const SUBMIT_BUTTON: ElementInfo = {
  ref: asRef('e1'),
  role: 'button',
  name: 'Submit',
  nameNormalized: 'submit',
  state: { enabled: true, focused: false, visible: true },
  labels: {},
  attributes: {},
}

function servedBrief(): ServedBrief {
  return {
    scope: { tier: 'product', key: 'fingerprint-input' },
    asOfBuild: 1,
    budget: 0,
    truncation: 'none',
    channel1: [],
    channel2: [],
    channel3: [],
    briefDigest: 'fingerprint-input-brief-digest',
  }
}

function screenState(elements: ElementInfo[]) {
  return {
    platform: 'web' as const,
    tree: '',
    elements,
    refMap: {},
    url: '/checkout',
    timestamp: 1,
    metadata: {
      coordSpace: 'viewport' as const,
      viewportWidth: 1280,
      viewportHeight: 720,
      scroll: { offsetX: 0, offsetY: 0, contentWidth: 1280, contentHeight: 720 },
      captureMode: 'textOnly' as const,
    },
  }
}

interface StepOptions {
  pass: boolean
  reasoning: string
  /** One entry per sub-action; `undefined` records a sub-action with no error text. */
  errors?: (string | undefined)[]
  elements?: ElementInfo[]
}

function step(stepIndex: number, options: StepOptions): StepEvidence {
  const errors = options.errors ?? []
  return {
    stepIndex,
    stepText: `step ${stepIndex}`,
    cacheStatus: 'miss',
    servedBrief: servedBrief(),
    subActions: errors.map((error) => ({
      plan: `plan ${stepIndex}`,
      plannedAction: { type: 'click' as const, ref: asRef('e1') },
      stateBefore: screenState(options.elements ?? []),
      result: error === undefined ? { success: false } : { success: false, error },
    })),
    verifierVerdict: { pass: options.pass, reasoning: options.reasoning },
  }
}

function test(overrides: Partial<PerTestOutcome> & { steps: StepEvidence[] }): PerTestOutcome {
  return {
    testId: 't_fixture',
    testName: 'fixture test',
    filePath: 'tests/fixture.yaml',
    testIndex: 0,
    outcome: 'failed',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------------------
// Group 1 — failingStepOf
// ---------------------------------------------------------------------------------------

describe('failingStepOf (hoisted from cluster.ts)', () => {
  it('answers undefined for a zero-step test — no fabricated step', () => {
    expect(failingStepOf(test({ steps: [] }))).toBeUndefined()
  })

  it('selects the FIRST verifier-failed step, not the last failure', () => {
    const first = step(1, { pass: false, reasoning: 'the submit button never appeared' })
    const later = step(2, { pass: false, reasoning: 'a second, downstream failure' })
    const selected = failingStepOf(
      test({ steps: [step(0, { pass: true, reasoning: 'step 0 verified' }), first, later] }),
    )
    expect(selected).toBe(first)
    expect(selected?.stepIndex).toBe(1)
  })

  it('falls back to the LAST step when every step verified (the timeout anchor)', () => {
    const last = step(2, { pass: true, reasoning: 'step 2 verified' })
    const selected = failingStepOf(
      test({
        outcome: 'timeout',
        steps: [
          step(0, { pass: true, reasoning: 'step 0 verified' }),
          step(1, { pass: true, reasoning: 'step 1 verified' }),
          last,
        ],
      }),
    )
    expect(selected).toBe(last)
    expect(selected?.stepIndex).toBe(2)
  })
})

// ---------------------------------------------------------------------------------------
// Group 2 — errorTextOf
// ---------------------------------------------------------------------------------------

describe('errorTextOf (hoisted from cluster.ts)', () => {
  it('answers the recorded test outcome when there is no step', () => {
    const stepless = test({ outcome: 'timeout', steps: [] })
    expect(errorTextOf(undefined, stepless)).toBe('timeout')
  })

  it('prefers the FIRST non-empty sub-action error, skipping absent and empty ones', () => {
    const failing = step(0, {
      pass: false,
      reasoning: 'the verifier reasoning that must NOT win',
      errors: [undefined, '', 'Error: element "Submit" not found', 'a later error'],
    })
    expect(errorTextOf(failing, test({ steps: [failing] }))).toBe(
      'Error: element "Submit" not found',
    )
  })

  it('falls back to the verifier reasoning when no sub-action recorded an error', () => {
    const failing = step(0, {
      pass: false,
      reasoning: 'the submit button never appeared on the checkout screen',
      errors: [undefined, ''],
    })
    expect(errorTextOf(failing, test({ steps: [failing] }))).toBe(
      'the submit button never appeared on the checkout screen',
    )
  })
})

// ---------------------------------------------------------------------------------------
// Group 3 — composition with the FROZEN fingerprint recipe
// ---------------------------------------------------------------------------------------

/** The cluster path, expressed over the hoisted export — the one live spelling. */
function fingerprintOf(outcome: PerTestOutcome, verdictClass: Verdict['class']): string {
  const selected = failingStepOf(outcome)
  return failureFingerprint(
    {
      anchors: selected === undefined ? [] : exercisedAnchors(selected),
      errorText: errorTextOf(selected, outcome),
    },
    verdictClass,
  )
}

/** The same path over the frozen pre-hoist witness — byte-identity oracle. */
function preHoistFingerprintOf(
  outcome: PerTestOutcome,
  verdictClass: Verdict['class'],
): string {
  const selected = preHoistFailingStepOf(outcome)
  return failureFingerprint(
    {
      anchors: selected === undefined ? [] : exercisedAnchors(selected),
      errorText: preHoistErrorTextOf(selected, outcome),
    },
    verdictClass,
  )
}

const CORPUS: { name: string; outcome: PerTestOutcome; class: Verdict['class'] }[] = [
  {
    name: 'element-anchored first failing step',
    class: 'flake',
    outcome: test({
      steps: [
        step(0, { pass: true, reasoning: 'step 0 verified', errors: ['ignored'] }),
        step(1, {
          pass: false,
          reasoning: 'the submit button never appeared',
          errors: ['Error: element "Submit" not found'],
          elements: [SUBMIT_BUTTON],
        }),
      ],
    }),
  },
  {
    name: 'page-anchored failing step (no resolved element)',
    class: 'app_bug',
    outcome: test({
      steps: [step(0, { pass: false, reasoning: 'the page never settled', errors: ['boom'] })],
    }),
  },
  {
    name: 'all steps verified — the LAST step anchors, anchorless',
    class: 'timeout',
    outcome: test({
      outcome: 'timeout',
      steps: [
        step(0, { pass: true, reasoning: 'step 0 verified' }),
        step(1, { pass: true, reasoning: 'Test timed out after 30000ms' }),
      ],
    }),
  },
  {
    name: 'zero-step failure — the recorded outcome is the signature',
    class: 'unknown',
    outcome: test({ steps: [] }),
  },
]

describe('composition with the frozen fingerprint recipe', () => {
  it('pins the element-anchored golden bytes', () => {
    expect(fingerprintOf(CORPUS[0]!.outcome, 'flake')).toBe(
      '{"name":"submit","ordinal":0,"role":"button","t":"el"}::flake',
    )
  })

  it('pins the page-anchored golden bytes when no element resolved', () => {
    expect(fingerprintOf(CORPUS[1]!.outcome, 'app_bug')).toBe(
      '{"route":"/checkout","t":"page"}::app_bug',
    )
  })

  it('pins the all-verified anchorless golden bytes — digit runs collapse', () => {
    // The LAST step is the anchor, it exercised nothing, so the error arm keys on its
    // verifier reasoning: two timeouts differing only in milliseconds are ONE recurrence.
    expect(fingerprintOf(CORPUS[2]!.outcome, 'timeout')).toBe(
      '{"message":"test timed out after #ms","t":"error"}::timeout',
    )
  })

  it('pins the zero-step golden bytes — the recorded outcome, no fabricated step', () => {
    expect(fingerprintOf(CORPUS[3]!.outcome, 'unknown')).toBe(
      '{"message":"failed","t":"error"}::unknown',
    )
  })

  it.each(CORPUS)(
    'is byte-identical to the pre-hoist cluster path: $name',
    ({ outcome, class: verdictClass }) => {
      expect(fingerprintOf(outcome, verdictClass)).toBe(
        preHoistFingerprintOf(outcome, verdictClass),
      )
    },
  )

  it.each(CORPUS)('selects the same step as the pre-hoist rule: $name', ({ outcome }) => {
    expect(failingStepOf(outcome)).toBe(preHoistFailingStepOf(outcome))
  })

  it.each(CORPUS)('derives the same error text as the pre-hoist rule: $name', ({ outcome }) => {
    const selected = failingStepOf(outcome)
    expect(errorTextOf(selected, outcome)).toBe(preHoistErrorTextOf(selected, outcome))
  })
})
