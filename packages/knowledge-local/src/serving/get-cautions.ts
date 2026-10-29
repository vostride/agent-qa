import {
  canonicalJson,
  createServingAdmissionState,
  normalizeAnchor,
  servingRecordMetadata,
  tryAdmitServingRecord,
  type Anchor,
  type CautionBlock,
  type IndexEntry,
  type ServedRetrievalTraceV1,
  type TraceLine,
} from '@vostride/agent-qa-schema'

import { compareServingTrustThenId } from './brief-selection.js'
import { renderCautionLine } from './brief-render.js'
import {
  CHANNEL_3_CAUTION_LEG,
  composeServedTrace,
  traceLine,
} from './serve-trace.js'

export interface CautionSelectionOverflow {
  served: number
  eligible: number
}

export interface CautionSelectionResult {
  block: CautionBlock
  overflow?: CautionSelectionOverflow
  // Produced while selecting: `rank` is the position below and `score` the trust it ordered by.
  trace: ServedRetrievalTraceV1
}

export interface SelectCautionsInput {
  readonly candidates: readonly IndexEntry[]
  readonly anchors: readonly Anchor[]
  readonly budget: number
  readonly recordCap?: number
}

interface RankedCaution {
  readonly record: IndexEntry
  readonly matchPriority: number
  readonly summary: string
  readonly cost: number
}

const MATCH_PRIORITY: Readonly<Partial<Record<Anchor['t'], number>>> = {
  el: 0,
  page: 1,
  flow: 2,
}

function normalizedAnchorKey(anchor: Anchor): string {
  return canonicalJson(normalizeAnchor(anchor))
}

function queryPriorities(anchors: readonly Anchor[]): Map<string, number> {
  const priorities = new Map<string, number>()

  for (const anchor of anchors) {
    const priority = MATCH_PRIORITY[anchor.t]
    if (priority === undefined) continue
    const key = normalizedAnchorKey(anchor)
    priorities.set(key, Math.min(priority, priorities.get(key) ?? priority))
  }

  return priorities
}

function bestMatchPriority(
  anchors: readonly Anchor[],
  priorities: ReadonlyMap<string, number>,
): number | undefined {
  let best: number | undefined

  for (const anchor of anchors) {
    const priority = priorities.get(normalizedAnchorKey(anchor))
    if (priority !== undefined) best = Math.min(best ?? priority, priority)
  }

  return best
}

function isEligibleCaution(record: IndexEntry): boolean {
  if (record.kind !== 'caution') return false
  if (record.status === 'active') return true
  return record.status === 'candidate' && record.unverified === true
}

function rankedCautions(input: SelectCautionsInput): RankedCaution[] {
  const priorities = queryPriorities(input.anchors)

  return input.candidates
    .flatMap((record): RankedCaution[] => {
      if (!isEligibleCaution(record)) return []
      const matchPriority = bestMatchPriority(record.anchors, priorities)
      if (matchPriority === undefined) return []
      const rendered = renderCautionLine(record)
      return [{
        record,
        matchPriority,
        summary: rendered.summary,
        cost: rendered.cost,
      }]
    })
    .sort((left, right) => (
      left.matchPriority - right.matchPriority
      || compareServingTrustThenId(left.record, right.record)
    ))
}

// Ignores Channel-1 membership on purpose: an L1 caution re-surfaces at the failure moment.
export function selectCautions(input: SelectCautionsInput): CautionSelectionResult {
  const ranked = rankedCautions(input)
  const recordCap = input.recordCap ?? ranked.length
  const admission = createServingAdmissionState()
  const cautions: CautionBlock['cautions'] = []
  const admissions: CautionBlock['admissions'] = []
  const servedLines: TraceLine[] = []
  const truncated: TraceLine[] = []

  for (const [index, candidate] of ranked.entries()) {
    const metadata = servingRecordMetadata({
      id: candidate.record.id,
      anchors: candidate.record.anchors,
      renderedCost: candidate.cost,
    })
    // `score` is the trust ordered within an anchor-match band; `rank` carries the band itself.
    const line = traceLine({
      recordId: String(candidate.record.id),
      leg: CHANNEL_3_CAUTION_LEG,
      rank: index + 1,
      score: candidate.record.trust,
    })
    if (!tryAdmitServingRecord({
      record: metadata,
      budget: input.budget,
      recordCap,
    }, admission).admitted) {
      truncated.push(line)
      continue
    }

    cautions.push({
      id: candidate.record.id,
      anchors: candidate.record.anchors,
      summary: candidate.summary,
    })
    admissions.push(metadata)
    servedLines.push(line)
  }

  const block: CautionBlock = { cautions, budgetUsed: admission.usedBudget, admissions }
  const trace = composeServedTrace({ servedLines, truncated })
  return cautions.length < ranked.length
    ? { block, overflow: { served: cautions.length, eligible: ranked.length }, trace }
    : { block, trace }
}
