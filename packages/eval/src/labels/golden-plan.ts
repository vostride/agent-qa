import type { Action, CompletedRunHandoff, Mark, MarkAddress, MarkReceipt } from '@vostride/agent-qa-schema'
import type { ExtractedCassette } from '../extract/extract-run'
import { deriveGoldCassetteId, deriveLeafCassetteId, deriveRunSlug } from '../extract/ids'
import { collectStepSelections } from '../extract/select'
import { projectCorpusEntry } from './corpus-entry'
import { projectOverturnedVerdictLabelRecord, projectUserMarkLabelRecord } from './label-record'
import type { SeedingPlanCase } from './seeding-plan'
import type { CommittedCorpusSnapshot } from '../census/derive-census'

export type GoldenTrajectoryTarget = {
  testIndex: number
  stepIndex: number
  reason: 'step-mark' | 'failing-step' | 'passing-verdict'
}

/** 2026-09-08, 419 D-05: resolve one addressed member, never a whole trace. */
export function resolveMarkedDecisions(
  handoff: CompletedRunHandoff, address: MarkAddress, kind: Mark,
): GoldenTrajectoryTarget[] | { refusal: 'step-not-found'; stepCount: number } {
  if (address.runId !== handoff.runId) throw new Error('mark run does not match handoff')
  const members = handoff.tests.filter(member => member.testIndex === address.testIndex)
  const member = members[0]
  if (members.length !== 1 || member === undefined ||
    (address.testId !== undefined && address.testId !== member.testId)) {
    throw new Error('mark member does not match handoff')
  }
  if (address.stepIndex !== undefined) {
    if (!Number.isInteger(address.stepIndex) || address.stepIndex < 0 || address.stepIndex >= member.steps.length) {
      return { refusal: 'step-not-found', stepCount: member.steps.length }
    }
    return [{ testIndex: member.testIndex, stepIndex: address.stepIndex, reason: 'step-mark' }]
  }
  if (member.steps.length === 0) return { refusal: 'step-not-found', stepCount: 0 }
  const failing = kind === 'false-pass' ? -1 : member.steps.findIndex(step => step.verifierVerdict?.pass === false)
  return [{
    testIndex: member.testIndex,
    stepIndex: failing < 0 ? member.steps.length - 1 : failing,
    reason: failing < 0 ? 'passing-verdict' : 'failing-step',
  }]
}

export interface GoldenTrajectoryPlan {
  product: string
  runId: string
  runSlug: string
  markId: string
  cases: SeedingPlanCase[]
  goldCassettes: ExtractedCassette[]
  skipped: { cassetteId: string; reason: 'missing-cassette' | 'not-leaf' }[]
}

export function markedDecisionCount(handoff: CompletedRunHandoff, targets: readonly GoldenTrajectoryTarget[]): number {
  return targets.reduce((count, target) => {
    const handoffTest = handoff.tests.find(member => member.testIndex === target.testIndex)!
    return count + collectStepSelections({ handoffTest, step: handoffTest.steps[target.stepIndex]! }).selections.length
  }, 0)
}

export type MarkGoldChannel = 'user-mark' | 'overturned-verdict'
export type MarkGoldClaim = { cassetteId: string; sourceCassetteId: string; channel: MarkGoldChannel }
export type GoldMark = Omit<MarkReceipt, 'gold' | 'correctedExpectation' | 'correctedAction'> & {
  gold: readonly MarkGoldClaim[]
  correctedExpectation?: string
  correctedAction?: Action
}
export type MarkLabelIntent = Pick<GoldMark, 'kind' | 'correctedExpectation' | 'correctedAction'>

/** 2026-09-15, 423 D-16: every marked decision freezes a user-mark label; a false-pass also freezes its overturned verdict. */
export function markGoldChannels(kind: Mark): MarkGoldChannel[] {
  return kind === 'false-pass' ? ['user-mark', 'overturned-verdict'] : ['user-mark']
}

export type MarkLabelTargetResolution =
  | { kind: 'step-not-found'; stepCount: number }
  | { kind: 'ambiguous-correction'; targets: GoldenTrajectoryTarget[]; decisionCount: number }
  | { kind: 'resolved'; targets: GoldenTrajectoryTarget[]; decisionCount: number }

/** The freeze's refusal order: an unresolvable step first, then an executable correction that is not one decision. */
export function resolveMarkLabelTargets(
  handoff: CompletedRunHandoff, address: MarkAddress, mark: MarkLabelIntent,
): MarkLabelTargetResolution {
  const targets = resolveMarkedDecisions(handoff, address, mark.kind)
  if ('refusal' in targets) return { kind: 'step-not-found', stepCount: targets.stepCount }
  const decisionCount = markedDecisionCount(handoff, targets)
  if (mark.correctedAction !== undefined && decisionCount !== 1) {
    return { kind: 'ambiguous-correction', targets, decisionCount }
  }
  return { kind: 'resolved', targets, decisionCount }
}

