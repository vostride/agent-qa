// THE RUN-DETAIL PROJECTION — the whole distance between what the op returned and what a person
// reads.
//
// Phase 405-06 · DETL-01 / DETL-02 / DETL-03, D-06 / D-10 / D-15 / D-16 / D-17 / D-18, RESEARCH D2.
//
// EVERY PUBLISHED SENTENCE IS AN EXPORTED CONSTANT (403-05 D-5, the `post-processing-view.ts`
// idiom). The tree (405-08) and the overview (405-11) assert their copy BY CONSTANT rather than by
// string, so a sentence moves in one place and its cells move with it; prose inlined in a component
// is prose that drifts from prose inlined in a test, and both of them stay green while the page
// says two different things.
//
// IT IS PURE AND TOTAL. No React, no fetch, no clock. The only input any function here takes is the
// op's own `RunDetailProjection` (or a row out of it), so nothing on this page can render a state
// the read did not report — the 399.1 render contract, restated for run detail.
//
// ABSENT IS NOT ZERO, AND IT IS THE LOAD-BEARING RULE OF THIS FILE. `RunTokenTotals` omits its three
// sums entirely when nothing was measured (D-06), because "no step reported usage" and "every step
// reported zero" are different facts about a run. No sum below is ever defaulted to zero when it is
// absent: a default would convert "nobody measured this" into "this was free" at the exact layer a
// person reads, which is the one place that lie is unrecoverable. 425-05 greps this file for the
// nullish-default spelling and requires ZERO matches, so the rule is stated without writing it.

import type {
  RunDetailArtifactRef,
  RunDetailMember,
  RunDetailProjection,
  RunDetailStep,
  RunDetailSubAction,
  RunModelSummary,
  RunTokenTotals,
} from '@vostride/agent-qa-schema'

import { formatTokens } from './format'
import { DID_NOT_RUN_NOTE } from './run-stream-reducer'

// ---------------------------------- copy ----------------------------------

/**
 * What a member with no steps renders as (D-16 / D-18).
 *
 * The VALUE is the live reducer's {@link DID_NOT_RUN_NOTE}, not a second spelling of it: the live
 * page and the durable page describe the same member, and two constants that happen to agree today
 * are two constants that can disagree tomorrow.
 */
export const DID_NOT_RUN_LABEL: string = DID_NOT_RUN_NOTE

/** What the token line says when the run carries no measurement at all (D-06). */
export const TOKENS_NOT_MEASURED_LABEL = 'tokens not measured'

/** The usage card's heading over a run that spoke to more than one model identity (D-23). */
export const MODELS_HEADING = 'Models'

/**
 * The accessible name of the header's token line, which is a TRIGGER and not a destination (D-21).
 *
 * The line is a focusable `span`, never a button: a button promises somewhere to go and the card
 * behind this one is the whole of what there is to see. The name says what focusing it opens,
 * because the visible text — `103.1K in · 456 out` — says what the numbers are and nothing about
 * there being more.
 */
export const TOKEN_USAGE_TRIGGER_LABEL = 'Token usage — details'

/**
 * The honest state for a ref whose blob is gone or was never written (406-05 · D-17 / D-18).
 *
 * THE THIRD ABSENCE VOCABULARY, and the reason it has its own word. A masked chip says a value was
 * redacted ON PURPOSE and the page could have shown it under another config; the read-unavailable
 * sentence says THE READ ITSELF FAILED and the fact behind it may be perfectly intact; this one
 * says THE BYTES ARE GONE and no retry, config or reload will bring them back. Three different
 * things a reader would do next, so three different sentences — collapsing any pair would tell
 * someone to go fix something that is not broken, or to give up on something that is.
 *
 * Never a broken image element, never a silently dropped row: an absent blob is a STATE.
 */
export const EVIDENCE_INCOMPLETE_LABEL = 'evidence incomplete'

