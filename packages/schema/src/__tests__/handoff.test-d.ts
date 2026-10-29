import { expectTypeOf } from 'vitest'
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

expectTypeOf<CompletedRunHandoff['aggregateVerdict']>().toEqualTypeOf<RunStatus>()

const verdictShaped = { class: 'app_bug' as const }

// @ts-expect-error aggregateVerdict is a RunStatus execution verdict, not a root-cause Verdict.
const invalidAggregateVerdict: CompletedRunHandoff['aggregateVerdict'] = verdictShaped

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

expectTypeOf<StepEvidence['verifierVerdict']>().toEqualTypeOf<VerifierVerdict>()
expectTypeOf<VerifierVerdict>().toEqualTypeOf<{ pass: boolean; reasoning: string }>()

const verifierVerdictShaped = { class: 'app_bug' as const }

// @ts-expect-error verifierVerdict is a verifier pass/reasoning shape, not a root-cause Verdict.
const invalidVerifierVerdict: StepEvidence['verifierVerdict'] = verifierVerdictShaped

expectTypeOf<SubActionEvidence['plannedAction']>().toEqualTypeOf<Action>()
expectTypeOf<SubActionEvidence['result']>().toEqualTypeOf<RecordedActionResult>()

// PerTestOutcome.outcome splits off RunStatus onto the member-level MemberTestOutcome
// (RunStatus + 'skipped'). 'skipped' is a member-only concept — it can never be an aggregate.
expectTypeOf<PerTestOutcome['outcome']>().toEqualTypeOf<MemberTestOutcome>()
const skippedMember: PerTestOutcome['outcome'] = 'skipped'

// @ts-expect-error 'skipped' is member-level only — never assignable to the aggregate verdict.
const invalidSkippedAggregate: CompletedRunHandoff['aggregateVerdict'] = 'skipped'

void invalidAggregateVerdict
void invalidVerifierVerdict
void skippedMember
void invalidSkippedAggregate
