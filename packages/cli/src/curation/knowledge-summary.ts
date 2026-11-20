import type { PromotionGateHoldReason, PromotionPath } from '@vostride/agent-qa-schema'

import { shortRunId } from '../reporters/short-run-id.js'
import { PROMOTION_REASON_WORDS } from './promotion-line.js'
import { ciResumeClause } from './resume-limit.js'

export interface KnowledgeSummaryItem {
  readonly outcome: 'learned' | 'held'
  readonly id: string
  readonly reason: PromotionPath | PromotionGateHoldReason
}

// `items` are the gate's decisions and `learned` is what was committed: the two need not add up.
export interface KnowledgeSummary {
  // The run a fold was for; absent for a daemon's drain session, which is not one run's.
  readonly runId?: string
  readonly learned: number
  readonly held: number
  readonly proposed: number
  readonly items: readonly KnowledgeSummaryItem[]
  // Words in place of the numbers when no fold ran here: `handed to the daemon`, or a stage's word.
  readonly instead?: string
  // Present when curation did not finish.
  readonly unfinished?: { readonly notWritten: number; readonly resume: string }
}

export function knowledgeResumeWords(executionContext: string | undefined): string {
  return ciResumeClause(executionContext, 'masked-leg-only') ?? 'resumes on the next run'
}

// Another process can hold the writer lease for its whole lifetime, so these words promise no time.
export function knowledgePendingResumeWords(executionContext: string | undefined): string {
  return ciResumeClause(executionContext, 'masked-leg-only') ?? 'resumes on a later local run'
}

export function knowledgeSummaryOfDrain(input: {
  readonly runId?: string
  readonly executionContext: string | undefined
  readonly complete: boolean
  readonly drain: {
    readonly kind: 'drained' | 'handed-off' | 'aborted'
    readonly committed: number
    readonly evidenceCommitted?: number
    readonly downgraded: number
    readonly requeued: number
    readonly promotions?: readonly {
      readonly candidateId: string
      readonly promotionPath?: PromotionPath
      readonly promotionHoldReason?: PromotionGateHoldReason
    }[]
  }
}): KnowledgeSummary {
  const { drain } = input
  const changes = Math.max(drain.committed - (drain.evidenceCommitted ?? 0), 0)
  const proposed = Math.min(Math.max(drain.downgraded, 0), changes)
  const items: KnowledgeSummaryItem[] = []
  for (const promotion of drain.promotions ?? []) {
    if (promotion.promotionPath !== undefined) {
      items.push({ outcome: 'learned', id: promotion.candidateId, reason: promotion.promotionPath })
    } else if (promotion.promotionHoldReason !== undefined) {
      const reason = promotion.promotionHoldReason
      items.push({ outcome: 'held', id: promotion.candidateId, reason })
    }
  }
  return {
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    learned: changes - proposed,
    held: items.filter((item) => item.outcome === 'held').length,
    proposed,
    items,
    ...(drain.kind === 'handed-off' ? { instead: 'handed to the daemon' } : {}),
    ...(input.complete
      ? {}
      : {
          unfinished: {
            notWritten: Math.max(drain.requeued, 0),
            resume: knowledgeResumeWords(input.executionContext),
          },
        }),
  }
}

// Two reports of one run as one. The later report adds to the kept one: an item both name is
// counted once, by the later decision, and a later report with no numbers erases none.
export function mergeKnowledgeSummaries(
  kept: KnowledgeSummary,
  later: KnowledgeSummary,
): KnowledgeSummary {
  const items = [...kept.items]
  const namedAgain = new Set<number>()
  const countedAgain = { learned: 0, held: 0 }
  let noLongerHeld = 0
  for (const item of later.items) {
    const at = kept.items.findIndex((named, index) =>
      named.id === item.id && !namedAgain.has(index))
    const before = kept.items[at]
    if (before === undefined) {
      items.push(item)
      continue
    }
    namedAgain.add(at)
    items[at] = item
    if (before.outcome === item.outcome) countedAgain[item.outcome] += 1
    else if (before.outcome === 'held') noLongerHeld += 1
  }
  const learned = kept.learned + Math.max(later.learned - countedAgain.learned, 0)
  const held = Math.max(kept.held - noLongerHeld, 0)
    + Math.max(later.held - countedAgain.held, 0)
  const proposed = kept.proposed + later.proposed
  const counted = learned + held + proposed > 0 || items.length > 0
  const instead = counted ? undefined : later.instead ?? kept.instead
  const laterWroteNothing = later.learned + later.held + later.proposed === 0
    && later.items.length === 0
  // What an earlier fold could not write is still unwritten after a fold that wrote nothing.
  const unfinished = later.unfinished === undefined
    ? undefined
    : {
        notWritten: laterWroteNothing
          ? Math.max(kept.unfinished?.notWritten ?? 0, later.unfinished.notWritten)
          : later.unfinished.notWritten,
        resume: later.unfinished.resume,
      }
  return {
    ...(kept.runId === undefined ? {} : { runId: kept.runId }),
    learned,
    held,
    proposed,
    items,
    ...(instead === undefined ? {} : { instead }),
    ...(unfinished === undefined ? {} : { unfinished }),
  }
}

export function knowledgeHeadline(summary: KnowledgeSummary): string {
  if (summary.instead !== undefined) return summary.instead
  const counts = `learned ${summary.learned}, held ${summary.held}`
  return summary.proposed === 0 ? counts : `${counts}, proposed ${summary.proposed}`
}

export function knowledgeSecondLine(summary: KnowledgeSummary): string | undefined {
  const { unfinished } = summary
  if (unfinished === undefined) return undefined
  const { notWritten, resume } = unfinished
  if (notWritten <= 0) return `not finished, ${resume}`
  return `${notWritten} ${notWritten === 1 ? 'change' : 'changes'} not written, ${resume}`
}

export function knowledgeItemLines(summary: KnowledgeSummary): string[] {
  return summary.items.map((item) =>
    `${item.outcome.padEnd(7)}  ${item.id.slice(0, 8)}  ${PROMOTION_REASON_WORDS[item.reason]}`)
}

export function knowledgeTaggedMessage(
  summary: KnowledgeSummary,
  options: { readonly verbose: boolean },
): string {
  const headline = knowledgeHeadline(summary)
  const first = `${headline.charAt(0).toUpperCase()}${headline.slice(1)}${
    summary.runId === undefined ? '' : ` · ${shortRunId(summary.runId)}`
  }`
  const second = knowledgeSecondLine(summary)
  return [
    first,
    ...(second === undefined ? [] : [second]),
    ...(options.verbose ? knowledgeItemLines(summary) : []),
  ].join('\n')
}
