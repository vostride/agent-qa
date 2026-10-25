import { dirname, join, resolve } from 'node:path'
import { trustPriorsForHost, type ResolveTrustPriors } from '../curation/trust-priors.js'
import type { KnowledgeReaderPort } from '@vostride/agent-qa-agent'
import type { FeedbackPort } from '@vostride/agent-qa-schema'
import { RUNS_MARK_FUNCTION_ID } from '@vostride/agent-qa-agent'
import { applyKnowledgeChange, createKnowledgeReader, LOCAL_CURATION_CAPABILITIES, resolveRunExecutionContext, type ExplicitReviewDelegate, type LocalCurationCapabilities } from '@vostride/agent-qa-agent-local'
import { MARK_FIX_REFUSALS, MARK_RECEIPT_SCHEMA_VERSION, RunsMarkInputSchema, type MarkFixRefusal, type AuthoringDraftEditInput, type AuthoringDraftEditOutput, type MarkReceipt, type RunsMarkInput, type RunsMarkOutcome } from '@vostride/agent-qa-schema'
import { resolveConfig, resolveConfiguredKnowledgeRoot } from '../config.js'
import { createDeclaredSecretMask } from '../composition/declared-secrets.js'
import { wordImprovementPlan } from './feedback-wording.js'
import { decideMarkDraft, loadMarkTarget, markEvidenceCurationJobIds, markFeedbackInput, planMarkFeedback, readMarkDraftFacts } from './feedback-plan.js'
import { FsMarkLedger, RUNS_SUBDIR, slugBranch } from '../eval-session-composition.js'
import { answerRecordedMarkEdit, clearMarkEditRecord, MARK_EDIT_RECORD_FILE, withMarkEditScope } from './mark-edit-record.js'

export { resolveMarkMember } from './feedback-plan.js'

export interface FeedbackHostDeps {
  resolveTrustPriors?: ResolveTrustPriors
  configPath: string
  agentQaRoot: string
  invokeAuthoringDraftEdit?: (input: AuthoringDraftEditInput) => Promise<AuthoringDraftEditOutput>
  /** The direct knowledge writer a mark's fix goes through (432-09). Injectable so a cell can fault it. */
  applyKnowledgeChange?: typeof applyKnowledgeChange
  /**
   * How this host reaches a live writer-lease holder with a mark's fix: the holder is handed the
   * validated request and the mark's stable identity, bounded, and the lease is never taken. A host
   * that binds none refuses by name when the lease is held, and a retry resumes from the intent.
   */
  knowledgeChangeDelegate?: ExplicitReviewDelegate
  /**
   * 2026-10-02 (quick 261002-mrk, 432-13 #1): hands the whole mark to a live writer-lease holder
   * before any lock, lease or write; `undefined` means no live holder, so the mark runs here.
   */
  wholeMarkDelegate?: WholeMarkDelegate
  /** The lease this host already holds (the daemon): evidence and fix commit with it, never delegating. */
  writerAuthority?: MarkWriterAuthority
  curation?: Pick<LocalCurationCapabilities, 'appendMarkEvidence' | 'triageMark' | 'servedIdsOn' | 'procedureReadOn' | 'applyFeedback' | 'readFeedbackRecord'> & {
    maintenance: Pick<LocalCurationCapabilities['maintenance'], 'acquireWriterLease' | 'releaseLease'>
  }
  reader?: KnowledgeReaderPort
  now?: () => number
  randomUuid: () => string
  word?: typeof wordImprovementPlan
}

/** The whole-mark hand-off: the holder's answer, or `undefined` when there is no live holder. */
export type WholeMarkDelegate = (input: RunsMarkInput) => Promise<RunsMarkOutcome | undefined>

export interface MarkWriterAuthority {
  /** The knowledge root the held lease covers. A mark resolving another root refuses. */
  readonly knowledgeRoot: string
  readonly authority: () => { readonly leaseId: string; readonly epoch: number }
}

