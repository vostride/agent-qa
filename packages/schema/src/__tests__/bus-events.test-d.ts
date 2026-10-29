// Payload types cannot carry live handles, raw bytes or evidence: a compile error, not a strip.
import { expectTypeOf } from 'vitest'
import type {
  RunEvent,
  RunEventEnvelope,
  RunEventPayload,
  RunEventType,
  StepFinalizedPayload,
  SubActionRecordedPayload,
  TestFinishedPayload,
} from '../run/bus-events'
import { RUN_EVENT_TYPES } from '../run/bus-events'
import type { RunCompletion, RunSession } from '../run/run-session'
import type { Action } from '../action/index'
import type { ServedBrief } from '../brief/served-brief'
import type { VerifierVerdict } from '../handoff/step-evidence'
import type { StepEvidence } from '../handoff/step-evidence'
import type { RecordedActionResult } from '../result/index'
import type { ScreenState } from '../screen/screen-state'

// --- Envelope + event-type pins ---------------------------------------------

expectTypeOf<RunEventEnvelope['seq']>().toEqualTypeOf<number>()
expectTypeOf<RunEventEnvelope['ts']>().toEqualTypeOf<number>()
expectTypeOf<RunEventEnvelope['runId']>().toEqualTypeOf<string>()
expectTypeOf<RunEventEnvelope['type']>().toEqualTypeOf<RunEventType>()
expectTypeOf<RunEventEnvelope['payload']>().toEqualTypeOf<RunEventPayload>()
expectTypeOf<RunEventType>().toEqualTypeOf<(typeof RUN_EVENT_TYPES)[number]>()

// Spelled out, not as `PostProcessingDisposition`, so a fourth arm added to that alias fails here.
expectTypeOf<Extract<RunEvent, { type: 'runFinished' }>['payload']['disposition']>()
  .toEqualTypeOf<'drained' | 'handedOff' | 'detached'>()

expectTypeOf<RunSession['done']>().toEqualTypeOf<Promise<RunCompletion>>()
expectTypeOf<RunSession['cancel']>().toEqualTypeOf<() => void>()
expectTypeOf<RunSession['subscribe']>().parameter(0).toEqualTypeOf<number>()
expectTypeOf<RunSession['subscribe']>().returns.toEqualTypeOf<() => void>()
expectTypeOf<RunCompletion['verdict']>().toMatchTypeOf<string>()

// --- Structural payload-discipline rejection proofs -------------------

const validSubAction = {
  testIndex: 0,
  stepIndex: 0,
  subActionIndex: 0,
  plan: 'click Save',
  plannedAction: {} as Action,
  result: {} as RecordedActionResult,
  screenStateHash: 'hash-before',
}

// States collapse to hash identity, so a raw `ScreenState` cannot ride as `stateBefore`.
const rejectsStateBefore: SubActionRecordedPayload = {
  ...validSubAction,
  // @ts-expect-error stateBefore is structurally excluded (?: never)
  stateBefore: {} as ScreenState,
}

// raw image bytes cannot ride any payload member — screenshot is structurally excluded.
const rejectsScreenshotBytes: SubActionRecordedPayload = {
  ...validSubAction,
  // @ts-expect-error a Uint8Array cannot satisfy the excluded screenshot member (?: never)
  screenshot: new Uint8Array(),
}

// the full ServedBrief body is excluded from stepFinalized — only briefDigest travels.
const rejectsServedBrief: StepFinalizedPayload = {
  testIndex: 0,
  stepIndex: 0,
  cacheStatus: 'hit',
  verifierVerdict: {} as VerifierVerdict,
  selfHealOccurred: false,
  briefDigest: 'digest',
  // @ts-expect-error servedBrief is structurally excluded (?: never)
  servedBrief: {} as ServedBrief,
}

// `tokenUsage` is optional and only the triple is admitted; absent is not zero.
const acceptsAbsentTokenUsage: StepFinalizedPayload = {
  testIndex: 0,
  stepIndex: 0,
  cacheStatus: 'hit',
  verifierVerdict: {} as VerifierVerdict,
  selfHealOccurred: false,
  briefDigest: 'digest',
}

const rejectsScalarTokenUsage: StepFinalizedPayload = {
  testIndex: 0,
  stepIndex: 0,
  cacheStatus: 'miss',
  verifierVerdict: {} as VerifierVerdict,
  selfHealOccurred: false,
  briefDigest: 'digest',
  // @ts-expect-error tokenUsage is the {promptTokens, completionTokens, totalTokens} triple
  tokenUsage: 15,
}

const rejectsSteps: TestFinishedPayload = {
  testId: 't1',
  testIndex: 0,
  outcome: 'passed',
  // @ts-expect-error steps are structurally excluded (?: never)
  steps: [] as StepEvidence[],
}

void rejectsStateBefore
void rejectsScreenshotBytes
void rejectsServedBrief
void acceptsAbsentTokenUsage
void rejectsScalarTokenUsage
void rejectsSteps
