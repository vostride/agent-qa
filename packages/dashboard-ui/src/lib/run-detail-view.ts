// Absent is not zero: no sum here defaults to zero, so an unmeasured run never reads as free.

import type {
  RunDetailArtifactRef,
  RunDetailMember,
  RunDetailProjection,
  RunDetailStep,
  RunDetailSubAction,
  RunModelSummary,
  RunTokenTotals,
} from '@vostride/agent-qa-schema'

import { t } from '@/i18n'

import { formatNumber, formatTokens } from './format'

// ---------------------------------- copy ----------------------------------

// The run page and the live step list draw this one catalog sentence, so they cannot disagree.
export const DID_NOT_RUN_LABEL = () => t('runDetail.member.didNotRun')

/** What the token line says when the run carries no measurement at all. */
export const TOKENS_NOT_MEASURED_LABEL = () => t('runDetail.usage.tokensNotMeasured')

/** The usage card's heading over a run that spoke to more than one model identity. */
export const MODELS_HEADING = () => t('runDetail.usage.modelsHeading')

// The line is a focusable `span`, not a button, so its name says that focusing it opens details.
export const TOKEN_USAGE_TRIGGER_LABEL = () => t('runDetail.usage.triggerLabel')

// Missing bytes differ from masked values and failed reads, as each sends a reader somewhere else.
export const EVIDENCE_INCOMPLETE_LABEL = () => t('runDetail.evidence.incomplete')

// The same text, not a second string, so the two names cannot disagree.
export const SCREENSHOT_UNAVAILABLE_LABEL = () => EVIDENCE_INCOMPLETE_LABEL()

// Distinct from an empty projection, so a server fault never looks like a quiet test.
export const RUN_DETAIL_UNAVAILABLE_LABEL = () => t('runDetail.unavailable')

/** The screen-context affordance when the post-state matched the pre-state. */
export const SCREEN_STATE_UNCHANGED_LABEL = () => t('runDetail.screenState.unchanged')

/** The screen-context affordance when a distinct post-state is recorded. */
export const SCREEN_STATE_CHANGED_LABEL = () => t('runDetail.screenState.changed')

// -------------------------------- grouping --------------------------------

/** One step with the sub-actions recorded under it, both already in the producer's order. */
export interface RunDetailStepGroup {
  readonly step: RunDetailStep
  readonly subActions: readonly RunDetailSubAction[]
}

/** One member of the run and everything the projection recorded beneath it. */
export interface RunDetailGroup {
  readonly member: RunDetailMember
  readonly steps: readonly RunDetailStepGroup[]
}

/** The composite key a step and its sub-actions are joined on — the handle plus the ordinal. */
function stepKey(testIndex: number, stepIndex: number): string {
  return `${String(testIndex)} ${String(stepIndex)}`
}

// One group per member, even one with no steps, so a suite never looks like it ran fewer tests.
export function groupRunDetail(projection: RunDetailProjection): RunDetailGroup[] {
  const subActionsByStep = new Map<string, RunDetailSubAction[]>()
  for (const sub of projection.subActions) {
    const key = stepKey(sub.testIndex, sub.stepIndex)
    const bucket = subActionsByStep.get(key)
    if (bucket === undefined) subActionsByStep.set(key, [sub])
    else bucket.push(sub)
  }

  const stepsByMember = new Map<number, RunDetailStep[]>()
  for (const step of projection.steps) {
    const bucket = stepsByMember.get(step.testIndex)
    if (bucket === undefined) stepsByMember.set(step.testIndex, [step])
    else bucket.push(step)
  }

  return [...projection.members]
    .sort((a, b) => a.testIndex - b.testIndex)
    .map((member) => ({
      member,
      steps: [...(stepsByMember.get(member.testIndex) ?? [])]
        .sort((a, b) => a.stepIndex - b.stepIndex)
        .map((step) => ({
          step,
          subActions: [...(subActionsByStep.get(stepKey(step.testIndex, step.stepIndex)) ?? [])].sort(
            (a, b) => a.subActionIndex - b.subActionIndex,
          ),
        })),
    }))
}

// --------------------------------- filter ---------------------------------

/** The default: every member, no narrowing. */
export const MEMBER_FILTER_ALL = 'all'

/** What the member filter can be — the default word, or one member's handle. */
export type MemberFilter = typeof MEMBER_FILTER_ALL | number

