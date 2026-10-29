// The runner's judge over the verifier's per-condition output.
// Pure: the model judges each condition, the runner checks it and computes the pass. A quote
// matches when it occurs in the clear record, or masked in the masked record (the model sees
// placeholders). Masking is injected; nothing here reads a model or a platform.
//
// Checks, in order: each condition's quote must be a run of the step's own words, and every step
// word outside STOP_WORDS must lie in some quote (else one 'not-covered' condition names the rest);
// a met condition needs a citation the runner finds; a met condition whose own reasoning, or the
// planner's completion reasoning, admits the action did not happen is not met.
//
// The phrase check is English-only. It refuses a met verdict when the reasoning holds a negated
// participle whose stem is a word of the condition's quote ("has not (yet) (been) saved",
// "not yet submitted", "did not send", "never paid", "failed to export"), unless the quote itself
// is negated on that word, or holds "nothing happened", "nothing changed", "no effect" or
// "did nothing" when the quote carries one of EFFECT_VERBS. A negation about another object with
// the same verb ("the old value was not saved" on "Save the new value") is refused: the safe
// direction. Nothing excuses an admission, whatever the citations show: a proven
// effect described as an unchanged page is refused, a visible false fail accepted by the owner.
// An admission in another language is not caught.

import type {
  CitationSource,
  ConditionCitation,
  ConditionEnding,
  ConditionGuard,
  ConditionRecord,
  ConditionVerdictsEvidence,
  ElementInfo,
  OpenDialogAccount,
  Platform,
} from '@vostride/agent-qa-schema'
import {
  applyDialogGuard,
  applyFileGuard,
  applyLimitGuard,
  applyNarrowedGuard,
  applyPersistenceGuard,
  applyVisualGuard,
  openDialogsOn,
  type CheckedCitation,
  type SavedFile,
} from './condition-guards.js'
import type { VerifierStepRecord } from './step-record.js'
import type { ConditionJudgment, VerificationResult } from './types.js'

/** The rendered parts of the verification request a citation can point at. */
export type CitationSources = Record<Exclude<CitationSource, 'screenshot'>, string>

export interface JudgeConditionsInput {
  stepText: string
  output: VerificationResult
  sources: CitationSources
  mask: (value: string) => string
  imageAttached: boolean
  ending: ConditionEnding
  /** The planner's completion reasoning, read only by the runner (never sent to the verifier). */
  plannerReasoning?: string
  /** What the runner's own checks read. Absent: nothing to read. */
  guards?: ConditionGuardFacts
}

export interface ConditionGuardFacts {
  finalElements: readonly ElementInfo[]
  platform: Platform
  record?: Pick<VerifierStepRecord, 'actions' | 'reads'>
  imageAttached: boolean
  /** this step's completed downloads, then carried ones, most recent first. */
  files?: readonly SavedFile[]
}

export interface ConditionJudgeResult {
  evidence: ConditionVerdictsEvidence
  pass: boolean
  reason: string
}

const QUOTE_MAX = 300
const REASON_MAX = 200
const RECORDED_CITATIONS_MAX = 10
const MIN_QUOTE_CHARACTERS = 3
const TEXT_SOURCES: readonly (keyof CitationSources)[] = [
  'start-screen',
  'final-screen',
  'action',
  'read',
  'carried',
]

const GUARD_REASONS: Partial<Record<ConditionGuard, string>> = {
  'not-covered': 'the verifier judged no condition of the step',
  'citation-missing': 'no cited evidence was found in what the verifier was given',
  'quote-not-in-step': "the quote is not the step's own words",
}
const UNCOVERED_REASON = 'No condition covers these words of the step'

/** Step words that never need a condition of their own. */
export const STOP_WORDS: ReadonlySet<string> = new Set(
  (
    'a an the and or then to of on in at by for from with into onto as is are be been it its ' +
    'this that there which please verify check confirm ensure make sure see'
  ).split(' '),
)

/** Verbs whose quote makes "nothing happened" and its kin an admission. */
export const EFFECT_VERBS: readonly string[] = (
  'submit save send pay delete export download create add place apply confirm upload copy ' +
  'remove update buy publish post archive order book change set rename enable disable toggle turn'
).split(' ')

const IRREGULAR_STEMS: Readonly<Record<string, string>> = {
  sent: 'send',
  paid: 'pay',
  bought: 'buy',
  made: 'make',
  done: 'do',
  put: 'put',
  set: 'set',
  kept: 'keep',
}

