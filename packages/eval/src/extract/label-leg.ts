import type {
  StepEvidence,
  SubActionEvidence,
  Verdict,
} from '@vostride/agent-qa-schema'
import type {
  CassetteLabelLeg,
  RecordedFailureContext,
} from '../cassette/label-leg'

export interface ProjectLabelLegInput {
  step: StepEvidence
  subAction: SubActionEvidence
  // The member test's root cause, copied verbatim when supplied; a step-only caller has none.
  rootCause?: Verdict
}

export function projectLabelLeg({ step, rootCause }: ProjectLabelLegInput): CassetteLabelLeg {
  const recordedFailure: RecordedFailureContext = {
    ...(step.verifierVerdict.pass
      ? {}
      : { verifierReasoning: step.verifierVerdict.reasoning }),
    ...(step.planningFailure === undefined
      ? {}
      : { planningFailureReason: step.planningFailure.reason }),
    ...(step.termination === undefined
      ? {}
      : { termination: step.termination.reason }),
  }
  const hasRecordedFailure = Object.keys(recordedFailure).length > 0

  return {
    verdict: step.verifierVerdict,
    sourceChannel: 'recorded-verdict',
    tier: 'silver',
    ...(hasRecordedFailure ? { recordedFailure } : {}),
    ...(rootCause === undefined ? {} : { rootCause }),
  }
}
