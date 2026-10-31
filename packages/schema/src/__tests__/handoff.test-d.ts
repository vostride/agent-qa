import { expectTypeOf, test } from 'vitest'
import { CURRENT_HANDOFF_SCHEMA_VERSION } from '../handoff/completed-run-handoff'
import type { Action } from '../action/index'
import type { ServedBrief } from '../brief/served-brief'
import type { CompletedRunHandoff } from '../handoff/completed-run-handoff'
import type { PerTestOutcome } from '../handoff/per-test-outcome'
import type { StepEvidence, VerifierVerdict } from '../handoff/step-evidence'
import type { SubActionEvidence } from '../handoff/sub-action-evidence'
import type { ArtifactRef } from '../ids/artifact-ref'
import type { RecordedActionResult } from '../result/index'
import type { MemberTestOutcome } from '../run/member-outcome'
import type { RunStatus } from '../run/run-status'
import type { ScreenState } from '../screen/screen-state'

test('the aggregate verdict is a run status, not a root-cause verdict', () => {
  expectTypeOf<CompletedRunHandoff['aggregateVerdict']>().toEqualTypeOf<RunStatus>()

  const verdictShaped = { class: 'app_bug' as const }

  // @ts-expect-error aggregateVerdict is a RunStatus execution verdict, not a root-cause Verdict.
  const invalidAggregateVerdict: CompletedRunHandoff['aggregateVerdict'] = verdictShaped

  void invalidAggregateVerdict
})

test('the handoff nests per-test, step and sub-action evidence with fixed types', () => {
  expectTypeOf<SubActionEvidence['stateBefore']>().toEqualTypeOf<ScreenState>()
  expectTypeOf<SubActionEvidence['stateAfter']>().toEqualTypeOf<ScreenState | undefined>()
  expectTypeOf<SubActionEvidence['artifactRefs']>().toEqualTypeOf<ArtifactRef[] | undefined>()
  expectTypeOf<SubActionEvidence['decisionScreenshotRef']>().toEqualTypeOf<ArtifactRef | undefined>()

  expectTypeOf<CompletedRunHandoff['tests']>().toEqualTypeOf<PerTestOutcome[]>()
  expectTypeOf<PerTestOutcome['steps']>().toEqualTypeOf<StepEvidence[]>()
  expectTypeOf<StepEvidence['subActions']>().toEqualTypeOf<SubActionEvidence[]>()
  expectTypeOf<StepEvidence['servedBrief']>().toEqualTypeOf<ServedBrief>()

  expectTypeOf<CompletedRunHandoff['schemaVersion']>().toEqualTypeOf<number>()
  expectTypeOf(CURRENT_HANDOFF_SCHEMA_VERSION).toMatchTypeOf<number>()
})

test('the verifier verdict is a pass and reasoning shape, not a root-cause verdict', () => {
  expectTypeOf<StepEvidence['verifierVerdict']>().toEqualTypeOf<VerifierVerdict>()
  expectTypeOf<VerifierVerdict>().toEqualTypeOf<{ pass: boolean; reasoning: string }>()

  const verifierVerdictShaped = { class: 'app_bug' as const }

  // @ts-expect-error verifierVerdict is a verifier pass/reasoning shape, not a root-cause Verdict.
  const invalidVerifierVerdict: StepEvidence['verifierVerdict'] = verifierVerdictShaped

  void invalidVerifierVerdict
})

test('a sub-action records its planned action and recorded result', () => {
  expectTypeOf<SubActionEvidence['plannedAction']>().toEqualTypeOf<Action>()
  expectTypeOf<SubActionEvidence['result']>().toEqualTypeOf<RecordedActionResult>()
})

test('skipped is a member outcome and never an aggregate verdict', () => {
  // `skipped` is a member-only outcome and never an aggregate `RunStatus`.
  expectTypeOf<PerTestOutcome['outcome']>().toEqualTypeOf<MemberTestOutcome>()
  const skippedMember: PerTestOutcome['outcome'] = 'skipped'

  // @ts-expect-error 'skipped' is member-level only — never assignable to the aggregate verdict.
  const invalidSkippedAggregate: CompletedRunHandoff['aggregateVerdict'] = 'skipped'

  void skippedMember
  void invalidSkippedAggregate
})