/** Narrow the grouped tree to one member, or hand it back whole. */
export function filterGroups(
  groups: readonly RunDetailGroup[],
  filter: MemberFilter,
): RunDetailGroup[] {
  if (filter === MEMBER_FILTER_ALL) return [...groups]
  return groups.filter((group) => group.member.testIndex === filter)
}

/**
 * Read the `member=<testIndex>` query param.
 *
 * IT NEVER THROWS AND IT NEVER GUESSES. A URL is attacker-adjacent and hand-editable; anything that
 * is not a non-negative integer answers {@link MEMBER_FILTER_ALL}, which lands the viewer on the
 * ordinary whole-run view. The failure mode of a wrong answer here is a page showing MORE than the
 * link asked for, never less.
 */
export function parseMemberFilter(raw: string | null | undefined): MemberFilter {
  if (raw === null || raw === undefined || raw === '') return MEMBER_FILTER_ALL
  if (!/^\d+$/.test(raw)) return MEMBER_FILTER_ALL
  const parsed = Number(raw)
  return Number.isSafeInteger(parsed) ? parsed : MEMBER_FILTER_ALL
}

// ------------------------------ member copy -------------------------------

// The producer's `failureSummary` renders beside this note and is never folded into it.
export function memberNote(
  _member: RunDetailMember,
  group: Pick<RunDetailGroup, 'steps'>,
): string | undefined {
  return group.steps.length === 0 ? DID_NOT_RUN_LABEL() : undefined
}

// With no recorded name the member is named by its position, never by an invented title.
export function memberDisplayName(member: Pick<RunDetailMember, 'testIndex' | 'name'>): string {
  return member.name ?? t('runDetail.member.fallbackName', { number: String(member.testIndex + 1) })
}

// `testIndex` is the handle, shown without `+ 1` so a copied number addresses the right member.
export function memberHandleLabel(testIndex: number): string {
  return `#${String(testIndex)}`
}

// `attempts` starts at 1, so re-runs are one less, and a first attempt says nothing.
export function reranLabel(attempts: number): string | undefined {
  return attempts > 1 ? t('runDetail.member.reran', { times: String(attempts - 1) }) : undefined
}

// -------------------------- token line and usage --------------------------

// Absent sums read as not measured; a measured zero reads `0 in · 0 out`.
export function tokenPairLine(tokens: RunTokenTotals): string {
  const { measuredSteps, promptTokens, completionTokens } = tokens
  if (measuredSteps === 0 || promptTokens === undefined || completionTokens === undefined) {
    return TOKENS_NOT_MEASURED_LABEL()
  }
  return t('runDetail.usage.tokenPair', {
    prompt: formatTokens(promptTokens),
    completion: formatTokens(completionTokens),
  })
}

// States the total and the pair, because the header's pair is what a reader checks here.
export function usageTotalsLine(tokens: RunTokenTotals): string {
  const { measuredSteps, promptTokens, completionTokens, totalTokens } = tokens
  if (
    measuredSteps === 0 ||
    totalTokens === undefined ||
    promptTokens === undefined ||
    completionTokens === undefined
  ) {
    return TOKENS_NOT_MEASURED_LABEL()
  }
  return t('runDetail.usage.totals', {
    total: formatNumber(totalTokens),
    prompt: formatNumber(promptTokens),
    completion: formatNumber(completionTokens),
  })
}

// A fully measured run renders nothing, so every card line is a reported fact.
export function usageCoverageLine(tokens: RunTokenTotals): string | undefined {
  const { measuredSteps, unmeasuredSteps } = tokens
  // With nothing measured there is no total to undercount; the totals line has said so.
  if (unmeasuredSteps === 0 || measuredSteps === 0) return undefined
  const allSteps = measuredSteps + unmeasuredSteps
  return t('runDetail.usage.coverage', { measured: String(measuredSteps), steps: String(allSteps) })
}

