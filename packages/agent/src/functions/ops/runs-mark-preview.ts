// what runs.mark would do for this exact input, through the read-only
// feedbackReads port. The result is prospective: no intent, lease, model call, id mint or write.
import { RunsMarkInputSchema, RunsMarkPreviewResultSchema, maskRecordContent } from '@vostride/agent-qa-schema'
import type { MaskFn, RunsMarkInput, RunsMarkPreviewResult } from '@vostride/agent-qa-schema'

import { FunctionNotBoundError } from '../spec.js'
import type { ClauseVerdict, FunctionSpec } from '../spec.js'
import { runsMarkSpec } from './runs-mark.js'
import { requireSecretMask } from './secret-mask.js'

export const RUNS_MARK_PREVIEW_FUNCTION_ID = 'runs.mark.preview'

// Only free text crosses the mask. Ids, kinds, counts and addresses stay structural;
// joined record content and evidence tokens are masked exactly as runs.knowledge masks them.
function maskResult(result: RunsMarkPreviewResult, mask: MaskFn): RunsMarkPreviewResult {
  if (result.kind !== 'consequences') return result
  return {
    ...result,
    knowledge: {
      ...result.knowledge,
      records: result.knowledge.records.map(record => ({
        ...record,
        ...(record.recordContent === undefined ? {} : { recordContent: maskRecordContent(record.recordContent, mask) }),
        evidence: record.evidence.kind === 'unreadable' ? record.evidence : {
          kind: 'effects' as const,
          effects: record.evidence.effects.map(effect => effect.direction === 'confirm' ? effect
            : { ...effect, overturnsEvidenceToken: mask(effect.overturnsEvidenceToken) }),
        },
      })),
    },
  }
}

export const runsMarkPreviewSpec: FunctionSpec<RunsMarkInput, RunsMarkPreviewResult> = {
  id: RUNS_MARK_PREVIEW_FUNCTION_ID,
  summary: 'Preview what runs.mark would do for this exact input: its refusals, resolved step, the knowledge records it reaches with their content and evidence effects, and the fix it would apply, without writing.',
  resultKind: 'unary',
  boundThrough: 'feedbackReads',
  input: RunsMarkInputSchema,
  output: RunsMarkPreviewResultSchema,
  risk: { name: `fn:${RUNS_MARK_PREVIEW_FUNCTION_ID}`, recognized: true, readOnly: true },
  classify(output): ClauseVerdict {
    switch (output.kind) {
      case 'consequences':
        return { status: 'executed', outcome: `preview: ${output.markKind} would apply ${output.draft.kind} at step ${output.resolvedStep.stepIndex} (nothing written)` }
      case 'quarantined':
        return { status: 'executed', outcome: `preview: ${output.markKind} would be quarantined as ${output.class} (nothing written)` }
      case 'already-marked':
        return { status: 'executed', outcome: 'preview: identical repeat of an existing mark (nothing written)' }
      case 'run-not-found':
      case 'member-not-found':
      case 'step-not-found':
      case 'ambiguous-address':
        // The writer's own refusal wording; classify interpolates only structural fields.
        return runsMarkSpec.classify(output)
      default:
        return output satisfies never
    }
  },
  async invoke(input, deps) {
    const parsed = RunsMarkInputSchema.parse(input)
    const preview = deps.feedbackReads?.preview
    if (preview === undefined) throw new FunctionNotBoundError(RUNS_MARK_PREVIEW_FUNCTION_ID)
    const answer = await preview.call(deps.feedbackReads, parsed)
    if (answer.runId !== parsed.runId) throw new Error('feedbackReads.preview answered for another run')
    const mask = requireSecretMask(deps, RUNS_MARK_PREVIEW_FUNCTION_ID)
    return RunsMarkPreviewResultSchema.parse(maskResult(answer, mask))
  },
}
