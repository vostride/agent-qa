// Type claims live in a `.test-d.ts`, because vitest typechecks only `*.test-d.ts` files.

import type {
  BriefWhyInput, FeedbackPort, FeedbackReadsPort, QuarantineOperationsPort, RunsMarkInput,
} from '@vostride/agent-qa-schema'
import { describe, expectTypeOf, test } from 'vitest'

import type { mapStepEvidenceToWhy } from '../ops/knowledge-brief-why.js'
import type {
  FunctionDeps,
  KnowledgeChangeRequest,
  KnowledgeReaderPort,
  KnowledgeReviewPort,
  OptionalFunctionDepKey,
  RunsReaderPort,
  StepEvidenceLookup,
} from '../spec.js'
import type { OPTIONAL_FUNCTION_DEP_KEYS } from '../spec.js'

// An exact member set fails on any new member, whatever its name, unlike a per-name check.
expectTypeOf<keyof KnowledgeReaderPort>().toEqualTypeOf<
  'listBundles' | 'inspectRecords' | 'diffSince' | 'showRecord' | 'showRecords' | 'canaryAttributions' | 'gateReceipts'
>()

// The same claim from the other side, and it is not redundant with the one above: it is what
// makes a WIDENING of the reader into the review port a compile error rather than something a
// reviewer has to notice. If someone folded the mutating verbs into the reader, this line would
// start passing — so it is asserted to be false.
expectTypeOf<KnowledgeReaderPort>().not.toMatchTypeOf<KnowledgeReviewPort>()

// An optional dep must join this union, or it cannot report itself `unbound`.
expectTypeOf<OptionalFunctionDepKey>()
  .toEqualTypeOf<
    | 'liveView'
    | 'runInvocation'
    | 'knowledgeReview'
    | 'postProcessing'
    | 'runDetail'
    | 'evidenceBlobs'
    | 'analysis'
    | 'recurrence'
    | 'quarantine'
    | 'chatTurn'
    | 'draftEvaluation'
    | 'authoringRead'
    | 'authoringScope'
    | 'draftShelf'
    | 'authoringFunnel'
    | 'configFiles'
    | 'configValidate'
    | 'scaffoldContent'
    | 'capabilityCatalog'
    | 'feedback'
    | 'feedbackReads'
    | 'configWrite'
    | 'secretMask'
  >()

// Every member of that union must actually be an optional member of the deps record — the half
// that would otherwise let the union name a dep nobody supplies.
expectTypeOf<OptionalFunctionDepKey>().toMatchTypeOf<keyof FunctionDeps>()
expectTypeOf<FunctionDeps['knowledgeReview']>().toEqualTypeOf<KnowledgeReviewPort | undefined>()
expectTypeOf<FunctionDeps['knowledge']>().toEqualTypeOf<KnowledgeReaderPort>()
// Named in the union and optional on the record; its port type lives in schema, not `spec.ts`.
expectTypeOf<FunctionDeps['quarantine']>().toEqualTypeOf<QuarantineOperationsPort | undefined>()
// Exactly three verbs, pinned for the same exact-set reason the review port's surface is: a
// fourth power arriving quietly would be one no host ever declared it could supply.
expectTypeOf<keyof QuarantineOperationsPort>().toEqualTypeOf<'list' | 'release' | 'add'>()

// An exact set: a member arriving quietly would be a power no host declared.
expectTypeOf<keyof KnowledgeReviewPort>().toEqualTypeOf<'change'>()
expectTypeOf<KnowledgeChangeRequest['verb']>().toEqualTypeOf<'accept' | 'reject' | 'forget'>()
expectTypeOf<KnowledgeChangeRequest['operationId']>().toEqualTypeOf<string | undefined>()

// ---- 3. The step-evidence read distinguishes four situations, not two -------------------------
//
// The why-verb's honesty rests on telling "no such run" from "no such step" from "your address
// matches more than one step". A `StepEvidence | undefined` return would have collapsed all
// three into one silence, and the arm that matters most — ambiguity — would have been reported
// as an absence. Pinned as the exact discriminant set.
expectTypeOf<StepEvidenceLookup['kind']>().toEqualTypeOf<
  'found' | 'run-not-recorded' | 'step-not-found' | 'ambiguous-step-address'