// Only provider `cachedInputTokens`, over `cachedInputMeasuredTokens` if it covers fewer steps.
export function cachedInputLine(tokens: RunTokenTotals): string | undefined {
  const { measuredSteps, cachedInputTokens, cachedMeasuredSteps, cachedInputMeasuredTokens } = tokens
  if (cachedInputTokens === undefined) return undefined
  const cached = formatNumber(cachedInputTokens)
  if (
    cachedMeasuredSteps === undefined ||
    cachedMeasuredSteps >= measuredSteps ||
    cachedInputMeasuredTokens === undefined
  ) {
    return t('runDetail.usage.cachedInput', { cached })
  }
  return t('runDetail.usage.cachedInputPartial', {
    cached,
    measuredTokens: formatNumber(cachedInputMeasuredTokens),
    cachedSteps: String(cachedMeasuredSteps),
    measuredSteps: String(measuredSteps),
  })
}

/** One line of the usage card's model section; the card renders every line as a plain text node. */
export interface UsageLine {
  readonly kind: 'model' | 'models' | 'responded' | 'heading'
  readonly text: string
}

/** One identity, as the card names it — the parenthesis only when a provider was recorded. */
function identityText(entry: { provider?: string; modelId: string }): string {
  return entry.provider === undefined ? entry.modelId : `${entry.modelId} (${entry.provider})`
}

// Only the durable summary names models; the row's legacy fields describe the host, not the run.
export function usageModelLines(models: RunModelSummary | undefined): readonly UsageLine[] {
  if (models === undefined) return []
  const { declared, responding } = models
  if (declared === undefined && responding === undefined) return []

  const declaredIds = new Set((declared ?? []).map((entry) => entry.modelId))
  const differing = (responding ?? []).filter((entry) => !declaredIds.has(entry.modelId))

  if (declared?.length === 1 && (responding === undefined || responding.length <= 1)) {
    return [
      { kind: 'model', text: t('runDetail.usage.model', { identity: identityText(declared[0]) }) },
      ...differing.map(
        (entry): UsageLine => ({
          kind: 'responded',
          text: t('runDetail.usage.respondedAs', { model: entry.modelId }),
          }),
      ),
    ]
  }

  return [
    { kind: 'heading', text: MODELS_HEADING() },
    ...(declared ?? []).map(
      (entry): UsageLine => ({
        kind: 'models',
        text: t('runDetail.usage.modelSteps', {
          identity: identityText(entry),
          count: entry.stepCount,
        }),
      }),
    ),
    ...differing.map(
      (entry): UsageLine => ({
        kind: 'responded',
        text: t('runDetail.usage.respondedSteps', { model: entry.modelId, count: entry.stepCount }),
      }),
    ),
  ]
}

// ----------------------------- screen context -----------------------------

/** How many characters of a screen-state hash a person can usefully compare by eye. */
const SCREEN_STATE_CHIP_LENGTH = 12

// The bus carries only `screenStateHash`, so a short chip of it is what a reader can compare.
export function screenStateChip(hash: string): string {
  return hash.slice(0, SCREEN_STATE_CHIP_LENGTH)
}

// Reads the hash pair: a missing or identical post-state is a screen that did not change.
export function screenStateChangeLabel(subAction: RunDetailSubAction): string {
  const after = subAction.screenStateHashAfter
  if (after === undefined || after === subAction.screenStateHash) {
    return SCREEN_STATE_UNCHANGED_LABEL()
  }
  return SCREEN_STATE_CHANGED_LABEL()
}

// ------------------------------- page chrome ------------------------------

// A single-member run has nothing to group or filter, so it draws no member chrome.
export function showMemberChrome(projection: Pick<RunDetailProjection, 'members'>): boolean {
  return projection.members.length > 1
}

// ------------------------- the decision screenshot -------------------------

// `artifactRefs` is an open list, so the overview selects by this prefix, never the first entry.
export const DECISION_SCREENSHOT_REF_PREFIX = 'decision-screenshot:'

// One shot per turn, the screen the planner decided on; returns the detail ref so `present` stays.
export function decisionScreenshotRef(
  subAction: Pick<RunDetailSubAction, 'artifactRefs'>,
): RunDetailArtifactRef | undefined {
  return subAction.artifactRefs?.find((ref) => ref.id.startsWith(DECISION_SCREENSHOT_REF_PREFIX))
}

// A step with no usage is one unmeasured step with no sums; a reported zero is a measured one.
export function stepTokenTotals(step: Pick<RunDetailStep, 'tokenUsage'>): RunTokenTotals {
  const usage = step.tokenUsage
  if (usage === undefined) return { measuredSteps: 0, unmeasuredSteps: 1 }
  return {
    measuredSteps: 1,
    unmeasuredSteps: 0,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
  }
}
