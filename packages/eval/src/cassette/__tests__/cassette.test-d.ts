import type {
  Action,
  ActionAnnotation,
  ArtifactRef,
  DeclaredModelProfile,
  SamplingParams,
  ScreenState,
  ServedBrief,
  ToolExchangeEvidence,
  VerifierVerdict,
  Verdict,
  WorkingMemoryEntry,
} from '@vostride/agent-qa-schema'
import { expectTypeOf, test } from 'vitest'
import type {
  CassetteCompleteness,
  CassetteInputLeg,
  CassetteJudgeReceipt,
  CassetteLabelLeg,
  CassetteReceipt,
  CassetteSidecarLeg,
  ContrastivePairing,
  GoldAnchorDescriptor,
  MissingCassetteEvidence,
  MissingCassetteEvidenceKind,
} from '../../index'

test('the cassette legs carry their optional pairing, root cause, judge, memory and gold anchor', () => {
  expectTypeOf<CassetteLabelLeg['pairing']>().toEqualTypeOf<
    ContrastivePairing | undefined
  >()
  expectTypeOf<CassetteLabelLeg['rootCause']>().toEqualTypeOf<Verdict | undefined>()
  expectTypeOf<CassetteJudgeReceipt['tier4JudgeId']>().toEqualTypeOf<string | undefined>()
  expectTypeOf<CassetteInputLeg['workingMemory']>().toEqualTypeOf<
    WorkingMemoryEntry[] | undefined
  >()
  expectTypeOf<CassetteSidecarLeg['goldAnchor']>().toEqualTypeOf<
    GoldAnchorDescriptor | undefined
  >()
})

test('the cassette input, sidecar, label and receipt legs carry the schema types', () => {
  expectTypeOf<CassetteInputLeg['stateBefore']>().toEqualTypeOf<ScreenState>()
  expectTypeOf<CassetteInputLeg['servedBrief']>().toEqualTypeOf<ServedBrief>()
  expectTypeOf<CassetteInputLeg['exchanges']>().toEqualTypeOf<ToolExchangeEvidence[]>()
  expectTypeOf<CassetteInputLeg['modelProfile']>().toEqualTypeOf<
    DeclaredModelProfile | undefined
  >()
  expectTypeOf<CassetteSidecarLeg['goldAction']>().toEqualTypeOf<Action>()
  expectTypeOf<CassetteSidecarLeg['annotation']>().toEqualTypeOf<
    ActionAnnotation | undefined
  >()
  expectTypeOf<CassetteLabelLeg['verdict']>().toEqualTypeOf<VerifierVerdict | undefined>()
  expectTypeOf<CassetteReceipt['sampling']['declared']>().toEqualTypeOf<
    SamplingParams | undefined
  >()
})

test('cassette artifact references and missing evidence are typed refs, never bare strings', () => {
  expectTypeOf<CassetteInputLeg['decisionScreenshotRef']>().toEqualTypeOf<
    ArtifactRef | undefined
  >()
  expectTypeOf<CassetteInputLeg['auxiliaryArtifactRefs']>().toEqualTypeOf<
    readonly ArtifactRef[] | undefined
  >()
  expectTypeOf<CassetteInputLeg['decisionScreenshotRef']>().not.toEqualTypeOf<
    string | undefined
  >()
  expectTypeOf<CassetteCompleteness['missingEvidence']>().toEqualTypeOf<
    readonly MissingCassetteEvidence[] | undefined
  >()
  expectTypeOf<CassetteCompleteness['missingEvidence']>().not.toEqualTypeOf<
    MissingCassetteEvidence[] | undefined
  >()
  expectTypeOf<MissingCassetteEvidence['kind']>().toEqualTypeOf<MissingCassetteEvidenceKind>()
  expectTypeOf<MissingCassetteEvidenceKind>().toEqualTypeOf<'decision-screenshot-ref'>()
  expectTypeOf<MissingCassetteEvidence['stepIndex']>().toEqualTypeOf<number>()
  expectTypeOf<MissingCassetteEvidence['decisionOrdinal']>().toEqualTypeOf<number>()
  expectTypeOf<ArtifactRef['evidenceIncomplete']>().toEqualTypeOf<boolean | undefined>()
  expectTypeOf<ArtifactRef['evidenceIncomplete']>().not.toEqualTypeOf<boolean>()
  expectTypeOf<CassetteInputLeg['auxiliaryArtifactRefs']>().not.toEqualTypeOf<
    readonly string[] | undefined
  >()
  expectTypeOf<CassetteInputLeg['auxiliaryArtifactRefs']>().not.toEqualTypeOf<
    ArtifactRef | undefined
  >()
  expectTypeOf<CassetteInputLeg['decisionScreenshotRef']>().not.toEqualTypeOf<
    { id: string } | undefined
  >()
  expectTypeOf<ArtifactRef['id']>().toEqualTypeOf<string>()
  expectTypeOf<ArtifactRef['sha']>().toEqualTypeOf<string>()
})