>()

// The read is on the RUNS port, never the knowledge port. That placement is the whole reason
// re-running retrieval is not a temptation the why-verb has to resist: its substrate is a run's
// recorded evidence, and the op is handed no serving capability at all.
expectTypeOf<RunsReaderPort>().toHaveProperty('readStepEvidence')
expectTypeOf<KnowledgeReaderPort>().not.toHaveProperty('readStepEvidence')

// `mapStepEvidenceToWhy` takes only (lookup, input), so it has no handle to reach any index.
expectTypeOf<Parameters<typeof mapStepEvidenceToWhy>>().toEqualTypeOf<
  [StepEvidenceLookup, BriefWhyInput]
>()

// Hand-spelled, not shared with section 2, and in `test` blocks so vitest counts each assertion.
type HandSpelledOptionalDepKey =
  | 'liveView' | 'runInvocation' | 'knowledgeReview' | 'postProcessing' | 'runDetail'
  | 'evidenceBlobs' | 'analysis' | 'recurrence' | 'quarantine'
  | 'chatTurn' | 'draftEvaluation' | 'authoringRead' | 'authoringScope'
  | 'draftShelf' | 'authoringFunnel' | 'configFiles'
  | 'configValidate'
  | 'scaffoldContent' | 'capabilityCatalog' | 'feedback' | 'feedbackReads' | 'configWrite'
  | 'secretMask'

describe('the feedback bindings', () => {
  test('pins the optional dep key union and its runtime roster in both directions', () => {
    expectTypeOf<OptionalFunctionDepKey>().toEqualTypeOf<HandSpelledOptionalDepKey>()
    expectTypeOf<(typeof OPTIONAL_FUNCTION_DEP_KEYS)[number]>().toEqualTypeOf<HandSpelledOptionalDepKey>()
    expectTypeOf<Exclude<OptionalFunctionDepKey, (typeof OPTIONAL_FUNCTION_DEP_KEYS)[number]>>().toEqualTypeOf<never>()
    expectTypeOf<Exclude<(typeof OPTIONAL_FUNCTION_DEP_KEYS)[number], OptionalFunctionDepKey>>().toEqualTypeOf<never>()
  })

  test('binds the feedback writer and the read-only feedback observations as two optional deps', () => {
    expectTypeOf<Extract<OptionalFunctionDepKey, `feedback${string}`>>().toEqualTypeOf<'feedback' | 'feedbackReads'>()
    expectTypeOf<FunctionDeps['feedback']>().toEqualTypeOf<FeedbackPort | undefined>()
    expectTypeOf<FunctionDeps['feedbackReads']>().toEqualTypeOf<FeedbackReadsPort | undefined>()
  })

  test('pins the read binding to history and preview, with no writer verb', () => {
    expectTypeOf<keyof FeedbackReadsPort>().toEqualTypeOf<'history' | 'preview'>()
    expectTypeOf<keyof FeedbackPort>().toEqualTypeOf<'mark' | 'marksFor'>()
    expectTypeOf<Extract<keyof FeedbackReadsPort, keyof FeedbackPort>>().toEqualTypeOf<never>()
    expectTypeOf<Parameters<NonNullable<FeedbackReadsPort['preview']>>>().toEqualTypeOf<[RunsMarkInput]>()
  })
})

// The type half of the same-named block in optional-dep-keys.test.ts.
describe('no standingGrants binding', () => {
  test('FunctionDeps declares no standingGrants member', () => {
    expectTypeOf<Extract<keyof FunctionDeps, 'standingGrants'>>().toEqualTypeOf<never>()
  })

  test('OptionalFunctionDepKey has no standingGrants member', () => {
    expectTypeOf<Extract<OptionalFunctionDepKey, 'standingGrants'>>().toEqualTypeOf<never>()
    expectTypeOf<Extract<(typeof OPTIONAL_FUNCTION_DEP_KEYS)[number], 'standingGrants'>>().toEqualTypeOf<never>()
  })

  test('the roster still counts 23 members, so the absence is not vacuous', () => {
    expectTypeOf<(typeof OPTIONAL_FUNCTION_DEP_KEYS)['length']>().toEqualTypeOf<23>()
  })
})
