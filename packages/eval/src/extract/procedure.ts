import type {
  CompletedRunHandoff,
  PerTestOutcome,
} from '@vostride/agent-qa-schema'
import {
  CASSETTE_SCHEMA_VERSION,
  type DecisionRecord,
  type ProcedureCassette,
  type ProcedureEndState,
  type ProcedureStepRecord,
} from '../cassette/cassette'
import type { MissingCassetteEvidence } from '../cassette/completeness'
import { guardCassette } from '../cassette/guard'
import type { ArtifactSource } from '../ports'
import {
  buildCompleteness,
  resolveBlobClosure,
  type ExtractedBlob,
} from './blob-closure'
import { deriveProcedureCassetteId } from './ids'
import { classifySubAction } from './select'

export interface ProcedureDecisionInput {
  stepIndex: number
  decisionOrdinal: number
  record: DecisionRecord
  blobShas: readonly string[]
  missingEvidence: readonly MissingCassetteEvidence[]
  anchorUnresolved: boolean
  unresolvedAnchorRef?: string
}

export interface BuildProcedureCassetteInput {
  handoff: CompletedRunHandoff
  handoffTest: PerTestOutcome
  runSlug: string
  decisions: readonly ProcedureDecisionInput[]
  artifacts: ArtifactSource
}

export interface BuiltProcedureCassette {
  cassette: ProcedureCassette
  blobs: ExtractedBlob[]
}

function decisionKey(stepIndex: number, decisionOrdinal: number): string {
  return `${stepIndex}:${decisionOrdinal}`
}

function orderedBlobShas(decisions: readonly ProcedureDecisionInput[]): string[] {
  const shas: string[] = []
  const seen = new Set<string>()
  for (const decision of decisions) {
    for (const sha of decision.blobShas) {
      if (seen.has(sha)) continue
      seen.add(sha)
      shas.push(sha)
    }
  }
  return shas
}

function orderedMissingEvidence(
  decisions: readonly ProcedureDecisionInput[],
): MissingCassetteEvidence[] {
  const facts: MissingCassetteEvidence[] = []
  const seen = new Set<string>()
  for (const decision of decisions) {
    for (const fact of decision.missingEvidence) {
      const key = `${fact.kind}:${fact.stepIndex}:${fact.decisionOrdinal}`
      if (seen.has(key)) continue
      seen.add(key)
      facts.push(fact)
    }
  }
  return facts
}

function procedureSteps(
  handoffTest: PerTestOutcome,
  decisions: readonly ProcedureDecisionInput[],
): ProcedureStepRecord[] {
  const byPosition = new Map(
    decisions.map((decision) => [
      decisionKey(decision.stepIndex, decision.decisionOrdinal),
      decision,
    ]),
  )
  const records: ProcedureStepRecord[] = []

  for (const step of handoffTest.steps) {
    if (step.subActions.length === 0) {
      records.push({ kind: 'synthesized', stepIndex: step.stepIndex })
      continue
    }

    step.subActions.forEach((subAction, decisionOrdinal) => {
      if (classifySubAction(subAction) === 'cache-hit') {
        records.push({
          kind: 'cache-served',
          stepIndex: step.stepIndex,
          decisionOrdinal,
        })
        return
      }

      const decision = byPosition.get(decisionKey(step.stepIndex, decisionOrdinal))
      if (decision === undefined) {
        throw new TypeError(
          `Procedure decision missing for step ${step.stepIndex} ordinal ${decisionOrdinal}`,
        )
      }
      records.push({
        kind: 'decision',
        stepIndex: step.stepIndex,
        decisionOrdinal,
        record: decision.record,
      })
    })
  }

  return records
}

function procedureEndState(handoffTest: PerTestOutcome): ProcedureEndState {
  const finalStep = handoffTest.steps[handoffTest.steps.length - 1]
  let finalAssert: ProcedureEndState['finalAssert']

  outer: for (let stepPosition = handoffTest.steps.length - 1; stepPosition >= 0; stepPosition--) {
    const step = handoffTest.steps[stepPosition]!
    for (
      let decisionOrdinal = step.subActions.length - 1;
      decisionOrdinal >= 0;
      decisionOrdinal--
    ) {
      if (
        step.subActions[decisionOrdinal]!.plannedAction.type === 'assertValue' &&
        step.assertOutcome !== undefined
      ) {
        finalAssert = step.assertOutcome
      }
      break outer
    }
  }

  return {
    outcome: handoffTest.outcome,
    ...(finalStep === undefined ? {} : { finalVerdict: finalStep.verifierVerdict }),
    ...(finalAssert === undefined ? {} : { finalAssert }),
  }
}

/** Assemble one ordering-faithful, self-contained procedure cassette per test. */
export function buildProcedureCassette({
  handoff,
  handoffTest,
  runSlug,
  decisions,
  artifacts,
}: BuildProcedureCassetteInput): BuiltProcedureCassette {
  const blobShas = orderedBlobShas(decisions)
  const closure = resolveBlobClosure(blobShas, artifacts)
  const unresolved = decisions.find((decision) => decision.anchorUnresolved)
  const completeness = buildCompleteness({
    missingShas: closure.missingShas,
    anchorUnresolved: unresolved !== undefined,
    unresolvedAnchorRef: unresolved?.unresolvedAnchorRef,
    missingEvidence: orderedMissingEvidence(decisions),
  })
  const cassette: ProcedureCassette = {
    schemaVersion: CASSETTE_SCHEMA_VERSION,
    id: deriveProcedureCassetteId({ runSlug, testIndex: handoffTest.testIndex }),
    runId: handoff.runId,
    testId: handoffTest.testId,
    testIndex: handoffTest.testIndex,
    blobs: blobShas,
    completeness,
    granularity: 'procedure',
    steps: procedureSteps(handoffTest, decisions),
    endState: procedureEndState(handoffTest),
  }
  const guarded = guardCassette(cassette)
  if (guarded.granularity !== 'procedure') {
    throw new TypeError('Procedure cassette guard returned the wrong granularity')
  }

  return { cassette: guarded, blobs: closure.blobs }
}