/**
 * 405's name for {@link EVIDENCE_INCOMPLETE_LABEL}, kept as an alias for its importers.
 *
 * The 405 doc above this constant promised exactly this upgrade, and 406 spends it: the ratified
 * word covers every ref site — the overview's screenshot pane and the failure view's cited links —
 * so the screenshot-shaped name is no longer the whole story. It is an ALIAS rather than a second
 * string, because two constants that happen to agree today are two constants that can disagree
 * tomorrow. A later phase retires it deliberately.
 */
export const SCREENSHOT_UNAVAILABLE_LABEL: string = EVIDENCE_INCOMPLETE_LABEL

/**
 * What the tree says when the durable read itself FAILED (405-08 · D-03).
 *
 * Distinct from an empty projection on purpose. A run that recorded no steps and a run whose
 * detail could not be read are different facts, and rendering both as an empty tree would make a
 * server fault indistinguishable from a quiet test — the exact confusion D-18 removes at the
 * member level, applied one level up.
 */
export const RUN_DETAIL_UNAVAILABLE_LABEL = 'Could not load this run\u2019s steps.'

/** The screen-context affordance when the post-state matched the pre-state (RESEARCH D2). */
export const SCREEN_STATE_UNCHANGED_LABEL = 'state unchanged'

/** The screen-context affordance when a distinct post-state was recorded (RESEARCH D2). */
export const SCREEN_STATE_CHANGED_LABEL = 'state changed'

// -------------------------------- grouping --------------------------------

/** One step with the sub-actions recorded under it, both already in the producer's order. */
export interface RunDetailStepGroup {
  readonly step: RunDetailStep
  readonly subActions: readonly RunDetailSubAction[]
}

/** One member of the run and everything the projection recorded beneath it (D-16). */
export interface RunDetailGroup {
  readonly member: RunDetailMember
  readonly steps: readonly RunDetailStepGroup[]
}

/** The composite key a step and its sub-actions are joined on — the handle plus the ordinal. */
function stepKey(testIndex: number, stepIndex: number): string {
  return `${String(testIndex)} ${String(stepIndex)}`
}

/**
 * Fold the three flat row arrays into the tree the page draws (D-16 / D-18).
 *
 * ONE GROUP PER MEMBER, always — including a member with no steps at all, whose stream began with a
 * terminal event (D-18). Omitting it would render a suite as though it had fewer tests than it ran,
 * and blank rows under a green tick read as "it passed everything", which is a lie about a member
 * that never started.
 *
 * A step whose `testIndex` names no member row is not renderable under a member header and is not
 * given an invented one. That cannot occur on the shipped producer — the subscriber writes a member
 * row for every handle, including a thin one (405-01) — so this is a totality property of the fold
 * rather than a case the page has to explain.
 */
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

/** The default: every member, no narrowing (D-16). */
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

/**
 * The note that goes under a member header, or nothing (D-18).
 *
 * Only ONE note exists: a member that produced no step did not run. The member's own
 * `failureSummary` ("skipped by fail-fast", "budget exhausted") is the PRODUCER's sentence and is
 * rendered verbatim beside this one — it is never folded in here, because a note this file wrote
 * and a note the runner wrote are different claims and a reader is entitled to tell them apart.
 */
export function memberNote(
  _member: RunDetailMember,
  group: Pick<RunDetailGroup, 'steps'>,
): string | undefined {
  return group.steps.length === 0 ? DID_NOT_RUN_LABEL : undefined
}

/**
 * What a member header calls the member (D-16).
 *
 * A member row carries a `name` only when the producer knew one; a thin member whose stream began
 * with a terminal event may carry nothing but its handle (D-18). The fallback names the member by
 * its ORDINAL POSITION rather than by an invented identity — "Test 2" is a statement about where
 * this member sits in the run, which is true, where a synthesised title would be a claim about
 * what the test was, which nobody recorded.
 */
export function memberDisplayName(member: Pick<RunDetailMember, 'testIndex' | 'name'>): string {
  return member.name ?? `Test ${String(member.testIndex + 1)}`
}