/**
 * Who holds the writer lease, as a refusal names it. 2026-10-03 (quick 261003-lgd, Phase 432 review
 * IN-11): a dashboard or MCP host that runs a run in process holds the lease for that run's own
 * post-run curation, so the holder can be this very process; it is then not "another" one.
 */
function leaseHolderPhrase(holderPid: number): string {
  return holderPid === process.pid
    ? `This agent-qa process (pid ${holderPid}) is already writing to this knowledge store, for `
      + 'example finishing a run\'s post-run curation'
    : `Another agent-qa process (pid ${holderPid}) is writing to this knowledge store`
}

/**
 * 2026-10-02 (261002-mrk follow-up): an agent-qa process that is not a daemon held the knowledge
 * writer lease for the whole wait budget, so the mark was not started and nothing was written.
 */
export class MarkWriterLeaseBusyError extends Error {
  constructor(readonly holderPid: number, readonly waitedMs: number) {
    super(`${leaseHolderPhrase(holderPid)}; waited ${waitedMs}ms and nothing was marked. Retry the `
      + 'mark when it finishes.')
    this.name = 'MarkWriterLeaseBusyError'
  }
}

/**
 * 2026-10-02 (quick 261002-hyg): the knowledge-change sibling of {@link MarkWriterLeaseBusyError}.
 * A change met the writer lease held by another agent-qa process that is not a daemon, so it was
 * not handed anywhere and nothing was changed. `holderPid` is absent when the holder released
 * between the lease check and this refusal.
 */
export class KnowledgeWriterLeaseBusyError extends Error {
  constructor(readonly holderPid: number | undefined) {
    super(holderPid === undefined
      ? 'Another agent-qa process was writing to this knowledge store and has just finished; nothing was '
        + 'changed. Retry the change.'
      : `${leaseHolderPhrase(holderPid)}; nothing was changed. Retry the change when it finishes.`)
    this.name = 'KnowledgeWriterLeaseBusyError'
  }
}

/**
 * The mark's fix was not applied this time and a retry can apply it: evidence stands, no receipt,
 * and the unfinished mark resumes on retry. A refusal from the mark's own planned fix
 * (MARK_FIX_REFUSALS) never reaches here: the mark closes with a `not-applied` receipt instead.
 */
export class MarkFixNotAppliedError extends Error {
  constructor(readonly reason: string) {
    super(`Mark fix was not applied (${reason}); evidence landed, no mark receipt appended. `
      + 'Retry the mark.')
    this.name = 'MarkFixNotAppliedError'
  }
}

const isPlannedFixRefusal = (reason: string): reason is MarkFixRefusal =>
  (MARK_FIX_REFUSALS as readonly string[]).includes(reason)