const PLACEHOLDER_TOKEN = String.raw`\[secret:\w+\]|\{\{secret:\w+\}\}`
const TOKEN_PATTERN = new RegExp(`${PLACEHOLDER_TOKEN}|[\\p{L}\\p{N}]+`, 'gu')
const NEGATED_PARTICIPLE =
  /\b(?:has|have|had|is|are|was|were)\s*(?:not|n['’]t)\s+(?:yet\s+)?(?:been\s+)?([a-z]+)\b|\bnot\s+yet\s+(?:been\s+)?([a-z]+)\b|\b(?:did|does)\s*(?:not|n['’]t)\s+([a-z]+)\b|\bnever\s+([a-z]+)\b|\bfailed\s+to\s+([a-z]+)\b/gi
const NOTHING_HAPPENED = /\bnothing\s+(?:happened|changed)\b|\bno\s+effect\b|\bdid\s+nothing\b/i

function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function bound(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

function citable(quote: string): boolean {
  return quote.replace(/\s/g, '').length >= MIN_QUOTE_CHARACTERS
}

interface Haystack {
  raw: string
  masked: string
}

function checkCitation(
  citation: { source: CitationSource; quote: string },
  haystacks: Record<keyof CitationSources, Haystack>,
  mask: (value: string) => string,
  imageAttached: boolean,
): ConditionCitation {
  const raw = collapse(citation.quote ?? '')
  const quote = collapse(mask(raw))
  const recorded = bound(quote, QUOTE_MAX)
  if (!citable(raw) || !citable(quote)) {
    return { source: citation.source, quote: recorded, found: false }
  }
  if (citation.source === 'screenshot' && imageAttached) {
    return { source: 'screenshot', quote: recorded, found: 'unchecked' }
  }
  const order =
    citation.source === 'screenshot'
      ? TEXT_SOURCES
      : [citation.source, ...TEXT_SOURCES.filter((source) => source !== citation.source)]
  for (const source of order) {
    const haystack = haystacks[source]
    if (haystack.masked.includes(quote) || haystack.raw.includes(raw)) {
      return { source, quote: recorded, found: true }
    }
  }
  return { source: citation.source, quote: recorded, found: false }
}

function guarded(
  quote: string,
  guard: ConditionGuard,
  reason: string,
  citations: ConditionCitation[] = [],
): ConditionRecord {
  return { quote, verdict: 'unverified', guard, reason: bound(reason, REASON_MAX), citations }
}

/** A word as it appeared and as it is compared. */
export interface StepToken {
  text: string
  key: string
}

/**
 * Runs of Unicode letters or digits after NFKC, compared lowercased; a secret placeholder
 * (`[secret:name]`, `{{secret:name}}`) is one token.
 */
export function tokenize(value: string): StepToken[] {
  const tokens: StepToken[] = []
  for (const match of value.normalize('NFKC').matchAll(TOKEN_PATTERN)) {
    tokens.push({ text: match[0], key: match[0].toLowerCase() })
  }
  return tokens
}

export interface ConditionCoverage {
  /** Per quote: whether its words occur, in order and adjacent, in the step. */
  inStep: boolean[]
  /** The step words outside STOP_WORDS that no in-step quote covers, in step order. */
  uncovered: StepToken[]
}

/** Every occurrence of every in-step quote covers its span of step words. */
export function coverConditions(
  stepTokens: readonly StepToken[],
  quotes: readonly (readonly StepToken[])[],
): ConditionCoverage {
  const covered = new Array<boolean>(stepTokens.length).fill(false)
  const inStep = quotes.map((quote) => {
    if (quote.length === 0) return stepTokens.length === 0
    let found = false
    for (let start = 0; start + quote.length <= stepTokens.length; start++) {
      if (quote.every((token, i) => stepTokens[start + i]?.key === token.key)) {
        found = true
        for (let i = 0; i < quote.length; i++) covered[start + i] = true
      }
    }
    return found
  })
  const uncovered = stepTokens.filter((token, i) => !covered[i] && !STOP_WORDS.has(token.key))
  return { inStep, uncovered }
}

/** A crude English stem: submitted, submit; saved, save; copied, copy; sent, send. */
export function stemWord(word: string): string {
  let stem = word.toLowerCase()
  stem = IRREGULAR_STEMS[stem] ?? stem
  if (stem.endsWith('ied') && stem.length > 4) {
    stem = `${stem.slice(0, -3)}y`
  } else {
    for (const suffix of ['ing', 'ed', 'es', 's']) {
      if (stem.endsWith(suffix) && stem.length - suffix.length >= 2) {
        stem = stem.slice(0, -suffix.length)
        break
      }
    }
  }
  if (/([b-df-hj-np-tv-z])\1$/.test(stem)) stem = stem.slice(0, -1)
  if (stem.endsWith('e') && stem.length > 2) stem = stem.slice(0, -1)
  return stem
}

function negatedStems(text: string): { phrase: string; stem: string }[] {
  const found: { phrase: string; stem: string }[] = []
  for (const match of text.matchAll(NEGATED_PARTICIPLE)) {
    const word = match.slice(1).find((group) => group !== undefined)
    if (word !== undefined) found.push({ phrase: match[0], stem: stemWord(word) })
  }
  return found
}

const EFFECT_STEMS = new Set(EFFECT_VERBS.map(stemWord))

/**
 * The phrase in `reasoning` that admits the quote's action did not happen, or undefined. English
 * only; see the module header for the patterns and their limits.
 */
export function admitsNotDone(reasoning: string, quote: string): string | undefined {
  const quoteStems = new Set(
    tokenize(quote)
      .map((token) => token.key)
      .filter((key) => !STOP_WORDS.has(key) || EFFECT_STEMS.has(stemWord(key)))
      .map(stemWord),
  )
  for (const negated of negatedStems(quote)) quoteStems.delete(negated.stem)
  for (const negated of negatedStems(reasoning)) {
    if (quoteStems.has(negated.stem)) return collapse(negated.phrase)
  }
  const nothing = NOTHING_HAPPENED.exec(reasoning)
  if (nothing !== null && [...quoteStems].some((stem) => EFFECT_STEMS.has(stem))) {
    return collapse(nothing[0])
  }
  return undefined
}

interface JudgeContext {
  input: JudgeConditionsInput
  haystacks: Record<keyof CitationSources, Haystack>
  plannerReasoning: string
  guards: ConditionGuardFacts
}

function judgeOne(
  judgment: ConditionJudgment,
  inStep: boolean,
  context: JudgeContext,
): ConditionRecord {
  const { input, haystacks } = context
  const maskedQuote = collapse(input.mask(judgment.quote ?? ''))
  const quote = bound(maskedQuote, QUOTE_MAX)
  const reasoning = collapse(input.mask(judgment.reasoning ?? ''))
  const reason = bound(reasoning, REASON_MAX)
  const checked = (Array.isArray(judgment.citations) ? judgment.citations : []).map((citation) =>
    checkCitation(citation, haystacks, input.mask, input.imageAttached),
  )
  const citations = checked.slice(0, RECORDED_CITATIONS_MAX)
  const needs =
    judgment.needs !== undefined && judgment.needs !== 'none' ? { needs: judgment.needs } : {}
  const changed = (verdict: ConditionRecord['verdict'], guard: ConditionGuard, why: string) => ({
    quote,
    verdict,
    ...(judgment.verdict !== verdict ? { judged: judgment.verdict } : {}),
    guard,
    ...needs,
    reason: bound(why, REASON_MAX),
    citations,
  })
  if (!inStep) {
    return changed('unverified', 'quote-not-in-step', GUARD_REASONS['quote-not-in-step']!)
  }
  if (judgment.verdict !== 'met') {
    return { quote, verdict: judgment.verdict, ...needs, reason, citations }
  }
  if (!checked.some((citation) => citation.found !== false)) {
    return changed('unverified', 'citation-missing', GUARD_REASONS['citation-missing']!)
  }
  for (const source of [reasoning, context.plannerReasoning]) {
    const phrase = source === '' ? undefined : admitsNotDone(source, maskedQuote)
    if (phrase !== undefined) {
      return changed('not-met', 'admits-not-done', `The reasoning says "${phrase}"`)
    }
  }
  const met: ConditionRecord = { quote, verdict: 'met', ...needs, reason, citations }
  const cited: CheckedCitation[] = checked.map((citation, i) => ({
    source: citation.source,
    quote: judgment.citations[i]?.quote ?? '',
    found: citation.found,
  }))
  const { finalElements, record, imageAttached, files } = context.guards
  let guardedRecord = applyLimitGuard(met, judgment, finalElements, input.mask)
  guardedRecord = applyNarrowedGuard(guardedRecord, cited, record, input.mask)
  guardedRecord = applyPersistenceGuard(guardedRecord, judgment, cited, record)
  guardedRecord = applyVisualGuard(
    guardedRecord,
    judgment,
    cited,
    record,
    imageAttached,
    input.mask,
  )
  return applyFileGuard(guardedRecord, judgment, files, input.mask)
}

/**
 * Judge the verifier's output: a verifier error or an empty list is one unverified condition; a
 * quote that is not the step's own words is unverified; step words no quote covers become one
 * unverified condition; a met condition needs a citation the runner finds (or a screenshot
 * citation when an image was attached) and reasoning that does not admit the action did not
 * happen; the runner's own checks (condition-guards.ts) then only lower a met verdict. The step
 * passes only when there is a condition, every verdict is met and every open dialog is unrelated
 * or the state the step asked to open or see (requested).
 */
export function judgeConditions(input: JudgeConditionsInput): ConditionJudgeResult {
  const maskedStep = collapse(input.mask(input.stepText))
  const stepQuote = bound(maskedStep, QUOTE_MAX)
  const output = input.output
  let conditions: ConditionRecord[]
  if (output.verifierError !== undefined) {
    const error = collapse(input.mask(output.verifierError))
    const reason = `the verifier could not judge the step: ${error}`
    conditions = [guarded(stepQuote, 'verifier-error', reason)]
  } else {
    const haystacks = Object.fromEntries(
      TEXT_SOURCES.map((source) => {
        const raw = collapse(input.sources[source] ?? '')
        return [source, { raw, masked: collapse(input.mask(raw)) }]
      }),
    ) as Record<keyof CitationSources, Haystack>
    const judgments = Array.isArray(output.conditions) ? output.conditions : []
    const stepTokens = tokenize(maskedStep)
    const coverage = coverConditions(
      stepTokens,
      judgments.map((judgment) => tokenize(input.mask(judgment.quote ?? ''))),
    )
    const plannerReasoning = collapse(input.mask(input.plannerReasoning ?? ''))
    const context: JudgeContext = { input, haystacks, plannerReasoning, guards: guardFacts(input) }
    conditions = judgments.map((judgment, i) =>
      judgeOne(judgment, coverage.inStep[i] ?? false, context),
    )
    if (conditions.length === 0) {
      conditions = [guarded(stepQuote, 'not-covered', GUARD_REASONS['not-covered']!)]
    } else if (coverage.uncovered.length > 0) {
      const words = coverage.uncovered.map((token) => token.text).join(' ')
      conditions.push(guarded(bound(words, QUOTE_MAX), 'not-covered', UNCOVERED_REASON))
    }
  }
  const facts = guardFacts(input)
  const openDialogs = applyDialogGuard(
    openDialogsOn(facts.finalElements, facts.platform),
    Array.isArray(output.dialogs) ? output.dialogs : [],
    input.mask,
  )
  const evidence: ConditionVerdictsEvidence = {
    ending: input.ending,
    conditions,
    ...(openDialogs.length > 0 ? { openDialogs } : {}),
  }
  const pass =
    conditions.length > 0 &&
    conditions.every((condition) => condition.verdict === 'met') &&
    openDialogs.every((dialog) => dialog.account === 'unrelated' || dialog.account === 'requested')
  return { evidence, pass, reason: pass ? '' : formatUnprovenReason(conditions, openDialogs) }
}

function guardFacts(input: JudgeConditionsInput): ConditionGuardFacts {
  return (
    input.guards ?? { finalElements: [], platform: 'web', imageAttached: input.imageAttached }
  )
}

function entry(quote: string, reason: string): string {
  return reason.length > 0 ? `"${quote}" (${reason})` : `"${quote}"`
}

/**
 * The reason a non-passing step reads with: `Not met: …; Unverified: …; Inconclusive: …`,
 * each group in condition order and omitted when empty. The records arrive masked and bounded.
 */
export function formatUnprovenReason(
  conditions: readonly ConditionRecord[],
  openDialogs?: readonly OpenDialogAccount[],
): string {
  const notMet = conditions
    .filter((c) => c.verdict === 'not-met')
    .map((c) => entry(c.quote, c.reason))
  const unverified = conditions
    .filter((c) => c.verdict === 'unverified')
    .map((c) => entry(c.quote, c.reason))
  for (const dialog of openDialogs ?? []) {
    const named = dialog.name.length > 0 ? `open dialog "${dialog.name}"` : 'an unnamed open dialog'
    if (dialog.account === 'bears-on-condition') notMet.push(`${named} bears on a condition`)
    if (dialog.account === 'unaccounted') unverified.push(`${named} was not accounted for`)
  }
  const inconclusive = conditions
    .filter((c) => c.verdict === 'inconclusive')
    .map((c) => entry(c.quote, c.reason))
  const groups: string[] = []
  if (notMet.length > 0) groups.push(`Not met: ${notMet.join(', ')}`)
  if (unverified.length > 0) groups.push(`Unverified: ${unverified.join(', ')}`)
  if (inconclusive.length > 0) groups.push(`Inconclusive: ${inconclusive.join(', ')}`)
  return groups.join('; ')
}