/**
 * The member's handle, as a person reads it (402 D-10, RESEARCH D4).
 *
 * `testIndex` IS the handle — `handleId(runId, testIndex)` is how the product spells run-scoped
 * member identity — so the header shows the index itself rather than a second numbering. It is
 * NOT `+ 1`: a reader who copies this number into a `?handle=` observation must get the handle the
 * product answers to, and a display ordinal that quietly differed from the addressable one would
 * be the kind of off-by-one nobody can debug from the screen.
 */
export function memberHandleLabel(testIndex: number): string {
  return `#${String(testIndex)}`
}

/**
 * What the member header says about a re-run (D-17).
 *
 * `attempts` is an ORDINAL that starts at 1; the phrase counts RE-RUNS, so it is one less. A member
 * on its first attempt says nothing at all — "re-ran after failure x0" would be a sentence about an
 * event that did not happen.
 */
export function reranLabel(attempts: number): string | undefined {
  return attempts > 1 ? `re-ran after failure ×${String(attempts - 1)}` : undefined
}

// -------------------------- token line and usage --------------------------

/**
 * Full digits, grouped — the CARD's number format (425-05 · D-24).
 *
 * The header stays compact (`103.1K`) because it is a glance and a glance wants a shape; the card
 * is where someone checks a number against an invoice, and `103.1K` cannot be checked against
 * anything. One formatter, module-level, because `Intl.NumberFormat` construction is the expensive
 * half and every line below wants the same grouping.
 */
const fullTokens = new Intl.NumberFormat('en-US')

/**
 * What the header says a measured run spent, as a labelled pair (425-05 · D-21).
 *
 * THE PAIR IS AS CAPABLE OF LYING AS THE SUM IT REPLACES, so it is guarded the same way: absent
 * sums select {@link TOKENS_NOT_MEASURED_LABEL}, and a genuinely measured zero reads `0 in · 0 out`
 * — a measurement, not an absence. No absent sum is defaulted to zero here, and none can be.
 *
 * COVERAGE IS NOT IN THIS SENTENCE (D-22). "2 of 3 steps" is a caveat about the number, and the
 * header is a glance; the caveat lives in the card, where a reader who wants it is already looking.
 */
export function tokenPairLine(tokens: RunTokenTotals): string {
  const { measuredSteps, promptTokens, completionTokens } = tokens
  if (measuredSteps === 0 || promptTokens === undefined || completionTokens === undefined) {
    return TOKENS_NOT_MEASURED_LABEL
  }
  return `${formatTokens(promptTokens)} in · ${formatTokens(completionTokens)} out`
}

/**
 * The card's first line: the same spend, spelled out (425-05 · D-24).
 *
 * It states the total AND the pair rather than only the total, because the header's compact pair
 * is what a reader is checking when they open the card — a card that answered a different question
 * would send them somewhere else to add two numbers up.
 */
export function usageTotalsLine(tokens: RunTokenTotals): string {
  const { measuredSteps, promptTokens, completionTokens, totalTokens } = tokens
  if (
    measuredSteps === 0 ||
    totalTokens === undefined ||
    promptTokens === undefined ||
    completionTokens === undefined
  ) {
    return TOKENS_NOT_MEASURED_LABEL
  }
  return `${fullTokens.format(totalTokens)} total · ${fullTokens.format(promptTokens)} in · ${fullTokens.format(completionTokens)} out`
}

/**
 * How much of the run the totals actually cover — only when that is less than all of it (D-22).
 *
 * A fully measured run renders NOTHING: "3 of 3 steps" is a sentence that adds no fact and costs a
 * line in a card whose whole discipline is that every line is a fact someone reported. The owner
 * declined this clause in the header; it is the card's, or it is nowhere.
 */