/** One lazy host, shared by every function surface. Evidence stays under the run lock. */
export function createFeedbackPortForHost(deps: FeedbackHostDeps): FeedbackPort {
  if (deps.writerAuthority !== undefined
    && (deps.wholeMarkDelegate !== undefined || deps.knowledgeChangeDelegate !== undefined)) {
    throw new TypeError('A mark host holding the writer lease never delegates; pass the authority or a delegate, not both')
  }
  const heldAuthority = (knowledgeRoot: string) => {
    const held = deps.writerAuthority
    if (held === undefined) return undefined
    if (resolve(held.knowledgeRoot) !== resolve(knowledgeRoot)) {
      throw new Error('This host holds the writer lease for a different knowledge root than the mark resolves; no mark receipt appended')
    }
    return held.authority()
  }
  const resolveTrustPriors = deps.resolveTrustPriors ?? trustPriorsForHost(deps).resolve
  const curation = deps.curation ?? LOCAL_CURATION_CAPABILITIES
  const ledgerFor = (runId: string) => new FsMarkLedger({ root: deps.agentQaRoot, runId })
  return {
    async marksFor(runId) { return ledgerFor(runId).latestPerAddress() },
    async mark(raw) {
      const input = RunsMarkInputSchema.parse(raw)
      const target = loadMarkTarget(deps.agentQaRoot, input)
      if (target.kind !== 'target') return target
      // Decided before the run lock or any lease, so a delegated mark writes nothing here.
      if (deps.wholeMarkDelegate !== undefined) {
        const delegated = await deps.wholeMarkDelegate(input)
        if (delegated !== undefined) return delegated
      }
      const { handoff, member, address } = target
      const ledger = ledgerFor(input.runId)
      let refusal: RunsMarkOutcome | undefined
      const receipt = await ledger.transact(async ordinal => {
        const prior = ledger.latestFor(address)
        // The preview plans from these same facts; only this transaction's plan carries authority.
        const planned = planMarkFeedback({ input, handoff, member, address, prior, ledgerOrdinal: ordinal - 1, curation })
        if (planned.kind === 'already-marked') {
          refusal = { kind: 'already-marked', receipt: planned.receipt }
          return undefined
        }
        let mark: MarkReceipt = {
          schemaVersion: MARK_RECEIPT_SCHEMA_VERSION, ...input, ...address, runSlug: slugBranch(input.runId),
          markId: `mark_${deps.randomUuid().replace(/-/g, '').slice(0, 12)}`,
          origin: 'user', ordinal, markedAt: (deps.now ?? Date.now)(),
          evidence: { confirmed: 0, overturned: 0 },
          disposition: { kind: 'confirmed-bug', confirmedRecords: 0 },
          ...(prior === undefined ? {} : { supersedes: prior.markId }),
          ...(member.rootCause === undefined ? {} : { rootCause: {
            class: member.rootCause.class, producer: member.rootCause.producer } }),
          ...(member.isRerun === true ? { isRerun: true } : {}),
        }
        if (planned.kind === 'refused') {
          refusal = planned.outcome
          return undefined
        }
        if (planned.kind === 'quarantined') {
          mark.disposition = { kind: 'quarantined', class: planned.class }
          return mark
        }
        // The intent's operation identity is every effect's identity, so a retry from any checkpoint
        // lands the same fix once, in the order evidence, fix, receipt.
        let intent = ledger.prepareIntent(mark, deps.randomUuid())
        mark = intent.mark
        if (intent.stage !== 'applied') {
        const config = await resolveConfig({ configPath: deps.configPath, loadAuthPlugins: false })
        const executionContext = resolveRunExecutionContext()
        const configDir = dirname(resolve(deps.configPath))
        const editRecordPath = join(deps.agentQaRoot, RUNS_SUBDIR, slugBranch(input.runId), MARK_EDIT_RECORD_FILE)
        const knowledgeRoot = resolveConfiguredKnowledgeRoot(config, configDir)
        const held = heldAuthority(knowledgeRoot)
        const { servedRecordIds } = planned.knowledge
        if (intent.stage === 'prepared' && planned.knowledge.appendsEvidence) {
          const lease = held === undefined ? curation.maintenance.acquireWriterLease(knowledgeRoot) : { kind: 'acquired' as const, ...held }
          if (lease.kind !== 'acquired') throw new Error(`Mark evidence writer lease ${lease.kind}; no mark receipt appended`)
          try {
            const evidence = await curation.appendMarkEvidence({ knowledgeRoot,
              executionContext, lease: { leaseId: lease.leaseId, epoch: lease.epoch },
              mark, servedRecordIds, handoff,
              includeAlreadyAppended: true,
              curationJobIds: markEvidenceCurationJobIds(input.runId) })
            if (evidence.correlationIncomplete) throw new Error('Mark evidence correlation incomplete; evidence may have landed, no receipt appended')
            mark.evidence = { confirmed: evidence.confirmed, overturned: evidence.overturned }
          } finally { if (held === undefined) curation.maintenance.releaseLease({ knowledgeRoot, leaseId: lease.leaseId }) }
        }
        intent = ledger.checkpointIntent({ ...intent, mark, stage: 'evidence' })
        if (input.kind === 'confirmed-bug') {
          mark.disposition = { kind: 'confirmed-bug', confirmedRecords: mark.evidence.confirmed }
        } else {
          const step = member.steps[planned.resolvedStep.stepIndex]!
          const reader = deps.reader ?? createKnowledgeReader(() => knowledgeRoot, undefined, undefined, resolveTrustPriors)
          const { served, procedure } = await readMarkDraftFacts({ reader, curation, knowledgeRoot, member, step })
          let plan = intent.plan ?? curation.applyFeedback(markFeedbackInput(mark,
            { handoff, member, step, served, ...(procedure === undefined ? {} : { procedure }) }))
          if (intent.plan === undefined) plan = await (deps.word ?? wordImprovementPlan)({ plan, config, executionContext,
            // Wording keeps its floor when the declared secrets cannot be read: the mask throws inside its catch.
            mask: createDeclaredSecretMask(deps.configPath).mask })
          intent = ledger.checkpointIntent({ ...intent, mark, plan })
          const draft = decideMarkDraft(plan, { servedRecords: served.length, procedureRead: procedure !== undefined,
            member, canDraftTestEdit: deps.invokeAuthoringDraftEdit !== undefined })
          if (draft.kind === 'knowledge') {
            const knowledgePlan = draft.plan
            // The same identity on every attempt: the writer reads a landed change back rather than
            // landing it twice, and a held lease goes to its holder with this exact request.
            const applied = await (deps.applyKnowledgeChange ?? applyKnowledgeChange)({
              agentQaRoot: deps.agentQaRoot, knowledgeRoot, operationId: intent.operationId,
              opId: RUNS_MARK_FUNCTION_ID, executionContext, resolveTrustPriors,
              request: { verb: 'mark', input: { target: knowledgePlan.target,
                mark: { runId: mark.runId, testIndex: mark.testIndex,
                  ...(mark.stepIndex === undefined ? {} : { stepIndex: mark.stepIndex }),
                  markId: mark.markId, kind: mark.kind, fix: knowledgePlan.fix }, plan: knowledgePlan } },
              ...(held === undefined ? {} : { writerAuthority: held }),
              ...(deps.knowledgeChangeDelegate === undefined ? {} : { delegate: deps.knowledgeChangeDelegate }),
            })
            if (applied.outcome !== 'applied') {
              if (!isPlannedFixRefusal(applied.outcome)) throw new MarkFixNotAppliedError(applied.outcome)
              mark.disposition = { kind: 'not-applied', fix: knowledgePlan.fix, reason: applied.outcome }
            } else {
              mark.disposition = { kind: 'applied', fix: knowledgePlan.fix,
                change: { kind: 'knowledge', changeId: applied.changeId, recordIds: [...applied.recordIds] } }
            }
          } else if (draft.kind === 'test-edit') {
            // decideMarkDraft admits a test edit only when this host binds the authoring edit, which
            // writes the edited file itself, guarded by the digest it read (432-08). 261002-mrk: the
            // write is recorded ahead under this intent's identity, so a retry after a crash inside
            // the edit answers that write rather than asking the model and editing again.
            const editScope = { recordPath: editRecordPath, operationId: intent.operationId }
            const written = answerRecordedMarkEdit({ ...editScope, configDir })
              ?? (await withMarkEditScope(editScope, () => deps.invokeAuthoringDraftEdit!({
                testRef: draft.plan.testRef, intent: draft.plan.intent }))).written
            if (written.kind !== 'written') {
              if (!isPlannedFixRefusal(written.reason)) throw new MarkFixNotAppliedError(written.reason)
              mark.disposition = { kind: 'not-applied', fix: 'test-edit', reason: written.reason }
            } else {
              mark.disposition = { kind: 'applied', fix: 'test-edit',
                change: { kind: 'test-file', filePath: written.filePath, contentDigest: written.contentDigest } }
            }
          } else {
            mark.disposition = { kind: 'no-draftable-fix', checked: draft.checked }
          }
        }
        ledger.checkpointIntent({ ...intent, mark, stage: 'applied' })
        clearMarkEditRecord(editRecordPath)
        }
        return mark
      })
      if (receipt !== undefined) return { kind: 'marked', receipt }
      if (refusal !== undefined) return refusal
      throw new Error('Mark transaction returned neither a receipt nor a refusal')
    },
  }
}
