import { expectTypeOf } from 'vitest'
import {
  CURRENT_HANDOFF_SCHEMA_VERSION,
  asEvidenceToken,
  asRecordId,
  asRunId,
  computeBriefDigest,
  computeEvidenceToken,
  toRecordedActionResult,
} from '../index'
import type {
  ActionResult,
  ArtifactRef,
  BriefLine,
  BundleKind,
  BundleDraft,
  CautionLine,
  CompareAndSet,
  CompletedRunHandoff,
  Delta,
  DeltaEnvelope,
  Decision,
  EvidenceToken,
  ExecutionContext,
  FactSubtype,
  MemberTestOutcome,
  OriginStage,
  PerTestOutcome,
  ReadTrace,
  RecordId,
  RecordedActionResult,
  RunId,
  RunStatus,
  ServedBrief,
  StepEvidence,
  SubActionEvidence,
  VerifierVerdict,
  Verdict,
  VerdictEvidence,
} from '../index'

expectTypeOf(CURRENT_HANDOFF_SCHEMA_VERSION).toMatchTypeOf<number>()

expectTypeOf(asRunId).parameter(0).toEqualTypeOf<string>()
expectTypeOf(asRunId).returns.toEqualTypeOf<RunId>()
expectTypeOf(asRecordId).returns.toEqualTypeOf<RecordId>()
expectTypeOf(asEvidenceToken).returns.toEqualTypeOf<EvidenceToken>()
expectTypeOf(computeEvidenceToken).returns.toEqualTypeOf<EvidenceToken>()

expectTypeOf<CompletedRunHandoff['runId']>().toEqualTypeOf<RunId>()
expectTypeOf<CompletedRunHandoff['executionContext']>().toEqualTypeOf<ExecutionContext>()
expectTypeOf<CompletedRunHandoff['aggregateVerdict']>().toEqualTypeOf<RunStatus>()
expectTypeOf<CompletedRunHandoff['tests']>().toEqualTypeOf<PerTestOutcome[]>()
expectTypeOf<PerTestOutcome['outcome']>().toEqualTypeOf<MemberTestOutcome>()
expectTypeOf<PerTestOutcome['steps']>().toEqualTypeOf<StepEvidence[]>()
expectTypeOf<StepEvidence['servedBrief']>().toEqualTypeOf<ServedBrief>()
expectTypeOf<StepEvidence['subActions']>().toEqualTypeOf<SubActionEvidence[]>()
expectTypeOf<StepEvidence['verifierVerdict']>().toEqualTypeOf<VerifierVerdict>()
expectTypeOf<VerifierVerdict>().toEqualTypeOf<{ pass: boolean; reasoning: string }>()
expectTypeOf<NonNullable<StepEvidence['selfHeal']>['failedDecision']>().toEqualTypeOf<
  Decision
>()
expectTypeOf<SubActionEvidence['artifactRefs']>().toEqualTypeOf<ArtifactRef[] | undefined>()
expectTypeOf<SubActionEvidence['result']>().toEqualTypeOf<RecordedActionResult>()
expectTypeOf<Omit<RecordedActionResult, 'screenshot'>>().toEqualTypeOf<
  Omit<ActionResult, 'screenshot'>
>()
expectTypeOf(toRecordedActionResult).parameter(0).toEqualTypeOf<ActionResult>()
expectTypeOf(toRecordedActionResult).returns.toEqualTypeOf<RecordedActionResult>()

expectTypeOf<Verdict['class']>().toEqualTypeOf<
  | 'app_bug'
  | 'test_bug'
  | 'environment'
  | 'flake'
  | 'config_error'
  | 'llm_error'
  | 'unknown'
  | 'timeout'
>()
expectTypeOf<Verdict['evidence']>().toEqualTypeOf<VerdictEvidence>()
expectTypeOf<VerdictEvidence['citedArtifacts']>().toEqualTypeOf<ArtifactRef[]>()

expectTypeOf<DeltaEnvelope['citedIds']>().toEqualTypeOf<RecordId[]>()
expectTypeOf<NonNullable<DeltaEnvelope['precondition']>[number]>().toEqualTypeOf<CompareAndSet>()
expectTypeOf<BundleDraft['distilledEvidenceRef']>().toEqualTypeOf<ArtifactRef>()
expectTypeOf<BundleDraft['kind']>().toEqualTypeOf<BundleKind>()
expectTypeOf<BundleDraft['subtype']>().toEqualTypeOf<FactSubtype | undefined>()
expectTypeOf<BundleDraft['originStage']>().toEqualTypeOf<OriginStage>()
expectTypeOf<Extract<Delta, { kind: 'Confirm' }>['evidenceToken']>().toEqualTypeOf<
  EvidenceToken
>()
expectTypeOf<Extract<Delta, { kind: 'FileIssue' }>>().toEqualTypeOf<never>()

expectTypeOf(computeBriefDigest).parameter(0).toEqualTypeOf<ServedBrief>()
expectTypeOf(computeBriefDigest).returns.toEqualTypeOf<string>()
expectTypeOf<ServedBrief['channel1']>().toEqualTypeOf<BriefLine[]>()
expectTypeOf<ServedBrief['channel2']>().toEqualTypeOf<ReadTrace[]>()
expectTypeOf<ServedBrief['channel3']>().toEqualTypeOf<CautionLine[]>()
