import { assembleBriefTiers } from '@vostride/agent-qa-runner'
import {
  servingRecordMetadata,
  type BriefBlock,
  type BriefLine,
  type IndexEntry,
  type ScopeKey,
  type ServedRetrievalTraceV1,
  type TraceLine,
} from '@vostride/agent-qa-schema'

import {
  selectServingRecordsWithProvenance,
  type ServingSelectionEntry,
} from './brief-selection.js'
import { estimateRenderedServingCost, renderBriefLine } from './brief-render.js'
import {
  CHANNEL_1_SERVING_LEG,
  composeServedTrace,
  traceLine,
} from './serve-trace.js'
import type { readPolicyLadder } from './policy-ladder.js'

type OriginStampedEntry = IndexEntry & {
  origin?: 'app-observed' | 'user'
  originClass?: 'agent-observed' | 'agent-verified' | 'import' | 'user'
}

interface AssembleRunBriefInput {
  candidates: IndexEntry[]
  policy: ReturnType<typeof readPolicyLadder>
  scope: ScopeKey
  budget: number
  recordCap: number
  asOfBuild?: number
}

function isUserFact(entry: IndexEntry): boolean {
  const stampedEntry = entry as OriginStampedEntry
  return entry.kind === 'fact'
    && entry.status === 'active'
    && (stampedEntry.origin === 'user' || stampedEntry.originClass === 'user')
}

function compareRecordId(left: IndexEntry, right: IndexEntry): number {
  const leftId = String(left.id)
  const rightId = String(right.id)
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0
}

function renderSovereignLine(entry: IndexEntry): { briefLine: BriefLine; cost: number } {
  return {
    cost: estimateRenderedServingCost(entry.summary),
    briefLine: {
      id: entry.id,
      kind: entry.kind,
      summary: entry.summary,
      trust: entry.trust,
      status: entry.status,
      servedAsCanary: entry.servedAsCanary,
      tier: 'L0',
    },
  }
}

function normalizedRecordCap(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

function policyWarnings(policy: ReturnType<typeof readPolicyLadder>): string[] {
  return policy.oversized.map(({ file, approxTokens }) => (
    `oversized policy ${file}: approximately ${approxTokens} tokens; served whole`
  ))
}

function truncationSignal(
  served: number,
  eligible: number,
  warnings: readonly string[],
): string {
  const signals = served < eligible ? [`truncated ${served} of ${eligible}`] : []
  signals.push(...warnings)
  return signals.join('\n')
}

/**
 * The Channel-1 brief together with the serve-time trace that explains it. One value,
 * never two calls: a caller cannot obtain the brief without also receiving how it was chosen.
 */
export interface AssembledRunBrief {
  readonly brief: BriefBlock
  readonly trace: ServedRetrievalTraceV1
}

/**
 * Attribute the served and cut candidates from the ONE ranking the assembly already produced.
 *
 * `eligible` is the full serve-time ranking (unbounded budget, no record cap); `selected` is what
 * the real budget admitted from it. Both were computed above for the truncation SIGNAL the brief
 * already carries, so the trace adds no retrieval work — it reads the same two lists.
 *
 * Rank is the candidate's position in the FULL ranking, so a served line and a cut candidate are
 * comparable numbers: "served, ranked 2nd" and "cut, ranked 21st" answer the same question. A
 * served record is always present in the full ranking (the budgeted pass admits a subset of what
 * the unbounded pass stages), which `__tests__/serve-trace.test.ts` asserts directly rather than assuming;
 * the fallback below exists so that a future change to the staging path degrades into a
 * still-valid, still-ordered rank instead of an invalid one.
 */
function assembleTrace(
  eligible: readonly ServingSelectionEntry[],
  selected: readonly ServingSelectionEntry[],
): ServedRetrievalTraceV1 {
  const fullRanking = new Map(
    eligible.map((entry) => [String(entry.record.id), entry]),
  )
  const servedIds = new Set(selected.map(({ record }) => String(record.id)))

  const servedLines: TraceLine[] = selected.map((entry, index) => {
    const ranked = fullRanking.get(String(entry.record.id))
    return traceLine({
      recordId: String(entry.record.id),
      leg: CHANNEL_1_SERVING_LEG,
      rank: ranked?.rank ?? eligible.length + index + 1,
      score: ranked?.score ?? entry.score,
    })
  })

  const truncated: TraceLine[] = eligible
    .filter(({ record }) => !servedIds.has(String(record.id)))
    .map((entry) => traceLine({
      recordId: String(entry.record.id),
      leg: CHANNEL_1_SERVING_LEG,
      rank: entry.rank,
      score: entry.score,
    }))

  return composeServedTrace({ servedLines, truncated })
}

/**
 * Assemble the deterministic Channel-1 brief over records already loaded by the reader, together
 * with its serve-time retrieval trace.
 * L0 is sovereign and whole; the supplied budget applies only to learned L1/L2 records.
 *
 * The trace covers the LEARNED lines only. Sovereign L0 user facts never enter the ranking — they
 * are filtered out before selection and served whole because they are sovereign — so listing them
 * in a retrieval trace would attribute them to a leg that took no part in serving them. Their
 * "why" is the sovereignty rule, not a retrieval decision.
 */
export function assembleRunBrief(input: AssembleRunBriefInput): AssembledRunBrief {
  const userFacts = input.candidates.filter(isUserFact).sort(compareRecordId)
  const learnedCandidates = input.candidates.filter((entry) => !isUserFact(entry))
  const recordCap = Math.max(0, normalizedRecordCap(input.recordCap) - userFacts.length)
  const temporalInput = input.asOfBuild === undefined
    ? {}
    : { asOfBuild: input.asOfBuild }

  const eligibleEntries = selectServingRecordsWithProvenance({
    candidates: learnedCandidates,
    scope: input.scope,
    channelBudget: Number.MAX_SAFE_INTEGER,
    recordCap: learnedCandidates.length,
    ...temporalInput,
  })
  const selectedEntries = selectServingRecordsWithProvenance({
    candidates: learnedCandidates,
    scope: input.scope,
    channelBudget: input.budget,
    recordCap,
    ...temporalInput,
  })
  const selected = selectedEntries.map(({ record }) => record)
  const rendered = selected.map(renderBriefLine)
  const sovereignLines = userFacts.map((record) => ({
    record,
    rendered: renderSovereignLine(record),
  }))

  const brief: BriefBlock = {
    tiers: assembleBriefTiers(
      input.policy.text,
      userFacts.map(({ summary }) => summary),
      rendered.map(({ line, briefLine }) => ({ line, tier: briefLine.tier })),
    ),
    lines: [
      ...sovereignLines.map(({ rendered: { briefLine } }) => briefLine),
      ...rendered.map(({ briefLine }) => briefLine),
    ],
    truncation: truncationSignal(
      selected.length,
      eligibleEntries.length,
      policyWarnings(input.policy),
    ),
    admissions: [
      ...sovereignLines.map(({ record, rendered }) => servingRecordMetadata({
        id: record.id,
        anchors: record.anchors,
        renderedCost: rendered.cost,
      })),
      ...selected.map((record, index) => servingRecordMetadata({
        id: record.id,
        anchors: record.anchors,
        renderedCost: rendered[index]!.cost,
      })),
    ],
  }

  return { brief, trace: assembleTrace(eligibleEntries, selectedEntries) }
}
