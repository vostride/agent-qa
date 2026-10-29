// Read-only: reads the mark ledger and joins changed records; no lock, lease, intent or writer.
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { KnowledgeReaderPort } from '@vostride/agent-qa-agent'
import { createKnowledgeReader, FsMarkLedger, HANDOFF_FILE, MarkLedgerCorruptError, RUNS_SUBDIR } from '@vostride/agent-qa-agent-local'
import { projectRecordContent, RunsMarkInputSchema, slugBranch, type FeedbackReadsPort, type KnowledgeRecordShowResult, type MarkHistoryChangedRecord, type MarkHistoryReadEntry, type MarkPreviewBasis, type MarkReceipt, type RunsMarkPreviewResult } from '@vostride/agent-qa-schema'
import { resolveConfig, resolveConfiguredKnowledgeRoot } from '../config.js'
import { previewMarkConsequences, type MarkPlanBasis, type MarkPlanCuration } from './feedback-plan.js'

export interface FeedbackReadsHostDeps {
  agentQaRoot: string
  /**
   * The project config that locates the knowledge root. Without it the host binds history only, and
   * a changed record keeps its id with the named absence `not-bound`.
   */
  configPath?: string
  /** Read halves only: the preview's type admits no append, fix, lease or model call. */
  curation?: MarkPlanCuration
  reader?: KnowledgeReaderPort
  /** Mirrors a writer host that binds the authoring draft edit; the preview never invokes it. */
  canDraftTestEdit?: boolean
}

const basisOf = (basis: MarkPlanBasis): MarkPreviewBasis => ({ ledgerOrdinal: basis.ledgerOrdinal,
  ...(basis.priorOrdinal === undefined ? {} : { priorMarkOrdinal: basis.priorOrdinal }) })

/** The knowledge ids an applied fix names, or none for every other disposition. */
function changedRecordIdsOf(receipt: MarkReceipt): readonly string[] | undefined {
  const { disposition } = receipt
  return disposition.kind === 'applied' && disposition.change.kind === 'knowledge' ? disposition.change.recordIds : undefined
}

export function createFeedbackReadsPortForHost(deps: FeedbackReadsHostDeps): FeedbackReadsPort {
  // One batch read; no loadable config answers `not-bound`, an unfinished scan `scan-incomplete`.
  async function joinChangedRecords(recordIds: readonly string[]): Promise<(recordId: string) => MarkHistoryChangedRecord> {
    const absent = (reason: 'not-found' | 'scan-incomplete' | 'not-bound') => (recordId: string) =>
      ({ recordId, contentAbsence: { reason } })
    if (deps.configPath === undefined) return absent('not-bound')
    if (recordIds.length === 0) return absent('not-found')
    const configPath = deps.configPath
    let reader = deps.reader
    if (reader === undefined) {
      try {
        // A config that does not load binds no read.
        const config = await resolveConfig({ configPath, loadAuthPlugins: false })
        const knowledgeRoot = resolveConfiguredKnowledgeRoot(config, dirname(resolve(configPath)))
        reader = createKnowledgeReader(() => knowledgeRoot)
      } catch {
        return absent('not-bound')
      }
    }
    const showRecords = reader.showRecords
    if (showRecords === undefined) return absent('not-bound')
    let results: readonly KnowledgeRecordShowResult[]
    try {
      results = await showRecords.call(reader, { recordIds: [...new Set(recordIds)] })
    } catch (error) {
      if (!(error instanceof Error && error.name === 'KnowledgeMaintenanceScanError')) throw error
      return absent('scan-incomplete')
    }
    const found = new Map(results.flatMap(result => result.kind === 'found'
      ? [[result.record.recordId, projectRecordContent(result)] as const] : []))
    return recordId => {
      const recordContent = found.get(recordId)
      return recordContent === undefined ? { recordId, contentAbsence: { reason: 'not-found' } } : { recordId, recordContent }
    }
  }

  const configPath = deps.configPath
  async function preview(raw: unknown): Promise<RunsMarkPreviewResult> {
    const input = RunsMarkInputSchema.parse(raw)
    const previewed = await previewMarkConsequences({ configPath: configPath!, agentQaRoot: deps.agentQaRoot,
      ...(deps.curation === undefined ? {} : { curation: deps.curation }),
      ...(deps.reader === undefined ? {} : { reader: deps.reader }),
      canDraftTestEdit: deps.canDraftTestEdit === true }, input)
    const prospective = { runId: input.runId, prospective: true as const, markKind: input.kind }
    switch (previewed.kind) {
      case 'run-not-found':
      case 'member-not-found':
      case 'ambiguous-address':
      case 'step-not-found':
        return previewed
      case 'already-marked': {
        const { receipt } = previewed
        return { kind: 'already-marked', runId: input.runId, basis: basisOf(previewed.basis), prior: {
          markId: receipt.markId, kind: receipt.kind, ordinal: receipt.ordinal, testIndex: receipt.testIndex,
          ...(receipt.testId === undefined ? {} : { testId: receipt.testId }),
          ...(receipt.stepIndex === undefined ? {} : { stepIndex: receipt.stepIndex }),
          disposition: receipt.disposition } }
      }
      case 'quarantined':
        return { kind: 'quarantined', ...prospective, member: previewed.member, resolvedStep: previewed.resolvedStep,
          class: previewed.class, latest: previewed.latest, basis: basisOf(previewed.basis) }
      case 'consequences':
        return { kind: 'consequences', ...prospective, member: previewed.member, resolvedStep: previewed.resolvedStep,
          knowledge: previewed.knowledge, draft: previewed.draft,
          latest: previewed.latest, basis: basisOf(previewed.basis) }
      default:
        return previewed satisfies never
    }
  }

  return {
    ...(configPath === undefined ? {} : { preview }),
    async history(runId) {
      if (!existsSync(join(deps.agentQaRoot, RUNS_SUBDIR, slugBranch(runId), HANDOFF_FILE))) return { kind: 'run-not-found' }
      let receipts: MarkReceipt[]
      try {
        receipts = new FsMarkLedger({ root: deps.agentQaRoot, runId }).read()
      } catch (error) {
        if (error instanceof MarkLedgerCorruptError) return { kind: 'ledger-corrupt', line: error.line }
        return { kind: 'ledger-unavailable' }
      }
      const joinFor = await joinChangedRecords(receipts.flatMap(receipt => changedRecordIdsOf(receipt) ?? []))
      const entries: MarkHistoryReadEntry[] = receipts.map(receipt => {
        const recordIds = changedRecordIdsOf(receipt)
        return recordIds === undefined ? { receipt } : { receipt, changedRecords: recordIds.map(joinFor) }
      })
      return { kind: 'history', entries }
    },
  }
}