export interface BuildGoldenTrajectoryPlanInput {
  handoff: CompletedRunHandoff
  cassettes: readonly ExtractedCassette[]
  mark: GoldMark
  product: string
  supersedes?: string
  priorGold?: GoldMark['gold']
}

/** Pure freeze plan. The writer executes these private assignments and observed bytes verbatim. */
export function buildGoldenTrajectoryPlan({
  handoff, cassettes, mark, product, supersedes, priorGold,
}: BuildGoldenTrajectoryPlanInput): GoldenTrajectoryPlan {
  const resolution = resolveMarkLabelTargets(handoff, mark, mark)
  if (resolution.kind === 'step-not-found') throw new Error(`step-not-found: stepCount=${resolution.stepCount}`)
  if (resolution.kind === 'ambiguous-correction') {
    throw new Error('ambiguous-correction: executable correction requires exactly one decision')
  }
  const { targets } = resolution
  const runSlug = deriveRunSlug(handoff.runId)
  const plan: GoldenTrajectoryPlan = {
    product, runId: handoff.runId, runSlug, markId: mark.markId,
    cases: [], goldCassettes: [], skipped: [],
  }
  for (const target of targets) {
    const handoffTest = handoff.tests.find(member => member.testIndex === target.testIndex)!
    const step = handoffTest.steps[target.stepIndex]!
    const { selections } = collectStepSelections({ handoffTest, step })
    for (const selection of selections) {
      const leafId = deriveLeafCassetteId({ runSlug, ...selection })
      const matches = cassettes.filter(entry => entry.cassette.id === leafId)
      if (matches.length > 1) throw new Error('duplicate extracted gold source')
      const extracted = matches[0]
      if (extracted === undefined || extracted.cassette.granularity !== 'leaf') {
        plan.skipped.push({ cassetteId: leafId, reason: extracted === undefined ? 'missing-cassette' : 'not-leaf' })
        continue
      }
      const cassette = extracted.cassette
      if (cassette.runId !== handoff.runId || cassette.testIndex !== target.testIndex || cassette.stepIndex !== step.stepIndex) {
        throw new Error('gold source does not match marked decision')
      }
      for (const channel of markGoldChannels(mark.kind)) {
        const overturned = channel === 'overturned-verdict'
        const goldId = deriveGoldCassetteId({ leafCassetteId: overturned ? `${leafId}-overturned` : leafId, markOrdinal: mark.ordinal })
        const gold = { ...cassette, id: goldId }
        const previous = priorGold?.filter(item => item.sourceCassetteId === cassette.id && item.channel === channel)
        if (previous !== undefined && previous.length > 1) throw new Error('ambiguous prior gold generation')
        const input = { cassette, runId: handoff.runId, goldCassetteId: goldId, mark,
          supersedes: priorGold === undefined ? supersedes : previous?.[0]?.cassetteId }
        plan.cases.push({
          cassetteId: goldId,
          labelRecord: overturned ? projectOverturnedVerdictLabelRecord(input) : projectUserMarkLabelRecord(input),
          corpusEntry: projectCorpusEntry({ cassette: gold, product, runId: handoff.runId,
            assignment: { split: 'held-out', heldOutVisibility: 'private' } }),
        })
        plan.goldCassettes.push({ ...extracted, cassette: gold })
      }
    }
  }
  plan.cases.sort((a, b) => a.cassetteId < b.cassetteId ? -1 : a.cassetteId > b.cassetteId ? 1 : 0)
  plan.goldCassettes.sort((a, b) => a.cassette.id < b.cassette.id ? -1 : a.cassette.id > b.cassette.id ? 1 : 0)
  plan.skipped.sort((a, b) => a.cassetteId < b.cassetteId ? -1 : a.cassetteId > b.cassetteId ? 1 : 0)
  return plan
}

/** Only completed latest marks admit their gold; historical and unfinished files remain inspectable. */
export function activeMarkedCorpusEntries(snapshot: CommittedCorpusSnapshot, marks: readonly GoldMark[]) {
  const latest = new Map<string, GoldMark>()
  for (const mark of marks) {
    const key = JSON.stringify([mark.runId, mark.testIndex, mark.stepIndex ?? null])
    if ((latest.get(key)?.ordinal ?? 0) < mark.ordinal) latest.set(key, mark)
  }
  const active = new Set([...latest.values()].flatMap(mark => mark.gold.map(item => item.cassetteId)))
  return snapshot.entries.filter(entry => {
    const label = snapshot.labelsById.get(entry.cassetteId)
    const marked = label?.provenance.sourceCassetteId !== undefined
      && (label.label.sourceChannel === 'user-mark' || label.label.sourceChannel === 'overturned-verdict')
    return !marked || active.has(entry.cassetteId)
  })
}
