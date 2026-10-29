// Executes the shared read-only plan and appends evidence under the caller's authority.
import { asRecordId, type CompletedRunHandoff, type ExecutionContext, type MarkReceipt } from '@vostride/agent-qa-schema'
import { appendOutcomeEvent } from '../bundle-append.js'
import type { BundleStoreConfig } from '../bundle-publish.js'
import { withCurrentWriterAuthority } from '../lease/writer-lease.js'
import { markEvidenceEvent, planMarkEvidence, type AppendMarkEvidenceOutcome } from './mark-evidence-plan.js'

export { MARK_EVIDENCE_TOKEN_PREFIX, type AppendMarkEvidenceOutcome } from './mark-evidence-plan.js'

export interface AppendMarkEvidenceInput {
  knowledgeRoot: string
  executionContext: ExecutionContext
  lease: { leaseId: string; epoch: number }
  mark: Pick<MarkReceipt, 'markId' | 'runId' | 'kind'>
  servedRecordIds: readonly string[]
  /** Historical observation hashes require the original member/step coordinates. */
  handoff?: CompletedRunHandoff
  /** Host-derived chainJobIdsForRun(runId, idSource).curateMemory; never guessed here. */
  curationJobIds?: readonly string[]
  /** Resuming one mark reports its complete logical effect, including already durable events. */
  includeAlreadyAppended?: boolean
}

export async function appendMarkEvidence(input: AppendMarkEvidenceInput): Promise<AppendMarkEvidenceOutcome> {
  if (input.handoff !== undefined && input.handoff.runId !== input.mark.runId) {
    throw new TypeError('mark evidence handoff belongs to another run')
  }
  return withCurrentWriterAuthority(input.knowledgeRoot, input.lease, () => {
    // Plan under the lease so the appended effects are the ones the current bundles support.
    const plan = planMarkEvidence({ knowledgeRoot: input.knowledgeRoot,
      mark: { runId: input.mark.runId, kind: input.mark.kind }, servedRecordIds: input.servedRecordIds,
      ...(input.handoff === undefined ? {} : { handoff: input.handoff }),
      ...(input.curationJobIds === undefined ? {} : { curationJobIds: input.curationJobIds }) })
    const result: AppendMarkEvidenceOutcome = { confirmed: 0, overturned: 0, skipped: [],
      ...(plan.correlationIncomplete === true ? { correlationIncomplete: true as const } : {}) }
    for (const target of plan.targets) {
      if (target.kind === 'unreadable') {
        result.skipped.push({ recordId: target.recordId, reason: 'bundle-unreadable' })
        continue
      }
      const config: BundleStoreConfig = { knowledgeRoot: input.knowledgeRoot, productKey: target.productKey,
        writerLeaseId: input.lease.leaseId, writerEpoch: input.lease.epoch }
      let changed = false
      for (const effect of target.effects) {
        const outcome = appendOutcomeEvent(config, asRecordId(target.recordId),
          markEvidenceEvent(effect, input.mark.markId, target.buildOrdinal))
        // Do not misreport a lost target as a successful mark.
        if (outcome.kind !== 'appended' && outcome.kind !== 'duplicate') {
          throw new Error(`mark evidence append refused: ${outcome.kind}`)
        }
        if (outcome.kind === 'duplicate' && input.includeAlreadyAppended !== true) continue
        if (effect.direction === 'confirm') result.confirmed += 1
        else result.overturned += 1
        changed = true
      }
      if (!changed) result.skipped.push({ recordId: target.recordId, reason: 'already-appended' })
    }
    return result
  })
}
