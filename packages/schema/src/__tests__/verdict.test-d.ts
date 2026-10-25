import { expectTypeOf } from 'vitest'
import { asRecordId } from '../ids/record-id'
import type { PerTestOutcome } from '../handoff/per-test-outcome'
import type { Verdict, VerdictEvidence } from '../verdict/verdict'

// RCC-01 / D-03: the closed eight-class union — unknown/timeout ratified (§A9).
type AllClasses =
  | 'app_bug'
  | 'test_bug'
  | 'environment'
  | 'flake'
  | 'config_error'
  | 'llm_error'
  | 'unknown'
  | 'timeout'

type TestBugSubtype =
  | 'stale_selector'
  | 'outdated_flow'
  | 'bad_assertion'
  | 'wrong_expected_value'

const evidence: VerdictEvidence = {
  citedSteps: [0, 2],
  citedAnchors: [{ t: 'el', role: 'button', name: 'Submit' }],
  citedArtifacts: [{ id: 'screenshot-after', sha: 'a'.repeat(64) }],
  rationale: 'The observed assertion target no longer matches the expected UI.',
}

expectTypeOf<Verdict['class']>().toEqualTypeOf<AllClasses>()

// D-03: producer is the minting-pipeline axis, closed to exactly two literals.
expectTypeOf<Verdict['producer']>().toEqualTypeOf<
  'deterministic-classifier' | 'analyze-run'
>()

type TestBugVerdict = Extract<Verdict, { class: 'test_bug' }>
expectTypeOf<TestBugVerdict['subtype']>().toEqualTypeOf<TestBugSubtype | undefined>()

// The exact key set of a verdict arm.
type FlakeVerdict = Extract<Verdict, { class: 'flake' }>
expectTypeOf<keyof FlakeVerdict>().toEqualTypeOf<
  | 'class'
  | 'producer'
  | 'confidence'
  | 'evidence'
  | 'attribution'
  | 'memoryMisdirectionRuledOut'
  | 'memoryOnPath'
  | 'perTest'
>()

const valid: Verdict = {
  class: 'test_bug',
  subtype: 'stale_selector',
  producer: 'deterministic-classifier',
  confidence: 0.9,
  evidence,
  attribution: {
    records: [asRecordId('record-1')],
    anchors: [{ t: 'page', route: '/checkout' }],
  },
  memoryMisdirectionRuledOut: true,
  perTest: 0,
}
expectTypeOf<typeof valid.evidence>().toEqualTypeOf<VerdictEvidence>()

const flake: FlakeVerdict = {
  class: 'flake',
  producer: 'deterministic-classifier',
  confidence: 0.6,
  evidence,
  memoryMisdirectionRuledOut: true,
  perTest: 1,
}

// @ts-expect-error non-test_bug verdict arms carry no subtype.
flake.subtype

// The two RCC-01 extension arms are assignable members of the closed union (§A9).
const unknownVerdict: Verdict = {
  class: 'unknown',
  producer: 'deterministic-classifier',
  confidence: 0,
  evidence,
  memoryMisdirectionRuledOut: true,
  perTest: 0,
}

const timeoutVerdict: Verdict = {
  class: 'timeout',
  producer: 'analyze-run',
  confidence: 0.4,
  evidence,
  memoryMisdirectionRuledOut: true,
  perTest: 2,
}

// @ts-expect-error producer is required on every Verdict arm (D-03).
const missingProducer: Verdict = {
  class: 'app_bug',
  confidence: 1,
  evidence,
  memoryMisdirectionRuledOut: true,
  perTest: 0,
}

const invalidProducer: Verdict = {
  class: 'app_bug',
  // @ts-expect-error producer is closed to the two minting pipelines — no third literal.
  producer: 'llm-judge',
  confidence: 1,
  evidence,
  memoryMisdirectionRuledOut: true,
  perTest: 0,
}

const invalidOther: Verdict = {
  // @ts-expect-error Verdict is a closed union with no `other` arm or free-form class string.
  class: 'other',
  producer: 'deterministic-classifier',
  confidence: 1,
  evidence,
  memoryMisdirectionRuledOut: true,
  perTest: 0,
}

// @ts-expect-error memoryMisdirectionRuledOut is required on every Verdict arm.
const missingMisdirectionGuard: Verdict = {
  class: 'flake',
  producer: 'deterministic-classifier',
  confidence: 1,
  evidence,
  perTest: 0,
}

const bareStringEvidence: Verdict = {
  class: 'llm_error',
  producer: 'deterministic-classifier',
  confidence: 0.2,
  // @ts-expect-error evidence must be structured VerdictEvidence, never a bare rationale string.
  evidence: 'the model guessed',
  memoryMisdirectionRuledOut: true,
  perTest: 0,
}

// D-01: PerTestOutcome carries the optional per-test rootCause classification…
const classifiedOutcome: PerTestOutcome = {
  testId: 'test-one',
  testName: 'Test one',
  filePath: 'test-one.spec.yaml',
  testIndex: 0,
  outcome: 'failed',
  steps: [],
  rootCause: unknownVerdict,
}

// …and still compiles without it (clean passes omit rootCause).
const cleanOutcome: PerTestOutcome = {
  testId: 'test-two',
  testName: 'Test two',
  filePath: 'test-two.spec.yaml',
  testIndex: 1,
  outcome: 'passed',
  steps: [],
}

expectTypeOf<PerTestOutcome['rootCause']>().toEqualTypeOf<Verdict | undefined>()

void valid
void flake
void unknownVerdict
void timeoutVerdict
void missingProducer
void invalidProducer
void invalidOther
void missingMisdirectionGuard
void bareStringEvidence
void classifiedOutcome
void cleanOutcome