export function usageCoverageLine(tokens: RunTokenTotals): string | undefined {
  const { measuredSteps, unmeasuredSteps } = tokens
  // Nothing measured is not an undercount of a total: there is no total. The totals line has
  // already said nobody measured this run, and a second sentence claiming those totals exist and
  // are low is the absent-vs-zero collapse this file's header rule refuses (425-14 · WR-02).
  if (unmeasuredSteps === 0 || measuredSteps === 0) return undefined
  const allSteps = measuredSteps + unmeasuredSteps
  return `measured ${String(measuredSteps)} of ${String(allSteps)} steps — totals are an undercount`
}

/**
 * The provider's cached-input report, and NOTHING ELSE (425-05 · D-24, RESEARCH reconciliation 4).
 *
 * `cachedInputTokens` is the only input. A step's execution cache verdict — hit, miss, bypass or
 * disabled — is a fact about THIS product replaying a step without a model call at all, and
 * rendering it here would attribute a discount to the provider that the provider never reported, on
 * the line a person reads as a bill. The absence of the field is the absence of the claim, and this file is grepped
 * for that step field by name with ZERO matches required.
 *
 * THE NARROWER CLAUSE NAMES ITS OWN DENOMINATOR. When the cache report covers fewer steps than were
 * measured, `cachedInputTokens` is a fraction of `cachedInputMeasuredTokens` — the input over
 * precisely those steps — and not of the run's whole input. Printing it against the run total would
 * be a ratio nobody computed.
 */
