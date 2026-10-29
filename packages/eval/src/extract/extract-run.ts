import type {
  CompletedRunHandoff,
  SubActionEvidence,
} from '@vostride/agent-qa-schema'
import {
  CASSETTE_SCHEMA_VERSION,
  type Cassette,
  type CassetteGranularity,
  type DecisionRecord,
  type LeafCassette,
} from '../cassette/cassette'
import type { CompletenessStatus } from '../cassette/completeness'
import { guardCassette } from '../cassette/guard'
import type { ArtifactSource } from '../ports'
import {
  buildCompleteness,
  collectBlobShas,
  missingRequiredEvidence,
  resolveBlobClosure,
  type ExtractedBlob,
} from './blob-closure'
import { deriveLeafCassetteId, deriveRunSlug } from './ids'
import { projectInputLeg } from './input-leg'
import { projectLabelLeg } from './label-leg'
import {
  buildProcedureCassette,
  type ProcedureDecisionInput,
} from './procedure'
import { assembleReceipt } from './receipt'
import { collectStepSelections, type SelectionSkip } from './select'
import { projectSidecarLeg } from './sidecar-leg'

export interface ExtractedCassette {
  cassette: Cassette
  blobs: ExtractedBlob[]
}

export interface EmittedCassetteSummary {
  id: string
  granularity: CassetteGranularity
  completenessStatus: CompletenessStatus
}

export interface ExtractionReport {
  runId: string
  emitted: EmittedCassetteSummary[]
  skips: SelectionSkip[]
}

export interface ExtractionResult {
  cassettes: ExtractedCassette[]
  report: ExtractionReport
}

export interface ExtractRunCassettesInput {
  handoff: CompletedRunHandoff
  artifacts: ArtifactSource
}

function actionRef(subAction: SubActionEvidence): string | undefined {
  const action = subAction.plannedAction
  return 'ref' in action && typeof action.ref === 'string' ? action.ref : undefined
}

function emittedSummary(cassette: Cassette): EmittedCassetteSummary {
  return {
    id: cassette.id,
    granularity: cassette.granularity,
    completenessStatus: cassette.completeness.status,
  }
}

/** Project every live decision and per-test procedure in one deterministic pass. */
export function extractRunCassettes({
  handoff,
  artifacts,
}: ExtractRunCassettesInput): ExtractionResult {
  const runSlug = deriveRunSlug(handoff.runId)
  const cassettes: ExtractedCassette[] = []
  const emitted: EmittedCassetteSummary[] = []
  const skips: SelectionSkip[] = []

  for (const handoffTest of handoff.tests) {
    const procedureDecisions: ProcedureDecisionInput[] = []

    for (const step of handoffTest.steps) {
      const selected = collectStepSelections({ handoffTest, step })
      skips.push(...selected.skips)

      for (const selection of selected.selections) {
        const input = projectInputLeg({
          handoffTest,
          step,
          subAction: selection.subAction,
          testIndex: selection.testIndex,
          stepIndex: selection.stepIndex,
          decisionOrdinal: selection.decisionOrdinal,
        })
        const projectedSidecar = projectSidecarLeg({ subAction: selection.subAction })
        const record: DecisionRecord = {
          input,
          sidecar: projectedSidecar.leg,
          label: projectLabelLeg({
            step,
            subAction: selection.subAction,
            // the root cause is recorded on the MEMBER, not the step, so the extractor
            // is the one caller that can supply it. Absent members stay absent — extraction
            // never mints a verdict the run did not record.
            rootCause: handoffTest.rootCause,
          }),
          receipt: assembleReceipt({
            inputLeg: input,
            step,
            subAction: selection.subAction,
            handoff,
          }),
        }
        const blobShas = collectBlobShas(input)
        const closure = resolveBlobClosure(blobShas, artifacts)
        const missingEvidence = missingRequiredEvidence(input)
        const unresolvedAnchorRef = projectedSidecar.anchorUnresolved
          ? actionRef(selection.subAction)
          : undefined
        const cassette: LeafCassette = {
          schemaVersion: CASSETTE_SCHEMA_VERSION,
          id: deriveLeafCassetteId({
            runSlug,
            testIndex: selection.testIndex,
            stepIndex: selection.stepIndex,
            decisionOrdinal: selection.decisionOrdinal,
          }),
          runId: handoff.runId,
          testId: selection.testId,
          testIndex: selection.testIndex,
          blobs: blobShas,
          completeness: buildCompleteness({
            missingShas: closure.missingShas,
            anchorUnresolved: projectedSidecar.anchorUnresolved,
            unresolvedAnchorRef,
            missingEvidence,
          }),
          granularity: 'leaf',
          stepIndex: selection.stepIndex,
          decisionOrdinal: selection.decisionOrdinal,
          input: record.input,
          sidecar: record.sidecar,
          label: record.label,
          receipt: record.receipt,
        }
        const guarded = guardCassette(cassette)
        if (guarded.granularity !== 'leaf') {
          throw new TypeError('Leaf cassette guard returned the wrong granularity')
        }

        cassettes.push({ cassette: guarded, blobs: closure.blobs })
        emitted.push(emittedSummary(guarded))
        procedureDecisions.push({
          stepIndex: selection.stepIndex,
          decisionOrdinal: selection.decisionOrdinal,
          record,
          blobShas,
          missingEvidence,
          anchorUnresolved: projectedSidecar.anchorUnresolved,
          ...(unresolvedAnchorRef === undefined ? {} : { unresolvedAnchorRef }),
        })
      }
    }

    const procedure = buildProcedureCassette({
      handoff,
      handoffTest,
      runSlug,
      decisions: procedureDecisions,
      artifacts,
    })
    cassettes.push(procedure)
    emitted.push(emittedSummary(procedure.cassette))
  }

  return {
    cassettes,
    report: { runId: handoff.runId, emitted, skips },
  }
}