export function cachedInputLine(tokens: RunTokenTotals): string | undefined {
  const { measuredSteps, cachedInputTokens, cachedMeasuredSteps, cachedInputMeasuredTokens } = tokens
  if (cachedInputTokens === undefined) return undefined
  const cached = fullTokens.format(cachedInputTokens)
  if (
    cachedMeasuredSteps === undefined ||
    cachedMeasuredSteps >= measuredSteps ||
    cachedInputMeasuredTokens === undefined
  ) {
    return `cached input ${cached} (provider-reported)`
  }
  return `cached input ${cached} of ${fullTokens.format(cachedInputMeasuredTokens)} (provider-reported) over ${String(cachedMeasuredSteps)} of ${String(measuredSteps)} measured steps`
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

/**
 * Who answered this run, from the durable summary and from nowhere else (425-05 · D-23).
 *
 * NO SUMMARY IS NO LINE. A pre-423 run recorded no model identity, and the run row's legacy
 * `modelName` / `llmProvider` are NOT a fallback: they name what the host was configured with at
 * some point, not what answered this run, and a page that quietly substituted one for the other
 * would be making a claim about a run out of a fact about a machine.
 *
 * ZERO, ONE, MANY. One declared identity is one `Model` line; more than one — or a responding id
 * the declared list does not contain — turns the section into a heading with a line per identity,
 * because a mixed run's spend cannot be attributed to a single name. A responding id is said ONLY
 * when it differs from what was asked for: "responded as" is a correction, and a correction that
 * repeats the original is noise.
 */
export function usageModelLines(models: RunModelSummary | undefined): readonly UsageLine[] {
  if (models === undefined) return []
  const { declared, responding } = models
  if (declared === undefined && responding === undefined) return []

  const declaredIds = new Set((declared ?? []).map((entry) => entry.modelId))
  const differing = (responding ?? []).filter((entry) => !declaredIds.has(entry.modelId))

  if (declared?.length === 1 && (responding === undefined || responding.length <= 1)) {
    return [
      { kind: 'model', text: `Model ${identityText(declared[0])}` },
      ...differing.map(
        (entry): UsageLine => ({
          kind: 'responded',
          text: `responded as ${entry.modelId}`,
          }),
      ),
    ]
  }

  return [
    { kind: 'heading', text: MODELS_HEADING },
    ...(declared ?? []).map(
      (entry): UsageLine => ({
        kind: 'models',
        text: `${identityText(entry)} × ${String(entry.stepCount)} steps`,
      }),
    ),
    ...differing.map(
      (entry): UsageLine => ({
        kind: 'responded',
        text: `responded as ${entry.modelId} × ${String(entry.stepCount)} steps`,
      }),
    ),
  ]
}

// ----------------------------- screen context -----------------------------

/** How many characters of a screen-state hash a person can usefully compare by eye. */
const SCREEN_STATE_CHIP_LENGTH = 12

/**
 * The screen-state hash, shortened to a chip (RESEARCH D2).
 *
 * The bus carries no screen-context TEXT — only `screenStateHash`, a sha256 over the canonical
 * `ScreenState`. So "screen context" on this page honestly means the hash pair, and a short id is
 * the only form of it a reader can hold in their head long enough to compare two rows.
 */
export function screenStateChip(hash: string): string {
  return hash.slice(0, SCREEN_STATE_CHIP_LENGTH)
}

/**
 * Whether this sub-action moved the screen (RESEARCH D2).
 *
 * Reads the PAIR, not the presence of the field: `screenStateHashAfter` is only recorded when a
 * post-state was captured at all, and a recorded post-state identical to the pre-state is a screen
 * that did not change — the same answer as never having looked, and the honest one either way.
 */
export function screenStateChangeLabel(subAction: RunDetailSubAction): string {
  const after = subAction.screenStateHashAfter
  if (after === undefined || after === subAction.screenStateHash) return SCREEN_STATE_UNCHANGED_LABEL
  return SCREEN_STATE_CHANGED_LABEL
}

// ------------------------------- page chrome ------------------------------

/**
 * Whether the page draws member grouping chrome at all (D-16).
 *
 * A single-member run has nothing to group and nothing to filter; a header and a picker over one
 * item is chrome that asks the reader to make a choice they do not have.
 */
export function showMemberChrome(projection: Pick<RunDetailProjection, 'members'>): boolean {
  return projection.members.length > 1
}

// ------------------------- the decision screenshot -------------------------

/**
 * The id prefix the evidence store mints a decision screenshot under (405-11 · D-14 / D-15).
 *
 * A sub-action's `artifactRefs` is an open list — the producer is free to attach other evidence to
 * the same turn — so the overview SELECTS by this prefix rather than taking the first entry. Taking
 * whatever happened to be first would put an arbitrary blob into an `img` the moment a second
 * channel starts recording, which is a wrong picture rather than a missing one.
 */
export const DECISION_SCREENSHOT_REF_PREFIX = 'decision-screenshot:'

/**
 * The decision screenshot recorded for this sub-action, or nothing.
 *
 * ONE SHOT PER TURN, not a before/after pair. The bus records the screen the planner LOOKED AT when
 * it decided; there is no post-action capture on the same sub-action, so there is no second side to
 * select. Deriving an "after" from the next sub-action's shot would be a join nobody recorded — the
 * screen may have moved for reasons this action did not cause, and a caption claiming otherwise is
 * a lie a reader cannot check.
 *
 * It answers the DETAIL-side ref (406-05 · D-17), not the runner's narrower mint, because the read
 * annotated presence onto these rows and the pane's whole decision turns on that field. Returning
 * the producer's shape would hide `present` from the one caller that exists to read it.
 */
export function decisionScreenshotRef(
  subAction: Pick<RunDetailSubAction, 'artifactRefs'>,
): RunDetailArtifactRef | undefined {
  return subAction.artifactRefs?.find((ref) => ref.id.startsWith(DECISION_SCREENSHOT_REF_PREFIX))
}

/**
 * One step's spend, in the shape {@link tokenPairLine} reads (D-06).
 *
 * ABSENT STAYS ABSENT. A step that reported no usage becomes one UNMEASURED step and carries no
 * sums at all, so the line says "tokens not measured" rather than `0 tokens across 0 of 1 steps`.
 * A step that genuinely reported zero becomes one MEASURED step whose sums are zero, and reads as
 * the measurement it is. Nothing on this path defaults an absent sum to zero, and nothing can be
 * added that does without reddening a cell — which is the entire reason the run-level totals were
 * given this shape upstream.
 */
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
